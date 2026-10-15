// backend/routes/game.js
//
// THE GAME STORE, READ — the consumption side.
//
// ============================================================
// WHAT THIS IS
// ============================================================
//
// Everything else in the portal PRODUCES: upload, check, submit, approve, store.
// This is the first thing that lets anybody CONSUME it — find what is in the
// store, take a copy, and put it in a workspace to work on.
//
// Until this existed, the only way to know what was in the game store was to
// read the database. The first asset ever approved arrived somewhere nobody
// could look at it (TODO 80b).
//
// ============================================================
// THE THIRD ACCESS CLASS
// ============================================================
//
// There are now three, and they are genuinely different:
//
//   * A WORKSPACE is the owning developer's alone. Nobody else, not admins.
//   * THE LIBRARY is studio material, readable by developers (item 57).
//   * THE GAME STORE is APPROVED content and readable by ANY authenticated
//     developer — which is the point of it. The library is where you look for
//     material; the store is where you find what the studio has already judged
//     good enough for the game, including work somebody else did.
//
// WHICH IS A DECISION, NOT AN ACCIDENT. Item 25 says store content is readable
// by any authenticated developer, and it is what makes the store a studio
// resource rather than everybody's personal filing cabinet.
//
// ============================================================
// AND THE DOWNLOAD IS THE SPEC'S OWN FIRST STEP
// ============================================================
//
// docs/assettypes01 §5B, "DOWNLOAD TO LOCAL WORKING COPY", marked SMALL and
// HIGHEST VALUE, LOWEST RISK:
//
//   "ZIP preserving relative_path plus a JSON manifest: per-file SHA-256, size,
//    and target path."
//
// THE HASH NEGOTIATION IS NOT HERE, deliberately. The spec defers it to "a small
// CLI later" — so the first step is a download that WORKS and says exactly what
// it contains, and the sync that only fetches what you lack comes after there is
// something to sync.

const express = require('express');
const fs = require('fs');

const db = require('../db');
const audit = require('../lib/audit');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { blobPath } = require('../lib/storagePaths');
const { buildVersionArchive } = require('../lib/assetArchive');

const router = express.Router();

// ============================================================
// Statements
// ============================================================

// THE ASSET, WITH ITS CURRENT VERSION.
//
// "Current" is the RECOMMENDED version if one is set, and the latest otherwise.
// asset_recommended_versions exists for exactly this (item 78 restored it) and
// NOTHING WRITES IT YET — so today this always falls through to the latest, and
// the moment somebody can recommend a version, this starts honouring it.
const listAssets = db.prepare(`
    SELECT
        a.id,
        a.name,
        a.asset_type,
        a.category,
        a.description,
        a.created_at,

        arv.version_id AS recommended_version_id,

        (SELECT COUNT(*)
           FROM asset_versions av
          WHERE av.asset_id = a.id) AS version_count,

        (SELECT MAX(av.version_number)
           FROM asset_versions av
          WHERE av.asset_id = a.id) AS latest_version_number

    FROM assets a
    LEFT JOIN asset_recommended_versions arv ON arv.asset_id = a.id
    WHERE a.is_active = 1
    ORDER BY a.name COLLATE NOCASE
`);

const oneAsset = db.prepare(`
    SELECT id, name, asset_type, category, description, created_at
    FROM assets
    WHERE id = ? AND is_active = 1
`);

const versionsOf = db.prepare(`
    SELECT
        av.id,
        av.version_number,
        av.version_note,
        av.created_at,
        u.username AS created_by_username,
        (SELECT COUNT(*) FROM asset_version_files f WHERE f.asset_version_id = av.id) AS file_count,
        (SELECT COALESCE(SUM(sf.file_size), 0)
           FROM asset_version_files f
           JOIN stored_files sf ON sf.id = f.stored_file_id
          WHERE f.asset_version_id = av.id) AS total_bytes
    FROM asset_versions av
    LEFT JOIN users u ON u.id = av.created_by
    WHERE av.asset_id = ?
    ORDER BY av.version_number DESC
`);

const versionForDownload = db.prepare(`
    SELECT av.id, av.version_number
    FROM asset_versions av
    WHERE av.id = ? AND av.asset_id = ?
`);

