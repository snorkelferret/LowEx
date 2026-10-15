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

const workspaceOf = db.prepare(`
    SELECT id FROM developer_workspaces WHERE developer_id = ?
`);

const createWorkspace = db.prepare(`
    INSERT INTO developer_workspaces (developer_id) VALUES (?)
`);

const workspaceAssetByName = db.prepare(`
    SELECT id, name, repository_asset_id
    FROM workspace_assets
    WHERE workspace_id = ? AND name = ? AND is_active = 1
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

            // The manifest is also offered on its own, so a script can ask what
            // is in an archive without downloading it — which is the first half
            // of the hash negotiation the spec defers to later.
            if (req.query.manifest === 'only') {
                res.type('application/json');
                return res.json(manifest);
            }

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

                if (existing && existing.repository_asset_id === assetId) {
                    return { already: true, workspace_asset_id: existing.id };
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
                        `You already have a workspace asset called "${asset.name}", ` +
                        'and it did not come from this one. Rename it, or import ' +
                        'this under a different name.'
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
                status: 'imported',
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
