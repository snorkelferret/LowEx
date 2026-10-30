#!/usr/bin/env node
/**
 * Checks the DOWNLOAD ROUND TRIP — manifest, partial archive, single file,
 * the record of a read, and the import back into a workspace.
 *
 *   node scripts/check-download-round-trip.js    # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * It is the last of the three behavioural gaps TODO 90 named, and the only
 * route family a developer uses to GET their work back. Everything else tested
 * so far makes rows; this is the one that hands bytes out, and a bug here is
 * silent in the worst way — the zip downloads, unzips, and contains something
 * slightly different from what was approved.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   manifest   lists every file with its hash and size, and the version's
 *              manifest_hash RECOMPUTED FROM THE RESPONSE equals the value
 *              stored on the version — the two cannot disagree
 *   archive    a partial request returns exactly the files asked for, with the
 *              container folder stripped, CRCs that check out, and bytes whose
 *              SHA-256 is the one the manifest names
 *   hashes     the manifest inside the zip carries BOTH identities and they
 *              mean what they say:
 *                  manifest_hash  the whole version (same on every delivery)
 *                  archive_hash   what is in THIS zip (a subset differs)
 *   refusal    asking for nothing is a 400; a hash that is not a SHA-256 is a
 *              400; a SHA-256 that is not in the version is a 404
 *   single     GET .../files/:sha256 returns the exact bytes as
 *              application/octet-stream, never a stored mime type
 *   record     POST .../downloaded writes an audit row naming the version and
 *              what was written
 *   import     the version is copied back into the importing developer's
 *              workspace as FILE REFERENCES — same stored_file_id, no bytes —
 *              and the workspace asset records which store version it came
 *              from; importing twice says "already"
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * scripts/lib/check-harness.js. The store is seeded, not built through the
 * approval path — this check is about reading, and the write path has its own.
 * The ZIP is read by the little parser below, because the archive is written
 * with STORE entries (method 0) and a real reader is the only way to prove
 * what is inside rather than trusting Content-Length.
 */

const crypto = require('crypto');
const zlib = require('zlib');

const { Reporter, startCheckServer, Database } = require('./lib/check-harness');
const { manifestHash } = require('../backend/lib/manifestHash');

// ---------------------------------------------------------------------------
// A ZIP reader, for what this system writes
// ---------------------------------------------------------------------------

/**
 * Read a zip into [{ name, crc, data }], checking the CRC of every entry.
 *
 * Handles STORED (method 0, what this system writes) and DEFLATE (method 8),
 * so it does not fail the day somebody decides compressing is worth it. It
 * reads the CENTRAL DIRECTORY for the shapes, then each local header for where
 * the bytes start — a data descriptor after the bytes is therefore harmless.
 */
function readZip(buffer) {
    let eocd = -1;

    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }

    if (eocd < 0) throw new Error('no end-of-central-directory record — not a zip');

    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);

    const entries = [];

    for (let n = 0; n < count; n++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('central directory is not where it says it is');
        }

        const method = buffer.readUInt16LE(offset + 10);
        const crc = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);

        const name = buffer
            .slice(offset + 46, offset + 46 + nameLength)
            .toString('utf8');

        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`local header missing for ${name}`);
        }

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;

        const raw = buffer.slice(dataStart, dataStart + compressedSize);

        entries.push({
            name,
            method,
            crc,
            data: method === 0 ? raw : zlib.inflateRawSync(raw)
        });

        offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// ---------------------------------------------------------------------------