const filesOf = db.prepare(`
    SELECT
        f.filename,
        f.relative_path,
        sf.sha256,
        sf.file_size,
        sf.storage_key
    FROM asset_version_files f
    JOIN stored_files sf ON sf.id = f.stored_file_id
    WHERE f.asset_version_id = ?
    ORDER BY f.relative_path, f.filename
`);

// ONE FILE, BY HASH, WITHIN A VERSION — the access check and the lookup in one.
const fileInVersion = db.prepare(`
    SELECT
        f.filename,
        f.relative_path,
        sf.sha256,
        sf.file_size,
        sf.storage_key
    FROM asset_version_files f
    JOIN stored_files sf ON sf.id = f.stored_file_id
    WHERE f.asset_version_id = ?
      AND sf.sha256 = ?
`);

const workspaceOf = db.prepare(`
    SELECT id FROM developer_workspaces WHERE developer_id = ?
`);

const createWorkspace = db.prepare(`
    INSERT INTO developer_workspaces (developer_id) VALUES (?)
`);

// ANY ROW WITH THAT NAME, ACTIVE OR NOT.
//
// THE UNIQUE CONSTRAINT IS ON (workspace_id, name) AND DOES NOT CARE ABOUT
// is_active — SO A SOFT-DELETED ASSET STILL HOLDS ITS NAME. A lookup that
// filtered the deleted rows out MISSED THE ROW IT WAS ABOUT TO COLLIDE WITH,
// which is exactly what happened: "UNIQUE constraint failed" with no visible row
// to explain it.
const workspaceAssetByName = db.prepare(`
    SELECT id, name, repository_asset_id, is_active
    FROM workspace_assets
    WHERE workspace_id = ? AND name = ?
`);

const restoreWorkspaceAsset = db.prepare(`
    UPDATE workspace_assets
    SET is_active = 1, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const restoreWorkspaceVersions = db.prepare(`
    UPDATE workspace_versions
    SET is_active = 1, deleted_at = NULL
    WHERE workspace_asset_id = ?
`);

const insertWorkspaceAsset = db.prepare(`
    INSERT INTO workspace_assets (
        workspace_id, name, asset_type, category, description,
        repository_asset_id, repository_base_version_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const latestWorkspaceVersion = db.prepare(`
    SELECT MAX(version_number) AS n FROM workspace_versions WHERE workspace_asset_id = ?
`);

const insertWorkspaceVersion = db.prepare(`
    INSERT INTO workspace_versions (
        workspace_asset_id, version_number, created_by, version_note
    )
    VALUES (?, ?, ?, ?)
`);

const insertWorkspaceVersionFile = db.prepare(`
    INSERT INTO workspace_version_files (
        workspace_version_id, stored_file_id, filename, relative_path
    )
    SELECT ?, f.stored_file_id, f.filename, f.relative_path
    FROM asset_version_files f
    WHERE f.asset_version_id = ?
`);

// ============================================================
// GET /api/game
// ============================================================
//
// What is in the game store, searchable.
//
// SEARCH IS OVER THE NAME, THE CATEGORY AND THE DESCRIPTION — everything a
// person could reasonably remember about an asset. It is deliberately NOT over
// the file names inside it: those describe the FILES, and somebody looking for
// "the big tree" is not helped by knowing it contains "bigTree_LOD2.fbx".
// ============================================================

router.get(
    '/',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        try {
            const query = String(req.query.q || '').trim().toLowerCase();

            const rows = listAssets.all().map(row => {
                // The version a developer would get. Recommended if set.
                const current = row.recommended_version_id
                    ? versionsOf.all(row.id).find(v => v.id === row.recommended_version_id)
                    : null;

                return { ...row, current_version: current || null };
            });

            const filtered = query
                ? rows.filter(row => [
                    row.name,
                    row.category,
                    row.description,
                    row.asset_type
                ].filter(Boolean).join(' ').toLowerCase().includes(query))
                : rows;

            // The latest version's size, which is the number a person wants
            // when deciding whether to download something.
            const withTotals = filtered.map(row => {
                const versions = versionsOf.all(row.id);
                const latest = versions.find(v => v.version_number === row.latest_version_number);

                return {
                    ...row,
                    file_count: latest?.file_count ?? 0,
                    total_bytes: latest?.total_bytes ?? 0
                };
            });

            return res.json({
                assets: withTotals,
                total: rows.length,
                showing: withTotals.length
            });

        } catch (err) {
            console.error('Could not list the game store:', err);

            return res.status(500).json({
                error: 'Could not list the game store'
            });
        }
    }
);

// ============================================================
// GET /api/game/:assetId
// ============================================================
//
// One asset and every version of it.
// ============================================================

router.get(
    '/:assetId',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const assetId = Number(req.params.assetId);

        if (!Number.isInteger(assetId)) {
            return res.status(400).json({ error: 'Invalid asset ID' });
        }

        try {
            const asset = oneAsset.get(assetId);

            if (!asset) {
                return res.status(404).json({ error: 'Asset not found in the game store' });
            }

            return res.json({
                asset,
                versions: versionsOf.all(assetId)
            });

        } catch (err) {
            console.error('Could not read a game-store asset:', err);

            return res.status(500).json({
                error: 'Could not read that asset'
            });
        }
    }
);

