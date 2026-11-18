#!/usr/bin/env node
/**
 * Checks the UPLOAD PATH over HTTP.
 *
 *   node tests/check-upload.js      # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * Uploading is where every asset starts, and it is the one write path with the
 * most rules layered into it: the name comes from the folder, backups are
 * dropped rather than refused, identical content makes no version unless the
 * developer insists, and the bytes are stored once by hash.
 *
 * The suite had checks for what happens AFTER an upload — the technical check,
 * the submission, the approval — and for the name RULES as a module. It had
 * none for the route that joins them, so a break in the mapping from the
 * developer's paths to the stored version would have been found by a person.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   name       a folder path derives the asset name           200
 *              loose files have no name to derive              "no_name"
 *
 *   upload     files arrive and become one version             201
 *              the asset is named from the folder, not typed
 *              the version's files keep their relative paths
 *              the bytes are in the store, addressed by sha
 *              the upload is audited
 *
 *   identical  the same components again                      409, nothing_changed
 *              and the refusal is audited
 *              insisting (force_new_version=1)               201, a new version
 *
 *   refusals   no files                                        400
 *              only backup files                              400, said plainly
 *              production cannot upload                       403
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Reporter, startCheckServer, Database } = require('./lib/check-harness');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function fileForm({ paths, contents, extra = {} }) {
    const form = new FormData();

    paths.forEach((logical, index) => {
        form.append(
            'files',
            new Blob([contents[index]], { type: 'application/octet-stream' }),
            path.posix.basename(logical)
        );
    });

    form.append('file_paths', JSON.stringify(paths));
    form.append('version_note', extra.version_note || 'first');
    form.append('description', extra.description || '');
    if (extra.category) form.append('category', extra.category);
    if (extra.force) form.append('force_new_version', '1');

    return form;
}

async function main() {
    const report = new Reporter();

    const server = await startCheckServer({
        prefix: 'lowex-upload-',
        route: 'backend/routes/developerWorkspace',
        mount: '/api/developer/workspace',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'dev-check',  'dev@check.invalid',  'x', 'developer', 1),
                    (2, 'prod-check', 'prod@check.invalid', 'x', 'prod',      1);

                INSERT INTO developer_workspaces (id, developer_id)
                VALUES (1, 1);
            `);
        }
    });

    const dev = server.tokenFor(1);
    const prod = server.tokenFor(2);

    const db = new Database(server.dbPath, { readonly: true });

    // -----------------------------------------------------------------
    // NAME DERIVATION
    // -----------------------------------------------------------------

    const named = await server.post('/assets/check-name', {
        file_paths: [
            'OakTree_v01/models/tree.blend',
            'OakTree_v01/textures/bark.png'
        ]
    }, dev);

    report.check('a folder path derives an asset name',
        named.status === 200 && named.json?.asset_name === 'OakTree',
        `expected OakTree, got ${named.status} — ${named.text.slice(0, 200)}`);

    const loose = await server.post('/assets/check-name', {
        file_paths: ['bark.png']
    }, dev);

    report.check('loose files have no name to derive',
        loose.status === 200 && loose.json?.code === 'no_name',
        `expected no_name, got ${loose.text.slice(0, 200)}`);

    // -----------------------------------------------------------------
    // UPLOAD
    // -----------------------------------------------------------------

    const tree = 'FBX-or-blend placeholder for the oak tree';
    const bark = 'PNG placeholder for the bark texture';

    const uploaded = await server.postForm('/upload', fileForm({
        paths: [
            'OakTree_v01/models/tree.blend',
            'OakTree_v01/textures/bark.png'
        ],
        contents: [tree, bark],
        extra: { version_note: 'first pass', description: 'an oak', category: 'Environment' }
    }), dev);

    report.check('an upload creates a version', uploaded.status === 201,
        `expected 201, got ${uploaded.status} — ${uploaded.text.slice(0, 240)}`);

    report.check('named from the folder, not typed',
        uploaded.json?.asset?.name === 'OakTree',
        `asset: ${JSON.stringify(uploaded.json?.asset)}`);

    report.check('as the first version', uploaded.json?.version?.version_number === 1,
        `version: ${JSON.stringify(uploaded.json?.version)}`);

    const files = uploaded.json?.files || [];

    report.check('with both files', files.length === 2,
        `files: ${JSON.stringify(files)}`);

    report.check('and their relative paths kept',
        files.some(f => f.relative_path === 'OakTree_v01/models' && f.filename === 'tree.blend')
        && files.some(f => f.relative_path === 'OakTree_v01/textures' && f.filename === 'bark.png'),
        `files: ${JSON.stringify(files)}`);

    const stored = db.prepare('SELECT sha256 FROM stored_files ORDER BY sha256').all()
        .map(row => row.sha256);

    report.check('the bytes are stored once, by hash',
        stored.length === 2
        && stored.includes(sha(tree))
        && stored.includes(sha(bark)),
        `stored: ${JSON.stringify(stored)}`);

    for (const hash of stored) {
        const exists = fs.existsSync(path.join(server.dirs.blobs, hash));
        report.check(`the blob for ${hash.slice(0, 8)} is on disk`, exists,
            `missing at ${path.join(server.dirs.blobs, hash)}`);
    }

    const uploadAudit = db.prepare(`
        SELECT * FROM audit_logs WHERE action = 'workspace.upload'
        ORDER BY id DESC LIMIT 1
    `).get();

    report.check('and the upload is audited', Boolean(uploadAudit),
        'no workspace.upload row was written');

    // -----------------------------------------------------------------
    // IDENTICAL COMPONENTS
    // -----------------------------------------------------------------

    const identical = await server.postForm('/upload', fileForm({
        paths: [
            'OakTree_v01/models/tree.blend',
            'OakTree_v01/textures/bark.png'
        ],
        contents: [tree, bark],
        extra: { version_note: 'again' }
    }), dev);

    report.check('the same components make no second version',
        identical.status === 409 && identical.json?.nothing_changed === true,
        `expected 409 nothing_changed, got ${identical.status} — ${identical.text.slice(0, 200)}`);

    const refusedAudit = db.prepare(`
        SELECT * FROM audit_logs WHERE action = 'workspace.upload_refused'
        ORDER BY id DESC LIMIT 1
    `).get();

    report.check('and the refusal is recorded rather than lost',
        Boolean(refusedAudit),
        'no workspace.upload_refused row was written');

    const insisted = await server.postForm('/upload', fileForm({
        paths: [
            'OakTree_v01/models/tree.blend',
            'OakTree_v01/textures/bark.png'
        ],
        contents: [tree, bark],
        extra: { version_note: 'insisted', force: true }
    }), dev);

    report.check('insisting creates the version anyway',
        insisted.status === 201 && insisted.json?.version?.version_number === 2,
        `expected 201 v2, got ${insisted.status} — ${insisted.text.slice(0, 200)}`);

    // -----------------------------------------------------------------
    // REFUSALS
    // -----------------------------------------------------------------

    const empty = new FormData();
    empty.append('version_note', 'nothing');

    const noFiles = await server.postForm('/upload', empty, dev);

    report.check('an upload with no files is refused', noFiles.status === 400,
        `expected 400, got ${noFiles.status}`);

    const backups = await server.postForm('/upload', fileForm({
        paths: ['OakTree_v01/models/tree.blend~'],
        contents: ['a backup'],
        extra: { version_note: 'backup only' }
    }), dev);

    report.check('an upload of backups alone is refused, and says so',
        backups.status === 400 && /backup/i.test(backups.text),
        `expected a 400 mentioning backups, got ${backups.status} — ${backups.text.slice(0, 200)}`);

    const prodUpload = await server.postForm('/upload', fileForm({
        paths: ['OakTree_v01/models/other.blend'],
        contents: ['not theirs'],
        extra: { version_note: 'no' }
    }), prod);

    report.check('production cannot upload', prodUpload.status === 403,
        `expected 403, got ${prodUpload.status}`);

    await server.close();
    report.finish('uploads derive the name, store the bytes once, and refuse an unchanged version.');
}

main().catch(err => {
    console.error('\n  FAIL — the check could not run:', err.message, '\n');
    process.exit(1);
});