async function main() {
    const report = new Reporter();

    // Three files under one container folder, so the archive's stripping can
    // be observed. Each has distinct content, so a wrong file is a wrong hash.
    const files = [
        { relative_path: 'bigTree/textures', filename: 'bark.png',  body: 'BARK BYTES, NOT A REAL PNG' },
        { relative_path: 'bigTree/models',   filename: 'tree.blend', body: 'BLEND BYTES, NOT A REAL BLEND' },
        { relative_path: 'bigTree/notes',    filename: 'readme.txt', body: 'NOTES' }
    ].map(file => ({ ...file, sha256: sha256(Buffer.from(file.body)), size: Buffer.byteLength(file.body) }));

    // The version's content identity, computed the way the application does.
    const VERSION_HASH = manifestHash(files.map(f => ({
        relative_path: f.relative_path,
        filename: f.filename,
        sha256: f.sha256,
        size: f.size
    })));

    const server = await startCheckServer({
        prefix: 'lowex-roundtrip-',
        route: 'backend/routes/game',
        mount: '/api/game',

        seed(db, dirs) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'dev-check',  'dev@check.invalid',  'x', 'developer', 1),
                    (2, 'prod-check', 'prod@check.invalid', 'x', 'prod', 1);
            `);

            const insertFile = db.prepare(`
                INSERT INTO stored_files (id, sha256, storage_key, file_size)
                VALUES (?, ?, ?, ?)
            `);

            const insertReference = db.prepare(`
                INSERT INTO asset_version_files
                    (asset_version_id, stored_file_id, filename, relative_path)
                VALUES (1, ?, ?, ?)
            `);

            db.prepare(`INSERT INTO assets (id, name) VALUES (1, 'BigTree')`).run();

            db.prepare(`
                INSERT INTO asset_versions
                    (id, asset_id, version_number, created_by, version_note, manifest_hash)
                VALUES (1, 1, 1, 1, 'seed', ?)
            `).run(VERSION_HASH);

            files.forEach((file, index) => {
                insertFile.run(index + 1, file.sha256, file.sha256, file.size);
                insertReference.run(index + 1, file.filename, file.relative_path);

                require('fs').writeFileSync(
                    require('path').join(dirs.blobs, file.sha256),
                    file.body
                );
            });
        }
    });

    const db = new Database(server.dbPath, { readonly: true });
    const dev = server.tokenFor(1);
    const prod = server.tokenFor(2);

    const [A, B] = files;

    // A hash that is a real SHA-256 and is not in the version.
    const MISSING = sha256(Buffer.from('not in this version'));

    // -----------------------------------------------------------------
    // MANIFEST
    // -----------------------------------------------------------------

    const manifest = await server.get('/1/versions/1/manifest', dev);

    report.check('the manifest is served', manifest.status === 200,
        `expected 200, got ${manifest.status} — ${manifest.text.slice(0, 120)}`);

    report.check('it lists every file', manifest.json?.files?.length === files.length,
        `expected ${files.length} files, got ${manifest.json?.files?.length}`);

    report.check('it carries the version identity',
        manifest.json?.manifest_hash === VERSION_HASH,
        `manifest_hash was ${manifest.json?.manifest_hash}`);

    report.check('and a whole-version archive hash equal to it',
        manifest.json?.archive_hash === VERSION_HASH,
        'archive_hash differs from manifest_hash when the manifest names the whole version');

    const recomputed = manifestHash((manifest.json?.files || []).map(file => ({
        relative_path: file.relative_path,
        filename: file.filename,
        sha256: file.sha256,
        size: file.size
    })));

    report.check('the manifest CANNOT disagree with the version it names',
        recomputed === VERSION_HASH,
        'hashing the manifest response produced a different value from the one stored on the version');

    // -----------------------------------------------------------------
    // ARCHIVE — a subset
    // -----------------------------------------------------------------

    const partial = await server.post('/1/versions/1/archive', { only: [B.sha256] }, dev);

    report.check('a partial archive is a zip', partial.status === 200
        && /application\/zip/.test(partial.headers.get('content-type') || ''),
        `expected 200 application/zip, got ${partial.status} ${partial.headers.get('content-type')}`);

    let entries = [];

    try {
        entries = readZip(partial.body);
    } catch (err) {
        report.check('the zip can be read', false, err.message);
    }

    const payload = entries.filter(entry => entry.name !== 'manifest.json');
    const manifestEntry = entries.find(entry => entry.name === 'manifest.json');

    report.check('it holds the one file asked for', payload.length === 1,
        `found ${payload.length} file entries: ${payload.map(e => e.name).join(', ')}`);

    report.check('it carries a manifest', !!manifestEntry);

    const stripped = payload[0];

    report.check('the container folder is stripped from the entry',
        stripped?.name === 'models/tree.blend',
        `entry was named ${stripped?.name}`);

    report.check('the entry bytes are the stored bytes',
        stripped?.data?.equals(Buffer.from(B.body)),
        'the bytes in the zip are not the bytes in the store');

    report.check('and hash to the name the manifest gives them',
        stripped ? sha256(stripped.data) === B.sha256 : false);

    report.check('every CRC checks out',
        entries.every(entry => zlib.crc32(entry.data) === entry.crc),
        'an entry failed its own CRC');

    if (manifestEntry) {
        const inside = JSON.parse(manifestEntry.data.toString('utf8'));

        report.check('the zip manifest names the WHOLE version',
            inside.manifest_hash === VERSION_HASH,
            `manifest_hash inside the zip was ${inside.manifest_hash}`);

        report.check('and names the DELIVERY separately',
            inside.archive_hash === manifestHash([{
                relative_path: B.relative_path,
                filename: B.filename,
                sha256: B.sha256,
                size: B.size
            }]),
            `archive_hash inside the zip was ${inside.archive_hash}`);
    }

    // -----------------------------------------------------------------
    // ARCHIVE — the refusals
    // -----------------------------------------------------------------

    const empty = await server.post('/1/versions/1/archive', { only: [] }, dev);
    report.check('asking for nothing is a 400', empty.status === 400,
        `expected 400, got ${empty.status}`);

    const noList = await server.post('/1/versions/1/archive', {}, dev);
    report.check('omitting the list is a 400', noList.status === 400,
        `expected 400, got ${noList.status}`);

    const notHashes = await server.post('/1/versions/1/archive', { only: ['nope'] }, dev);
    report.check('a list of non-hashes is a 400', notHashes.status === 400,
        `expected 400, got ${notHashes.status}`);

    const absent = await server.post('/1/versions/1/archive', { only: [MISSING] }, dev);
    report.check('a hash that is not in the version is a 404', absent.status === 404,
        `expected 404, got ${absent.status}`);

    // A STALE LIST STILL DOWNLOADS, AND SAYS WHAT IT LEFT OUT. Without this
    // the caller gets a subset and nothing in the response says so.
    const mixed = await server.post('/1/versions/1/archive',
        { only: [A.sha256, MISSING] }, dev);

    report.check('a known hash alongside an unknown one still downloads',
        mixed.status === 200, `expected 200, got ${mixed.status}`);

    let mixedManifest = null;

    try {
        const mixedEntries = readZip(mixed.body);
        const entry = mixedEntries.find(e => e.name === 'manifest.json');
        if (entry) mixedManifest = JSON.parse(entry.data.toString('utf8'));
    } catch { /* reported below */ }

    report.check('and the manifest reports the hash it could not include',
        Array.isArray(mixedManifest?.unknown) && mixedManifest.unknown.length === 1
        && mixedManifest.unknown[0] === MISSING,
        `manifest.unknown was ${JSON.stringify(mixedManifest?.unknown)}`);

    // -----------------------------------------------------------------
    // ONE FILE
    // -----------------------------------------------------------------

    const single = await server.get(`/1/versions/1/files/${A.sha256}`, dev);

    report.check('a single file is served', single.status === 200,
        `expected 200, got ${single.status}`);

    report.check('as octet-stream, never a stored mime type',
        /application\/octet-stream/.test(single.headers.get('content-type') || ''),
        `content-type was ${single.headers.get('content-type')}`);

    report.check('with exactly the stored bytes', single.body.equals(Buffer.from(A.body)));

    // -----------------------------------------------------------------
    // THE RECORD OF A READ
    // -----------------------------------------------------------------

    const recorded = await server.post('/1/versions/1/downloaded',
        { files_written: 2, files_unchanged: 1, target_folder: 'BigTree' }, dev);

    report.check('a download is recorded', recorded.status === 201,
        `expected 201, got ${recorded.status} — ${recorded.text.slice(0, 120)}`);

    const downloadAudit = db.prepare(
        "SELECT * FROM audit_logs WHERE action = 'store.download' ORDER BY id DESC LIMIT 1"
    ).get();

    report.check('and the record names the version and the developer',
        downloadAudit?.actor_id === 1
        && JSON.parse(downloadAudit.details).repository_version_id === 1
        && JSON.parse(downloadAudit.details).files_written === 2,
        `audit row: ${JSON.stringify(downloadAudit)}`);

    // -----------------------------------------------------------------
    // THE RETURN — import back into a workspace
    // -----------------------------------------------------------------

    const imported = await server.post('/1/versions/1/import', {}, dev);

    report.check('the version imports into a workspace', imported.status === 201,
        `expected 201, got ${imported.status} — ${imported.text.slice(0, 160)}`);

    report.check('it is reported as an import', imported.json?.status === 'imported',
        `status was ${imported.json?.status}`);

    const workspaceAsset = db.prepare(`
        SELECT * FROM workspace_assets WHERE id = ?
    `).get(imported.json?.workspace_asset_id);

    report.check('the workspace asset records where it came from',
        workspaceAsset?.repository_asset_id === 1
        && workspaceAsset?.repository_base_version_id === 1,
        `workspace asset: ${JSON.stringify(workspaceAsset)}`);

    const importedFiles = db.prepare(`
        SELECT * FROM workspace_version_files WHERE workspace_version_id = ?
    `).all(imported.json?.workspace_version_id);

    const importedVersion = db.prepare(`
        SELECT * FROM workspace_versions WHERE id = ?
    `).get(imported.json?.workspace_version_id);

    report.check('the imported version carries the store version\'s identity',
        importedVersion?.manifest_hash === VERSION_HASH,
        `imported manifest_hash was ${importedVersion?.manifest_hash}, expected ${VERSION_HASH} — an imported version used to have none at all`);

    report.check('and its files are REFERENCES to the same stored rows',
        importedFiles.length === files.length
        && importedFiles.every(row => files.some(f => f.sha256 === (
            db.prepare('SELECT sha256 FROM stored_files WHERE id = ?').get(row.stored_file_id)?.sha256
        ))),
        `imported ${importedFiles.length} file references`);

    const again = await server.post('/1/versions/1/import', {}, dev);

    report.check('importing twice says it is already there',
        again.status === 200 && again.json?.status === 'already',
        `expected 200 already, got ${again.status} ${again.json?.status}`);

    // -----------------------------------------------------------------
    // PRODUCTION MAY READ (item 83), BUT NOT IMPORT
    // -----------------------------------------------------------------

    const prodManifest = await server.get('/1/versions/1/manifest', prod);

    report.check('production can read the store', prodManifest.status === 200,
        `expected 200, got ${prodManifest.status} — ${prodManifest.text.slice(0, 120)}`);

    const prodImport = await server.post('/1/versions/1/import', {}, prod);

    report.check('but production cannot import into a workspace',
        prodImport.status === 403,
        `expected 403, got ${prodImport.status}`);

    // -----------------------------------------------------------------

    db.close();
    await server.close();

    report.finish('a version downloads exactly as approved, and comes back as references');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