// ============================================================
// GET /api/game/:assetId/versions/:versionId/download
// ============================================================
//
// THE ZIP, WITH ITS MANIFEST.
//
// A file whose path cannot be made safe is REFUSED rather than silently
// dropped — but the archive is still built from the rest, because one bad path
// in a version is not a reason to refuse the whole download. The manifest lists
// what was left out and why, so what arrives can be checked rather than trusted.
// ============================================================

router.get(
    '/:assetId/versions/:versionId/download',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        try {
            const asset = oneAsset.get(assetId);
            const version = versionForDownload.get(versionId, assetId);

            if (!asset || !version) {
                return res.status(404).json({
                    error: 'That version is not in the game store'
                });
            }

            const rows = filesOf.all(versionId);

            const files = rows.map(row => ({
                absolutePath: blobPath(row.storage_key),
                relative_path: row.relative_path,
                filename: row.filename,
                sha256: row.sha256,
                file_size: row.file_size
            }));

            // A row whose storage_key will not make a path is a CORRUPT STORE
            // rather than a bad request — blobPath returns null only for a key
            // that is not a plain SHA-256.
            const corrupt = files.filter(f => !f.absolutePath);

            if (corrupt.length > 0) {
                console.error(
                    `Game-store download refused: ${corrupt.length} file(s) in version ${versionId} have a malformed storage_key`
                );

                return res.status(500).json({
                    error: 'The store could not be read for this version. See check:store.'
                });
            }

            const { stream, manifest, refused } = buildVersionArchive(files, {
                assetName: asset.name,
                versionNumber: version.version_number
            });

            if (refused.length > 0) {
                console.warn(
                    `Game-store download: ${refused.length} file(s) in version ${versionId} refused a safe path`
                );
            }

            // Everything is settled before a byte is sent — see assetArchive.js
            // for why the refusal is known up front rather than mid-stream.
            const safeName = String(asset.name).replace(/[^A-Za-z0-9._-]+/g, '_');

            res.type('application/zip');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${safeName}_v${version.version_number}.zip"`
            );

            stream.on('error', (err) => {
                console.error('The archive stream failed:', err);
                res.destroy(err);
            });

            return stream.pipe(res);

        } catch (err) {
            console.error('Could not build a game-store download:', err);

            if (!res.headersSent) {
                return res.status(500).json({
                    error: 'Could not build that download'
                });
            }

            return res.destroy(err);
        }
    }
);

// ============================================================
// GET /api/game/:assetId/versions/:versionId/manifest
// ============================================================
//
// WHAT IS IN A VERSION, WITHOUT FETCHING ANY OF IT.
//
// THIS IS THE WHOLE NEGOTIATION PROTOCOL, and it is one endpoint. Every file
// carries its SHA-256, so a client that has hashed its own folder can work out
// for itself what it is missing, what differs, and what it already has —
// CONTENT ADDRESSING MEANS THE MANIFEST IS SUFFICIENT. There is no `have`/`want`
// endpoint because none is needed: the answer is arithmetic the client can do.
//
// WHICH ALSO MEANS THE SERVER LEARNS NOTHING ABOUT THE DEVELOPER'S DISK. It is
// asked what a version contains, and nothing else.
// ============================================================

router.get(
    '/:assetId/versions/:versionId/manifest',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        try {
            const asset = oneAsset.get(assetId);
            const version = versionForDownload.get(versionId, assetId);

            if (!asset || !version) {
                return res.status(404).json({
                    error: 'That version is not in the game store'
                });
            }

            const rows = filesOf.all(versionId);

            const files = rows.map(row => ({
                absolutePath: blobPath(row.storage_key),
                relative_path: row.relative_path,
                filename: row.filename,
                sha256: row.sha256,
                file_size: row.file_size
            }));

            const corrupt = files.filter(f => !f.absolutePath);

            if (corrupt.length > 0) {
                console.error(
                    `Manifest refused: ${corrupt.length} file(s) in version ${versionId} have a malformed storage_key`
                );

                return res.status(500).json({
                    error: 'The store could not be read for this version. See check:store.'
                });
            }

            // The same builder the archive uses, so the manifest a negotiator
            // reads and the manifest inside the zip CANNOT disagree — they are
            // one function.
            const { manifest, refused } = buildVersionArchive(files, {
                assetName: asset.name,
                versionNumber: version.version_number
            });

            return res.json({
                asset: { id: asset.id, name: asset.name },
                version: {
                    id: version.id,
                    version_number: version.version_number
                },
                ...manifest,
                refused
            });

        } catch (err) {
            console.error('Could not build a manifest:', err);

            return res.status(500).json({
                error: 'Could not read that version'
            });
        }
    }
);

// ============================================================
// POST /api/game/:assetId/versions/:versionId/archive
// ============================================================
//
// ONLY THE FILES ASKED FOR, as a zip. What a negotiating client downloads.
//
// ============================================================
// WHY THIS IS A POST AND NOT A QUERY STRING
// ============================================================
//
// The list is a set of SHA-256s — sixty-four characters each — and a version can
// hold hundreds. Four hundred of them is twenty-seven kilobytes of URL, which no
// server accepts and no proxy passes. IT IS A BODY, SO IT IS A POST.
//
// ============================================================
// AND WHY IT FILTERS RATHER THAN TRUSTING
// ============================================================
//
// The caller says which hashes it wants, and EVERY ONE IS CHECKED AGAINST THIS
// VERSION. A client cannot ask for a file that is not in the version it named —
// which is the same access rule as the single-file route, for the same reason:
// stored_files holds everything, including content in somebody's private
// workspace, and the hash is the content rather than the permission.
//
// Unknown hashes are IGNORED rather than refused. A client working from a
// manifest it fetched a moment ago may be slightly out of date, and refusing the
// whole download over one stale hash would be a worse answer than sending the
// rest — but it is reported back so nothing is silently missing.
// ============================================================

router.post(
    '/:assetId/versions/:versionId/archive',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        const requested = Array.isArray(req.body?.only) ? req.body.only : null;

        if (!requested) {
            return res.status(400).json({
                error: 'Send { only: [sha256, ...] } — the files to include.'
            });
        }

        const wanted = new Set(
            requested
                .map(v => String(v || '').toLowerCase())
                .filter(v => /^[0-9a-f]{64}$/.test(v))
        );

        try {
            const asset = oneAsset.get(assetId);
            const version = versionForDownload.get(versionId, assetId);

            if (!asset || !version) {
                return res.status(404).json({
                    error: 'That version is not in the game store'
                });
            }

            // EVERY ROW OF THE VERSION, then filtered — so the filter is against
            // what the version actually holds and never against what the caller
            // asked for.
            const rows = filesOf.all(versionId);

            const files = rows
                .filter(row => wanted.has(String(row.sha256).toLowerCase()))
                .map(row => ({
                    absolutePath: blobPath(row.storage_key),
                    relative_path: row.relative_path,
                    filename: row.filename,
                    sha256: row.sha256,
                    file_size: row.file_size
                }));

            const corrupt = files.filter(f => !f.absolutePath);

            if (corrupt.length > 0) {
                console.error(
                    `Archive refused: ${corrupt.length} file(s) in version ${versionId} have a malformed storage_key`
                );

                return res.status(500).json({
                    error: 'The store could not be read for this version. See check:store.'
                });
            }

            const known = new Set(rows.map(r => String(r.sha256).toLowerCase()));
            const unknown = [...wanted].filter(h => !known.has(h));

            if (unknown.length > 0) {
                // Reported, not refused — see the note above. A client that has
                // gone stale still gets everything it can.
                console.warn(
                    `Archive for version ${versionId}: ${unknown.length} requested hash(es) are not in it`
                );
            }

            // ASKING FOR NOTHING IS A MALFORMED REQUEST, NOT A MISSING ONE.
            // This reached 404 with the message below, which was untrue twice
            // over: what was asked for was an empty set, so there is no version
            // the files could have failed to be in. Either the list arrived
            // empty or nothing in it was a SHA-256, and both are the caller's
            // mistake to fix rather than a resource to go looking for.
            if (wanted.size === 0) {
                return res.status(400).json({
                    error: 'None of those are SHA-256 hashes — send at least one.'
                });
            }

            if (files.length === 0) {
                return res.status(404).json({
                    error: 'None of those files are in this version',
                    unknown: unknown.length
                });
            }

            // THE CONTAINER FOLDER COMES OFF, because the caller has just told
            // us which folder these files belong in — see the note in
            // assetArchive.js. The entries are relative to that folder, so
            // "unzip here" is the whole instruction.
            const allNames = rows.map(r => [r.relative_path, r.filename]
                .filter(Boolean).map(String).join('/'));

            const roots = new Set(
                allNames.filter(n => n.includes('/')).map(n => n.split('/')[0])
            );

            const stripRoot = roots.size === 1 ? [...roots][0] : null;

            const { stream, manifest } = buildVersionArchive(files, {
                assetName: asset.name,
                versionNumber: version.version_number,
                stripRoot
            });

            const safeName = String(asset.name).replace(/[^A-Za-z0-9._-]+/g, '_');

            // THE COUNT IS IN THE FILENAME, because "which zip is this" matters
            // when a developer has several in their downloads folder.
            res.type('application/zip');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${safeName}_v${version.version_number}_${files.length}of${rows.length}.zip"`
            );

            stream.on('error', (err) => {
                console.error('The partial archive stream failed:', err);
                res.destroy(err);
            });

            return stream.pipe(res);

        } catch (err) {
            console.error('Could not build a partial archive:', err);

            if (!res.headersSent) {
                return res.status(500).json({
                    error: 'Could not build that download'
                });
            }

            return res.destroy(err);
        }
    }
);

// ============================================================
// GET /api/game/:assetId/versions/:versionId/files/:sha256
// ============================================================
//
// ONE FILE, BY ITS HASH. What a negotiating client fetches for the files it
// does not have.
//
// ============================================================
// AND WHY IT IS SCOPED TO A VERSION RATHER THAN BEING /blobs/:sha256
// ============================================================
//
// stored_files HOLDS EVERYTHING — including content in somebody's PRIVATE
// WORKSPACE. A route that served a blob by hash alone would hand any
// authenticated developer any file in the system, given a hash they could
// obtain from... anywhere it appeared. THE HASH IS THE CONTENT, NOT THE
// PERMISSION.
//
// SO THE CALLER HAS TO NAME A VERSION THEY MAY SEE, AND THE FILE HAS TO BE IN
// IT. That is the access check, and it is the only one needed: if you can read
// the version you can have its files, and nothing else.
// ============================================================

router.get(
    '/:assetId/versions/:versionId/files/:sha256',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);
        const sha256 = String(req.params.sha256 || '').toLowerCase();

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        // A SHA-256 and nothing else. Anything that is not one could not be in
        // the store, so it is a bad request rather than a miss.
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            return res.status(400).json({ error: 'Not a SHA-256' });
        }

        try {
            const version = versionForDownload.get(versionId, assetId);

            if (!version) {
                return res.status(404).json({
                    error: 'That version is not in the game store'
                });
            }

            const row = fileInVersion.get(versionId, sha256);

            if (!row) {
                return res.status(404).json({
                    error: 'That file is not in this version'
                });
            }

            const absolutePath = blobPath(row.storage_key);

            if (!absolutePath || !fs.existsSync(absolutePath)) {
                return res.status(404).json({
                    error: 'The stored file is missing from the store'
                });
            }

            // application/octet-stream, NEVER the stored mime_type — the same
            // decision every other content route makes, and for the same reason:
            // a browser that trusts a claimed type is how a file becomes a
            // script.
            res.type('application/octet-stream');
            res.setHeader('Content-Length', String(row.file_size));

            return fs.createReadStream(absolutePath).pipe(res);

        } catch (err) {
            console.error('Could not serve a store file:', err);

            return res.status(500).json({
                error: 'Could not serve that file'
            });
        }
    }
);

// ============================================================
// POST /api/game/:assetId/versions/:versionId/downloaded
// ============================================================
//
// THE DEVELOPER SAYS WHAT THEY TOOK, so that it is in their history.
//
// AN ASSERTION, AND THEREFORE TYPED — the same rule as the changelist an
// importer records (item 64). The server cannot see the developer's disk, so it
// cannot know whether a download finished, and a manifest fetched is not a
// download made. The client says what it wrote; this writes it down.
//
// AND IT DOES NOT INFLATE THE QUOTA OR THE STORE'S FIGURES. A download copies
// nothing and creates no rows in stored_files — it is a note about an event,
// not a thing.
// ============================================================

router.post(
    '/:assetId/versions/:versionId/downloaded',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);
        const developerId = req.user?.id;

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        const number = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

        try {
            const asset = oneAsset.get(assetId);
            const version = versionForDownload.get(versionId, assetId);

            if (!asset || !version) {
                return res.status(404).json({
                    error: 'That version is not in the game store'
                });
            }

            audit.record(developerId, 'store.download', asset.name, {
                repository_asset_id: assetId,
                repository_version_id: versionId,
                version_number: version.version_number,
                files_written: number(req.body?.files_written),
                files_unchanged: number(req.body?.files_unchanged),
                files_failed: number(req.body?.files_failed),
                // The folder the files went under, which is the developer's
                // choice and not the store's — see item 81.
                target_folder: req.body?.target_folder
                    ? String(req.body.target_folder).slice(0, 200)
                    : null
            });

            return res.status(201).json({ status: 'recorded' });

        } catch (err) {
            console.error('Could not record a download:', err);

            return res.status(500).json({
                error: 'Could not record that'
            });
        }
    }
);

// ============================================================
// POST /api/game/:assetId/versions/:versionId/import
// ============================================================
//
// TAKE AN APPROVED VERSION INTO YOUR OWN WORKSPACE.
//
// THIS IS WHAT MAKES THE ROUND TRIP CLOSE. The workspace asset records WHICH
// STORE ASSET AND VERSION it came from — repository_asset_id and
// repository_base_version_id — so approving it again ADDS A VERSION to the
// store asset it came from rather than creating a second one with the same name.
// Item 59's failure, where two bigTrees end up in the store and nobody can tell
// them apart, is prevented by those two columns and nothing else.
//
// NOTHING IS COPIED. The workspace version references the VERY SAME
// stored_files rows the store version does — which is what the one-copy rule
// means, and why importing a hundred-megabyte asset costs no disk at all.
// ============================================================

router.post(
    '/:assetId/versions/:versionId/import',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);
        const developerId = req.user?.id;

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        try {
            const asset = oneAsset.get(assetId);
            const version = versionForDownload.get(versionId, assetId);

            if (!asset || !version) {
                return res.status(404).json({
                    error: 'That version is not in the game store'
                });
            }

            let workspace = workspaceOf.get(developerId);

            const result = db.transaction(() => {
                if (!workspace) {
                    const created = createWorkspace.run(developerId);
                    workspace = { id: created.lastInsertRowid };
                }

                const existing = workspaceAssetByName.get(workspace.id, asset.name);

                // ------------------------------------------------
                // ALREADY THERE.
                //
                // The name is taken. If it is taken by something derived
                // from THIS store asset, the developer already has it and
                // there is nothing to do — saying so is the honest answer,
                // and it is the same shape as the library's "already in
                // the library".
                // ------------------------------------------------

                if (existing?.is_active && existing.repository_asset_id === assetId) {
                    return { already: true, workspace_asset_id: existing.id };
                }

                // ------------------------------------------------
                // IN THE BIN, AND IT CAME FROM HERE.
                //
                // RESTORE RATHER THAN INSERT, because the row holds the
                // name whether it is deleted or not — and restoring is the
                // RIGHT ANSWER rather than a workaround: it is the same
                // asset, imported from the same place, and the link back
                // to the store is already on the row. The library does the
                // same when something removed is uploaded again.
                //
                // ITS VERSIONS COME BACK WITH IT, which is what the bin's
                // own Restore does. The current store version is then
                // added on top as a new version.
                // ------------------------------------------------

                if (existing && !existing.is_active && existing.repository_asset_id === assetId) {
                    restoreWorkspaceAsset.run(existing.id);
                    restoreWorkspaceVersions.run(existing.id);

                    const restoredLatest = latestWorkspaceVersion.get(existing.id);
                    const restoredNumber = (restoredLatest?.n || 0) + 1;

                    const restoredVersion = insertWorkspaceVersion.run(
                        existing.id,
                        restoredNumber,
                        developerId,
                        `Imported from the game store: ${asset.name} v${version.version_number}`
                    );

                    insertWorkspaceVersionFile.run(restoredVersion.lastInsertRowid, versionId);

                    audit.record(developerId, 'workspace.import_from_store', asset.name, {
                        workspace_asset_id: existing.id,
                        repository_asset_id: assetId,
                        repository_base_version_id: versionId,
                        restored_from_bin: true
                    });

                    return {
                        restored: true,
                        workspace_asset_id: existing.id,
                        workspace_version_id: restoredVersion.lastInsertRowid
                    };
                }

                // ------------------------------------------------
                // AND IF THE NAME IS TAKEN BY SOMETHING ELSE, REFUSE.
                //
                // It may be the developer's own work that happens to share
                // a name, or it may come from a DIFFERENT store asset.
                // Adopting either would silently make somebody's work an
                // ancestor of the store's, which is a fact about history
                // and not something to guess at.
                // ------------------------------------------------

                if (existing) {
                    const err = new Error(
                        existing.is_active
                            ? `You already have a workspace asset called "${asset.name}", ` +
                              'and it did not come from this one. Rename it, or import ' +
                              'this under a different name.'
                            : `You have a DELETED workspace asset called "${asset.name}", ` +
                              'and it did not come from this one. Restore or remove it from ' +
                              'your bin first — importing would otherwise adopt it.'
                    );
                    err.status = 409;
                    throw err;
                }

                const wsAsset = insertWorkspaceAsset.run(
                    workspace.id,
                    asset.name,
                    asset.asset_type || null,
                    asset.category || null,
                    asset.description || null,
                    assetId,
                    versionId
                );

                const wsAssetId = wsAsset.lastInsertRowid;

                const latest = latestWorkspaceVersion.get(wsAssetId);
                const versionNumber = (latest?.n || 0) + 1;

                const wsVersion = insertWorkspaceVersion.run(
                    wsAssetId,
                    versionNumber,
                    developerId,
                    `Imported from the game store: ${asset.name} v${version.version_number}`
                );

                // THE ONE-COPY RULE, IN ONE STATEMENT. The files are COPIED AS
                // REFERENCES — the same stored_file_id rows the store version
                // points at — so this costs no bytes and cannot drift from what
                // was approved.
                insertWorkspaceVersionFile.run(
                    wsVersion.lastInsertRowid,
                    versionId
                );

                audit.record(developerId, 'workspace.import_from_store', asset.name, {
                    workspace_asset_id: wsAssetId,
                    repository_asset_id: assetId,
                    repository_base_version_id: versionId,
                    version_number: version.version_number
                });

                return {
                    already: false,
                    workspace_asset_id: wsAssetId,
                    workspace_version_id: wsVersion.lastInsertRowid
                };
            })();

            if (result.already) {
                return res.json({
                    status: 'already',
                    message: `"${asset.name}" is already in your workspace.`,
                    workspace_asset_id: result.workspace_asset_id
                });
            }

            return res.status(201).json({
                // 'restored' when the row was in the bin and came back, which is
                // a different thing to report than a straight import.
                status: result.restored ? 'restored' : 'imported',
                workspace_asset_id: result.workspace_asset_id,
                workspace_version_id: result.workspace_version_id,
                from: {
                    asset_id: assetId,
                    asset_name: asset.name,
                    version_id: versionId,
                    version_number: version.version_number
                }
            });

        } catch (err) {
            if (err.status === 409) {
                return res.status(409).json({ error: err.message });
            }

            console.error('Could not import a store version:', err);

            return res.status(500).json({
                error: 'Could not import that version'
            });
        }
    }
);

module.exports = router;
