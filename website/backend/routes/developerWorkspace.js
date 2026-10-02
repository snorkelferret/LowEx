//backend/routes/developerWorkspace.js
const express = require('express');
const router = express.Router();

const db = require('../db');
const audit = require('../lib/audit');
const {
    authenticateToken,
    requireRole
} = require('../middleware/auth');


const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    parseAssetName,
    classifyFolderName,
    matchAssetName,
    deriveUploadRoot,
    isBackupFile,
    normaliseCategory,
    assetTypeOf,
    extensionOf,
    checkFileContent,
    SIGNATURE_HEAD_BYTES
} = require('../../shared/assetRules.mjs');


// ============================================================
// Temporary upload storage
// ============================================================

const tempUploadDir = path.join(__dirname, '../uploads/tmp');

fs.mkdirSync(tempUploadDir, { recursive: true });



// ============================================================
// WORKSPACE QUOTA
// ============================================================
//
// A workspace is a STAGING AREA, not a store. The limit exists to stop it
// being used as permanent storage, not to ration legitimate work.
//
// THE ACCOUNTING, and why it is shaped this way:
//
//   * COUNTED: distinct content the workspace still holds — that is, distinct
//     stored_files referenced by its ACTIVE assets and ACTIVE versions.
//
//   * DISTINCT, because content is addressed by SHA. Re-uploading unchanged
//     files must not count again, or every iteration would appear to cost the
//     full size of the tree.
//
//   * EXCLUDED: anything already in the GAME STORE. Game-owned content is not
//     what the workspace is staging, and pulling an approved asset back down
//     to iterate on it must not consume quota — that round trip is the workflow
//     the portal exists to support.
//
//   * A WORKSPACE IS PRIVATE. Nothing in it is visible to, or shared with,
//     another developer. The GAME STORE is the only shared content in the
//     system, which is why it is the only thing the exclusion above is about.
//
//   * The store is content-addressed, so it cannot tell "the same bytes" from
//     "the same file". If two developers independently upload identical
//     content, it is stored ONCE and counted against BOTH. That is not sharing
//     — neither can see the other's work — it is deduplication, and each is
//     still staging their own copy. Which is exactly why the accounting is per
//     workspace and not per stored file.
//
//   * SOFT-DELETED rows do not count, which is precisely how deleting frees
//     quota without destroying review history.
//
// Tunable without a code change. Default 5 GiB: a 500 MB .blend re-saved ten
// times is 5 GB of genuinely new content, and dedup does not help with that,
// so a smaller limit would strand a developer mid-iteration on a large asset.
const WORKSPACE_LIMIT_BYTES = (() => {
    const configured = Number(process.env.WORKSPACE_LIMIT_BYTES);
    return Number.isFinite(configured) && configured > 0
        ? configured
        : 5 * 1024 * 1024 * 1024;
})();

// Sizes are shown to developers, so they are rendered in a unit a person can
// read. A fixed MB divisor reported a small limit as "0.0 MB" and a 5 GB limit
// as "5120.0 MB".
function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];

    let value = Number(bytes) || 0;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

// Distinct stored files the workspace currently holds, game-store content
// excluded.
const workspaceStoredFileIds = db.prepare(`
    SELECT DISTINCT wvf.stored_file_id AS id
    FROM workspace_version_files wvf
    JOIN workspace_versions wv ON wv.id = wvf.workspace_version_id
    JOIN workspace_assets   wa ON wa.id = wv.workspace_asset_id
    WHERE wa.workspace_id = ?
      AND wa.is_active = 1
      AND wv.is_active = 1
      AND wvf.stored_file_id NOT IN (
          SELECT stored_file_id FROM asset_version_files
      )
`);

const fileSizeOf = db.prepare(`
    SELECT id, file_size FROM stored_files WHERE id = ?
`);

// ---------------------------------------------------------------------------
// A version's review state — DEFINED ONCE
// ---------------------------------------------------------------------------
//
// GET /assets and GET /assets/history both report what happened to a version:
// its latest technical check, why anything failed, and the latest approval.
// They were each carrying their own copy of these four queries, which is two
// things to keep in step for no benefit — the same reasoning that put the file
// rules in shared/ rather than in both halves of the app.
//
// The distinction that matters between the two result queries: reasons are the
// FAILURES, which is what goes red on the page. results are EVERYTHING the
// check said, which is what tells a developer which checks actually ran.

const latestCheckForVersion = db.prepare(`
    SELECT
        id,
        status,
        summary,
        started_at,
        completed_at
    FROM technical_check_runs
    WHERE workspace_version_id = ?
    ORDER BY id DESC
    LIMIT 1
`);

// The reason a check failed lives here, not in runs.summary — that is only
// ever "Technical validation failed.".
const checkReasonsForRun = db.prepare(`
    SELECT
        check_name,
        status,
        message
    FROM technical_check_results
    WHERE technical_check_run_id = ?
      AND status <> 'passed'
    ORDER BY id
`);

const checkResultsForRun = db.prepare(`
    SELECT
        check_name,
        status,
        message
    FROM technical_check_results
    WHERE technical_check_run_id = ?
    ORDER BY id
`);

const latestApprovalForVersion = db.prepare(`
    SELECT
        id,
        status,
        request_comment,
        requested_at,
        decision_comment,
        decided_at,
        decided_by
    FROM creative_approvals
    WHERE workspace_version_id = ?
    ORDER BY id DESC
    LIMIT 1
`);

const usernameById = db.prepare(`
    SELECT username FROM users WHERE id = ?
`);

// Attaches the review state to one version object. Shared by both routes so
// they cannot describe a version differently.
function withReviewState(version) {
    const check = latestCheckForVersion.get(version.id) || null;

    if (check) {
        check.reasons = checkReasonsForRun.all(check.id);
        check.results = checkResultsForRun.all(check.id);
    }

    version.latest_check = check;
    version.latest_approval = latestApprovalForVersion.get(version.id) || null;

    return version;
}

// Used by the upload quota check, which runs before anything is written and so
// has to work from hashes rather than from stored_file ids that do not exist
// yet.
const shaInGameStore = db.prepare(`
    SELECT 1
    FROM asset_version_files avf
    JOIN stored_files sf ON sf.id = avf.stored_file_id
    WHERE sf.sha256 = ?
    LIMIT 1
`);

const shaHeldByWorkspace = db.prepare(`
    SELECT 1
    FROM workspace_version_files wvf
    JOIN workspace_versions wv ON wv.id = wvf.workspace_version_id
    JOIN workspace_assets   wa ON wa.id = wv.workspace_asset_id
    JOIN stored_files       sf ON sf.id = wvf.stored_file_id
    WHERE wa.workspace_id = ?
      AND wa.is_active = 1
      AND wv.is_active = 1
      AND sf.sha256 = ?
    LIMIT 1
`);

function workspaceUsage(workspaceId) {
    const rows = workspaceStoredFileIds.all(workspaceId);

    let bytes = 0;
    for (const row of rows) {
        const file = fileSizeOf.get(row.id);
        if (file) bytes += file.file_size;
    }

    return {
        bytes,
        limit_bytes: WORKSPACE_LIMIT_BYTES,
        remaining_bytes: Math.max(0, WORKSPACE_LIMIT_BYTES - bytes),
        file_count: rows.length,
        percent_used: WORKSPACE_LIMIT_BYTES > 0
            ? Math.round((bytes / WORKSPACE_LIMIT_BYTES) * 1000) / 10
            : 0
    };
}


// ============================================================
// GET /api/developer/workspace/assets
// ============================================================
//
// Return the logged-in developer's private workspace assets.
//
// A developer can ONLY see their own workspace here.
// ============================================================

router.get(
    '/assets',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),
    async (req, res) => {
        try {
            const developerId = req.user?.id;

            if (!developerId) {
                return res.status(401).json({
                    error: 'Authenticated user ID not found'
                });
            }

            let workspace = db.prepare(`
                SELECT *
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);

            if (!workspace) {
                const result = db.prepare(`
                    INSERT INTO developer_workspaces (developer_id)
                    VALUES (?)
                `).run(developerId);

                workspace = db.prepare(`
                    SELECT *
                    FROM developer_workspaces
                    WHERE id = ?
                `).get(result.lastInsertRowid);
            }

            const assets = db.prepare(`
                SELECT
                    id,
                    name,
                    asset_type,
                    category,
                    description,
                    created_at,
                    updated_at,
                    is_active
                FROM workspace_assets
                WHERE workspace_id = ?
                  AND is_active = 1
                ORDER BY name COLLATE NOCASE
            `).all(workspace.id);

            // Soft-deleted versions are excluded here, which is what makes
            // deleting free quota and remove the version from the developer's
            // view while the review history stays intact.
            const getVersions = db.prepare(`
                SELECT
                    id,
                    version_number,
                    version_note,
                    created_by,
                    created_at,
                    creative_locked,
                    locked_at,
                    repository_version_id
                FROM workspace_versions
                WHERE workspace_asset_id = ?
                  AND is_active = 1
                ORDER BY version_number DESC
            `);

            // State that already existed in the database but was never readable
            // from anywhere: a developer could submit for review and had no way
            // to learn the outcome. See the review's Phase 1 notes.

            // An asset with a pending approval is frozen: no new versions and no
            // metadata changes until it is decided. Surfaced per asset so the
            // panel can explain why, rather than only failing on submit.
            const getPendingApproval = db.prepare(`
                SELECT id
                FROM creative_approvals
                WHERE workspace_asset_id = ?
                  AND status = 'pending'
                LIMIT 1
            `);

            const getFiles = db.prepare(`
                SELECT
                    wvf.id,
                    wvf.filename,
                    wvf.relative_path,
                    wvf.created_at,
                    sf.file_size,
                    sf.mime_type,
                    sf.sha256
                FROM workspace_version_files wvf
                JOIN stored_files sf
                    ON sf.id = wvf.stored_file_id
                WHERE wvf.workspace_version_id = ?
                ORDER BY
                    COALESCE(wvf.relative_path, '') COLLATE NOCASE,
                    wvf.filename COLLATE NOCASE
            `);

            for (const asset of assets) {
                asset.versions = getVersions.all(asset.id);
                asset.has_pending_approval =
                    Boolean(getPendingApproval.get(asset.id));

                for (const version of asset.versions) {
                    version.files = getFiles.all(version.id);
                    withReviewState(version);
                }
            }

            return res.json({
                workspace,
                // Lets the panel show "4.2 GB of 5 GB used" and warn about a
                // pending upload BEFORE it is attempted. The client figure is
                // advisory only; the server enforces on upload regardless.
                usage: workspaceUsage(workspace.id),
                assets
            });

        } catch (err) {
            console.error('Failed to load developer workspace:', err);

            return res.status(500).json({
                error: 'Failed to load developer workspace'
            });
        }
    }
);


// ============================================================
// GET /api/developer/workspace/assets/history
// ============================================================
//
// EVERYTHING this developer has ever worked on — every asset, live or not, and
// every version of it, live or not — with what happened to each.
//
// WHY IT IS SEPARATE FROM GET /assets. That route filters to is_active = 1, and
// that is correct for what it is for: it is the workspace, the thing a developer
// is working IN right now. This is the opposite question — what have I done —
// and it is the half that carries the value after the work has moved on: what
// was uploaded, what the checks said, what the reviewer decided, and which
// versions ended up in the game store.
//
// SCOPE IS THE CALLER'S OWN WORKSPACE, exactly as everywhere else in this
// router. There is no admin bypass and there should not be; an admin who needs
// to see inside a developer's workspace does it by impersonation. A history view
// is more tempting than most to open up, because it is read-only and looks
// harmless — but it is the developer's whole working record, so the rule holds.
//
// READ ONLY. Nothing here writes. The rows it reports on are the ones the
// purge (see TODO) will keep while dropping the files, which is why this can be
// built before that exists and still be correct afterwards.
// ============================================================

router.get(
    '/assets/history',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {
        const developerId = req.user?.id;

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        try {
            const workspace = db.prepare(`
                SELECT id
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);

            // No workspace means nothing has ever been uploaded, which is an
            // empty history rather than an error.
            if (!workspace) {
                return res.json({
                    totals: { assets: 0, versions: 0, in_game_store: 0 },
                    assets: []
                });
            }

            // EVERY asset — no is_active filter. Live ones first, then the
            // rest, so the current work is at the top of the list without the
            // past being hidden.
            const assets = db.prepare(`
                SELECT
                    id,
                    name,
                    asset_type,
                    category,
                    description,
                    created_at,
                    updated_at,
                    is_active,
                    repository_asset_id
                FROM workspace_assets
                WHERE workspace_id = ?
                ORDER BY is_active DESC, name COLLATE NOCASE
            `).all(workspace.id);

            const getVersions = db.prepare(`
                SELECT
                    id,
                    version_number,
                    version_note,
                    created_by,
                    created_at,
                    creative_locked,
                    locked_at,
                    repository_version_id,
                    is_active
                FROM workspace_versions
                WHERE workspace_asset_id = ?
                ORDER BY version_number DESC
            `);

            const totals = { assets: 0, versions: 0, in_game_store: 0 };

            for (const asset of assets) {
                const versions = getVersions.all(asset.id);

                for (const version of versions) {
                    // Shared with GET /assets, so a version cannot be described
                    // one way in the workspace and another in the history.
                    withReviewState(version);

                    if (version.latest_approval?.decided_by) {
                        version.latest_approval.decided_by_username =
                            usernameById.get(
                                version.latest_approval.decided_by
                            )?.username || null;
                    }

                    // Which versions are in the game store. This is the fact
                    // the workspace has never shown and the one a developer
                    // actually wants: this work is finished, and this is where
                    // it went.
                    version.in_game_store = version.repository_version_id !== null;

                    if (version.in_game_store) totals.in_game_store++;
                }

                asset.versions = versions;
                asset.in_game_store = asset.repository_asset_id !== null;
                asset.live_versions = versions.filter(v => v.is_active).length;

                totals.assets++;
                totals.versions += versions.length;
            }

            // No explanatory prose in the payload. An earlier draft carried a
            // `notes` object of UI wording; nothing read it, and copy that
            // lives in the API is copy nobody edits when the screen changes.
            // The words belong where they are shown.
            return res.json({ totals, assets });

        } catch (err) {
            console.error('Failed to load asset history:', err);

            return res.status(500).json({
                error: 'Failed to load the asset history'
            });
        }
    }
);


// ============================================================
// POST /api/developer/workspace/assets/:assetId/category
// ============================================================
//
// Sets which part of the game an asset belongs to.
//
// WHO: admin and superuser. NOT the developer — they set it at upload, and
// re-uploading with a different value updates it (the upload path COALESCEs it).
// Whether a developer should also be able to retag their own asset without
// re-uploading is an open question; it is not granted here because it was not
// asked for, and every extra actor on a shared field is another way for two
// people to disagree about what something is.
//
// THIS IS A DELIBERATE EXCEPTION to "admins only reach inside a workspace by
// impersonation". It is narrow on purpose, and worth stating plainly:
//
//   * it writes ONE column on ONE row;
//   * it reads nothing — no filenames, no versions, no file contents;
//   * it is audit-logged, so a retag is never anonymous.
//
// The impersonation rule exists so an admin cannot quietly browse someone's
// sandbox. This does not let them browse it; it lets them correct a label on
// something they are already responsible for classifying. If that reasoning
// stops holding — if this grows an argument for reading the asset to decide —
// it has stopped being this route and should go through impersonation instead.
//
// The value is a HINT, not a constraint: anything off the list is stored as
// given rather than refused, and an empty value clears the category. See
// normaliseCategory in shared/assetRules.mjs.
// ============================================================

router.post(
    '/assets/:assetId/category',
    authenticateToken,
    requireRole('admin', 'superuser'),

    async (req, res) => {
        const actor = req.user;
        const assetId = Number(req.params.assetId);

        if (!Number.isInteger(assetId)) {
            return res.status(400).json({ error: 'Invalid asset ID' });
        }

        if (!req.body || !('category' in req.body)) {
            return res.status(400).json({
                error: 'A category is required. Send an empty value to clear it.'
            });
        }

        const category = normaliseCategory(req.body.category);

        try {
            const asset = db.prepare(`
                SELECT
                    wa.id,
                    wa.name,
                    wa.category,
                    wa.workspace_id
                FROM workspace_assets wa
                WHERE wa.id = ?
                  AND wa.is_active = 1
            `).get(assetId);

            if (!asset) {
                return res.status(404).json({ error: 'Workspace asset not found' });
            }

            // Nothing to do, and nothing to record. Saying so is more useful
            // than a silent success that leaves no trace in the audit log.
            if ((asset.category || null) === category) {
                return res.json({
                    asset_id: asset.id,
                    name: asset.name,
                    category,
                    changed: false
                });
            }

            db.transaction(() => {
                db.prepare(`
                    UPDATE workspace_assets
                    SET
                        category = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(category, asset.id);

                audit.record(
                    actor.id,
                    'workspace_asset.set_category',
                    asset.name,
                    {
                        workspace_asset_id: asset.id,
                        from: asset.category || null,
                        to: category
                    }
                );
            })();

            return res.json({
                asset_id: asset.id,
                name: asset.name,
                category,
                changed: true
            });

        } catch (err) {
            console.error('Failed to set the asset category:', err);

            return res.status(500).json({
                error: 'Failed to set the asset category'
            });
        }
    }
);


// ============================================================
// DELETE /api/developer/workspace/assets/:assetId
// DELETE /api/developer/workspace/assets/:assetId/versions/:versionId
// ============================================================
//
// A developer can delete anything in their own workspace. Two constraints:
//
//   1. IT IS SOFT. The rows stay, marked inactive, so review history survives.
//      A version cannot be hard-deleted once it has been checked or reviewed —
//      technical_check_runs and creative_approvals reference it with foreign
//      keys that have no ON DELETE clause, deliberately. Soft delete also means
//      quota frees (accounting counts only live rows) without erasing anything.
//
//   2. IT TOUCHES ONLY THE WORKSPACE ROWS. stored_files, assets and
//      asset_versions are never modified, so game-owned content, and content
//      another workspace happens to share, are unaffected. The developer
//      deletes what belongs to them — their own uploads and their own
//      references — and nothing else.
//
// Refused while an approval is pending. What is being reviewed must not
// disappear mid-review. A version already approved into the game store CAN be
// deleted from the workspace: the game store holds its own copy, so only the
// developer's copy goes.
// ============================================================

function pendingApprovalForAsset(assetId) {
    return db.prepare(`
        SELECT id
        FROM creative_approvals
        WHERE workspace_asset_id = ?
          AND status = 'pending'
        LIMIT 1
    `).get(assetId);
}

function pendingApprovalForVersion(versionId) {
    return db.prepare(`
        SELECT id
        FROM creative_approvals
        WHERE workspace_version_id = ?
          AND status = 'pending'
        LIMIT 1
    `).get(versionId);
}

router.delete(
    '/assets/:assetId',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {
        const developerId = req.user?.id;
        const assetId = Number(req.params.assetId);

        if (!Number.isInteger(assetId)) {
            return res.status(400).json({ error: 'Invalid asset ID' });
        }

        try {
            const asset = db.prepare(`
                SELECT wa.id, wa.name, wa.workspace_id
                FROM workspace_assets wa
                JOIN developer_workspaces dw ON dw.id = wa.workspace_id
                WHERE wa.id = ?
                  AND dw.developer_id = ?
                  AND wa.is_active = 1
            `).get(assetId, developerId);

            if (!asset) {
                return res.status(404).json({ error: 'Workspace asset not found' });
            }

            if (pendingApprovalForAsset(assetId)) {
                return res.status(409).json({
                    error:
                        `"${asset.name}" is under review and cannot be deleted ` +
                        `until the pending approval is decided.`
                });
            }

            const remove = db.transaction(() => {
                db.prepare(`
                    UPDATE workspace_versions
                    SET is_active = 0
                    WHERE workspace_asset_id = ?
                `).run(assetId);

                db.prepare(`
                    UPDATE workspace_assets
                    SET is_active = 0,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(assetId);
            });

            remove();

            return res.json({
                status: 'deleted',
                asset_id: assetId,
                name: asset.name,
                note: 'Content shared with the game store or another workspace is untouched.',
                usage: workspaceUsage(asset.workspace_id)
            });

        } catch (err) {
            console.error('Failed to delete workspace asset:', err);

            return res.status(500).json({ error: 'Failed to delete workspace asset' });
        }
    }
);

router.delete(
    '/assets/:assetId/versions/:versionId',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {
        const developerId = req.user?.id;
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        try {
            const version = db.prepare(`
                SELECT
                    wv.id,
                    wv.version_number,
                    wa.name AS asset_name,
                    wa.workspace_id,
                    wv.repository_version_id
                FROM workspace_versions wv
                JOIN workspace_assets wa     ON wa.id = wv.workspace_asset_id
                JOIN developer_workspaces dw ON dw.id = wa.workspace_id
                WHERE wv.id = ?
                  AND wa.id = ?
                  AND dw.developer_id = ?
                  AND wa.is_active = 1
                  AND wv.is_active = 1
            `).get(versionId, assetId, developerId);

            if (!version) {
                return res.status(404).json({ error: 'Workspace version not found' });
            }

            if (pendingApprovalForVersion(versionId)) {
                return res.status(409).json({
                    error:
                        `Version ${version.version_number} of "${version.asset_name}" ` +
                        `is under review and cannot be deleted until the pending ` +
                        `approval is decided.`
                });
            }

            db.prepare(`
                UPDATE workspace_versions
                SET is_active = 0
                WHERE id = ?
            `).run(versionId);

            return res.json({
                status: 'deleted',
                asset_id: assetId,
                version_id: versionId,
                version_number: version.version_number,
                in_game_store: version.repository_version_id !== null,
                note: version.repository_version_id !== null
                    ? 'This version is in the game store; only your workspace copy was removed.'
                    : 'Content shared elsewhere is untouched.',
                usage: workspaceUsage(version.workspace_id)
            });

        } catch (err) {
            console.error('Failed to delete workspace version:', err);

            return res.status(500).json({ error: 'Failed to delete workspace version' });
        }
    }
);


// ============================================================
// GET /api/developer/workspace/assets/:assetId/versions/:versionId/checks
// ============================================================
//
// The full technical-check history for ONE of the caller's versions.
//
// Every run is kept (the developer may re-run checks freely), so this returns
// all of them, newest first, each with its individual results. The reason a
// check failed is in results[].message.
//
// Scoped through the caller's workspace, so a developer can only read their own.
// ============================================================

router.get(
    '/assets/:assetId/versions/:versionId/checks',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {
        const developerId = req.user?.id;
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({
                error: 'Invalid asset or version ID'
            });
        }

        try {
            const version = db.prepare(`
                SELECT wv.id
                FROM workspace_versions wv
                JOIN workspace_assets wa
                    ON wa.id = wv.workspace_asset_id
                JOIN developer_workspaces dw
                    ON dw.id = wa.workspace_id
                WHERE wv.id = ?
                  AND wa.id = ?
                  AND dw.developer_id = ?
                  AND wa.is_active = 1
            `).get(versionId, assetId, developerId);

            if (!version) {
                return res.status(404).json({
                    error: 'Workspace version not found'
                });
            }

            const runs = db.prepare(`
                SELECT
                    id,
                    status,
                    summary,
                    started_at,
                    completed_at
                FROM technical_check_runs
                WHERE workspace_version_id = ?
                ORDER BY id DESC
            `).all(versionId);

            const getResults = db.prepare(`
                SELECT
                    id,
                    check_name,
                    status,
                    message,
                    details,
                    started_at,
                    completed_at
                FROM technical_check_results
                WHERE technical_check_run_id = ?
                ORDER BY id
            `);

            for (const run of runs) {
                run.results = getResults.all(run.id);
                run.failed = run.results.filter(
                    r => r.status === 'failed' || r.status === 'error'
                ).length;
            }

            return res.json({
                versionId,
                runs
            });

        } catch (err) {
            console.error('Failed to load technical checks:', err);

            return res.status(500).json({
                error: 'Failed to load technical checks'
            });
        }
    }
);


// ============================================================
// GET /api/developer/workspace/creative-approvals
// ============================================================
//
// The review queue. Admin/superuser only.
//
// Without this there was no way to discover a pending approval: the approve and
// reject routes take an approval id, and nothing listed them, so the workflow
// could not actually be driven. Optional ?status= filter, defaulting to
// pending.
//
// Returns the requesting developer and the submitted files, so a decision can
// be made without a second round trip.
// ============================================================

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

router.get(
    '/creative-approvals',
    authenticateToken,
    requireRole('admin', 'superuser'),

    async (req, res) => {
        const status = req.query?.status === undefined
            ? 'pending'
            : String(req.query.status);

        if (status !== 'all' && !APPROVAL_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Expected one of: ${APPROVAL_STATUSES.join(', ')}, all`
            });
        }

        try {
            const rows = status === 'all'
                ? db.prepare(`
                    SELECT
                        ca.id,
                        ca.status,
                        ca.workspace_asset_id,
                        ca.workspace_version_id,
                        ca.request_comment,
                        ca.requested_at,
                        ca.requested_by,
                        ca.decision_comment,
                        ca.decided_at,
                        ca.decided_by,
                        ca.repository_asset_id,
                        ca.repository_version_id,
                        wa.name            AS asset_name,
                        wa.asset_type      AS asset_type,
                        wa.category        AS category,
                        wv.version_number  AS version_number,
                        wv.version_note    AS version_note,
                        wv.creative_locked AS version_locked,
                        u.username         AS requested_by_username
                    FROM creative_approvals ca
                    JOIN workspace_assets wa  ON wa.id = ca.workspace_asset_id
                    JOIN workspace_versions wv ON wv.id = ca.workspace_version_id
                    LEFT JOIN users u          ON u.id  = ca.requested_by
                    ORDER BY ca.requested_at DESC, ca.id DESC
                `).all()
                : db.prepare(`
                    SELECT
                        ca.id,
                        ca.status,
                        ca.workspace_asset_id,
                        ca.workspace_version_id,
                        ca.request_comment,
                        ca.requested_at,
                        ca.requested_by,
                        ca.decision_comment,
                        ca.decided_at,
                        ca.decided_by,
                        ca.repository_asset_id,
                        ca.repository_version_id,
                        wa.name            AS asset_name,
                        wa.asset_type      AS asset_type,
                        wa.category        AS category,
                        wv.version_number  AS version_number,
                        wv.version_note    AS version_note,
                        wv.creative_locked AS version_locked,
                        u.username         AS requested_by_username
                    FROM creative_approvals ca
                    JOIN workspace_assets wa  ON wa.id = ca.workspace_asset_id
                    JOIN workspace_versions wv ON wv.id = ca.workspace_version_id
                    LEFT JOIN users u          ON u.id  = ca.requested_by
                    WHERE ca.status = ?
                    ORDER BY ca.requested_at DESC, ca.id DESC
                `).all(status);

            // The files the approver is being asked to sign off. Note there is
            // still no download endpoint, so these are metadata only — see
            // TODO item 6.
            const getFiles = db.prepare(`
                SELECT
                    wvf.id,
                    wvf.filename,
                    wvf.relative_path,
                    sf.file_size,
                    sf.mime_type,
                    sf.sha256
                FROM workspace_version_files wvf
                JOIN stored_files sf
                    ON sf.id = wvf.stored_file_id
                WHERE wvf.workspace_version_id = ?
                ORDER BY
                    COALESCE(wvf.relative_path, '') COLLATE NOCASE,
                    wvf.filename COLLATE NOCASE
            `);

            for (const row of rows) {
                row.files = getFiles.all(row.workspace_version_id);
            }

            return res.json({
                status,
                count: rows.length,
                approvals: rows
            });

        } catch (err) {
            console.error('Failed to load creative approvals:', err);

            return res.status(500).json({
                error: 'Failed to load creative approvals'
            });
        }
    }
);


// ============================================================
// FILE ACCESS — manifest and content download
// ============================================================
//
// The first code in this project that serves user-uploaded bytes, so the
// details matter and are spelled out rather than left to a helper.
//
// AUTHORIZATION: the caller's OWN workspace, and nothing else.
//
// There is deliberately NO admin bypass. An admin or superuser who needs to
// see inside a developer's workspace does it by IMPERSONATION — marked,
// time-bounded, audit-logged. A standing "admins can read anything" exception
// would make impersonation pointless and the sandbox not private.
//
// Consequence, and it is worth being explicit: an approver cannot fetch the
// bytes of a submission without impersonating. If reviewing files becomes a
// normal need, impersonation is the mechanism — not an exception here.
//
// ============================================================

// The content store is flat: one file per SHA, named by its hash. Nothing else
// is ever used to build a filesystem path.
const UPLOAD_STORAGE_DIR = path.join(__dirname, '../uploads/files');

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Content-Disposition values are built from a developer-supplied filename, so
// they are sanitised rather than interpolated. RFC 5987 carries the real name
// for non-ASCII; the plain filename is reduced to printable ASCII with quotes
// and backslashes removed, so it cannot terminate the header or imply a path.
function attachmentHeader(filename) {
    const raw = String(filename || 'file');

    const ascii = raw
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["\\]/g, '')
        .trim() || 'file';

    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

// relative_path came from the client at upload time and was normalised for
// traversal then. It is validated again on the way out, because the manifest
// tells a client where to WRITE files. A bad path is reported rather than
// silently passed through.
function relativePathIsSafe(value) {
    if (value === null || value === undefined || value === '') return true;

    const p = String(value);

    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;   // absolute
    if (p.split(/[\\/]/).some(seg => seg === '..')) return false;  // traversal
    if (/[\x00-\x1f]/.test(p)) return false;                       // control chars

    return true;
}

// Resolve the files of one version.
//
// SCOPE IS ALWAYS THE CALLER'S OWN WORKSPACE. There is no admin bypass.
// An admin or superuser who needs to see inside a developer's workspace does
// it by IMPERSONATION, which is marked, time-bounded and audit-logged — not by
// a standing read path. A quiet "admins can read anything" exception would
// make impersonation pointless and the sandbox not private.
//
// Returns null both when the version does not exist and when it is not the
// caller's, so this cannot be used to probe for another developer's work.
function filesForVersion(assetId, versionId, user) {
    const version = db.prepare(`
        SELECT
            wv.id,
            wv.version_number,
            wv.version_note,
            wv.creative_locked,
            wv.repository_version_id,
            wa.id   AS asset_id,
            wa.name AS asset_name,
            wa.asset_type,
            wa.category
        FROM workspace_versions wv
        JOIN workspace_assets wa     ON wa.id = wv.workspace_asset_id
        JOIN developer_workspaces dw ON dw.id = wa.workspace_id
        WHERE wv.id = ?
          AND wa.id = ?
          AND wa.is_active = 1
          AND dw.developer_id = ?
    `).get(versionId, assetId, user.id);

    if (!version) return null;

    const files = db.prepare(`
        SELECT
            wvf.id,
            wvf.filename,
            wvf.relative_path,
            sf.sha256,
            sf.file_size,
            sf.mime_type,
            sf.storage_key
        FROM workspace_version_files wvf
        JOIN stored_files sf ON sf.id = wvf.stored_file_id
        WHERE wvf.workspace_version_id = ?
        ORDER BY
            COALESCE(wvf.relative_path, '') COLLATE NOCASE,
            wvf.filename COLLATE NOCASE
    `).all(versionId);

    return { version, files };
}


// ============================================================
// GET .../assets/:assetId/versions/:versionId/manifest
// ============================================================
//
// What a client needs to sync a working copy: every file with the path it
// belongs at, its SHA-256, and its size. Because the content is addressed by
// hash, a client that already holds a file can skip it — which is the whole
// point. A developer with a working copy only wants what changed.
//
// This is also the reason a monolithic zip is not the primary mechanism: a
// game asset tree can exceed 4 GB, and re-downloading all of it to collect one
// changed file is the wrong shape.
// ============================================================

router.get(
    '/assets/:assetId/versions/:versionId/manifest',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {
        const caller = req.user;
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);

        if (!Number.isInteger(assetId) || !Number.isInteger(versionId)) {
            return res.status(400).json({ error: 'Invalid asset or version ID' });
        }

        try {
            const resolved = filesForVersion(assetId, versionId, caller);

            if (!resolved) {
                return res.status(404).json({ error: 'Workspace version not found' });
            }

            const { version, files } = resolved;

            const unsafePaths = [];
            let totalSize = 0;

            const entries = files.map(file => {
                const path = file.relative_path
                    ? `${file.relative_path}/${file.filename}`
                    : file.filename;

                if (!relativePathIsSafe(file.relative_path)) {
                    unsafePaths.push(path);
                }

                totalSize += file.file_size;

                return {
                    id: file.id,
                    path,
                    relative_path: file.relative_path,
                    filename: file.filename,
                    sha256: file.sha256,
                    size: file.file_size,
                    mime_type: file.mime_type,
                    // The client never needs to construct this itself.
                    url:
                        `/api/developer/workspace/assets/${assetId}` +
                        `/versions/${versionId}/files/${file.id}/content`
                };
            });

            return res.json({
                asset: {
                    id: version.asset_id,
                    name: version.asset_name,
                    asset_type: version.asset_type,
                    category: version.category
                },
                version: {
                    id: version.id,
                    version_number: version.version_number,
                    version_note: version.version_note,
                    creative_locked: version.creative_locked,
                    repository_version_id: version.repository_version_id
                },
                file_count: entries.length,
                total_size: totalSize,
                // Non-empty means the database holds a path a client must not
                // write to. Reported rather than dropped, so it is visible.
                unsafe_paths: unsafePaths,
                files: entries
            });

        } catch (err) {
            console.error('Failed to build download manifest:', err);

            return res.status(500).json({
                error: 'Failed to build download manifest'
            });
        }
    }
);


// ============================================================
// GET .../assets/:assetId/versions/:versionId/files/:fileId/content
// ============================================================
//
// Streams one file.
//
// Two things here are load-bearing:
//
//   1. The filesystem path is built from stored_files.storage_key ONLY, after
//      validating it as 64 hex characters. Nothing client-supplied touches the
//      path, so there is no traversal surface at all.
//
//   2. The response is application/octet-stream with Content-Disposition:
//      attachment — NEVER the stored mime_type. Serving a developer-supplied
//      .svg or .html inline, from this origin, would be stored XSS against
//      whoever opened it. The mime_type is metadata for display, not a header.
// ============================================================

router.get(
    '/assets/:assetId/versions/:versionId/files/:fileId/content',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {
        const caller = req.user;
        const assetId = Number(req.params.assetId);
        const versionId = Number(req.params.versionId);
        const fileId = Number(req.params.fileId);

        if (!Number.isInteger(assetId) ||
            !Number.isInteger(versionId) ||
            !Number.isInteger(fileId)) {
            return res.status(400).json({ error: 'Invalid asset, version or file ID' });
        }

        try {
            const resolved = filesForVersion(assetId, versionId, caller);

            if (!resolved) {
                return res.status(404).json({ error: 'Workspace version not found' });
            }

            const file = resolved.files.find(f => f.id === fileId);

            if (!file) {
                return res.status(404).json({ error: 'File not found in this version' });
            }

            // Refuse to build a path from anything that is not a plain SHA-256.
            if (!SHA256_HEX.test(String(file.storage_key))) {
                console.error(
                    'Refusing to serve stored file with a malformed storage_key:',
                    file.storage_key
                );

                return res.status(500).json({
                    error: 'Stored file record is malformed'
                });
            }

            const absolutePath = path.join(UPLOAD_STORAGE_DIR, file.storage_key);

            let stat;

            try {
                stat = await fs.promises.stat(absolutePath);
            } catch {
                // The technical check reports this too ("Physical file is
                // missing..."). Say so plainly rather than sending a bare 404.
                return res.status(404).json({
                    error:
                        'The stored content for this file is missing from the ' +
                        'content store. It may need re-uploading.'
                });
            }

            if (!stat.isFile()) {
                return res.status(500).json({ error: 'Stored content is not a file' });
            }

            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', attachmentHeader(file.filename));
            res.setHeader('Content-Length', stat.size);
            // The bytes never change for a given hash.
            res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
            res.setHeader('X-Content-Type-Options', 'nosniff');

            return res.sendFile(absolutePath, err => {
                if (err && !res.headersSent) {
                    console.error('Failed to stream stored file:', err);

                    res.status(500).json({ error: 'Failed to stream stored file' });
                }
            });

        } catch (err) {
            console.error('Failed to serve stored file:', err);

            return res.status(500).json({ error: 'Failed to serve stored file' });
        }
    }
);


// ============================================================
// TEST FILE UPLOAD
// ============================================================
//
// This stage deliberately does NOT create:
//
//   workspace_assets
//   workspace_versions
//   workspace_version_files
//
// It only proves:
//
//   upload
//      ↓
//   SHA-256
//      ↓
//   already in stored_files?
//      /       \
//    yes        no
//     │          │
//     │      store physical file
//     │          │
//     └────┬─────┘
//          ↓
//      return result
//
// ============================================================



// ============================================================
// DEVELOPER ASSET UPLOAD
// ============================================================
//
// Upload one or more files into the developer's private
// workspace.
//
// The browser supplies the final logical filename and
// relative_path after the developer has reviewed/edited them.
//
// Physical files are deduplicated by SHA-256.
//
// Database records created:
//
//   workspace_assets
//          ↓
//   workspace_versions
//          ↓
//   workspace_version_files
//          ↓
//   stored_files
//
// The database changes are atomic.
// ============================================================

const assetUpload = multer({
    dest: tempUploadDir
});


// ============================================================
// POST /api/developer/workspace/assets/check-name
// ============================================================
//
// Preflight for an upload's folder name.
//
// The naming rules live on the server ONLY. The client asks rather than
// carrying its own copy of the regex, so there is one source of truth and the
// preview cannot disagree with what the upload will actually do.
//
// See docs/uploadmodel01. The asset name comes from the developer's folder:
// bigTree_v04 is asset "bigTree", and the _v04 is the developer's own
// labelling — their iteration marker, not the system's version. The system's
// upload version is a separate per-asset counter (v01, v02, …), housekeeping
// rather than something the developer manages.
//
// Body: { upload_name?, file_paths? } — the name is derived from file_paths
// when not given, so it cannot disagree with the content it describes.
//
// Returns the verdict, the parsed asset name, which asset the upload would
// join and how confidently, and the version it would become.
// ============================================================

router.post(
    '/assets/check-name',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {
        const developerId = req.user?.id;

        if (!developerId) {
            return res.status(401).json({ error: 'Authenticated user ID not found' });
        }

        try {
            // A developer with no workspace yet is not an error — it is exactly
            // who needs a preflight. A missing workspace simply means there are
            // no existing assets to match against. The workspace row itself is
            // created lazily by the upload, as before.
            const workspace = db.prepare(`
                SELECT id FROM developer_workspaces WHERE developer_id = ?
            `).get(developerId);

            const explicitName = String(req.body?.upload_name || '').trim();

            let filePaths = [];

            if (Array.isArray(req.body?.file_paths)) {
                filePaths = req.body.file_paths;
            } else if (typeof req.body?.file_paths === 'string') {
                try { filePaths = JSON.parse(req.body.file_paths); } catch { filePaths = []; }
            }

            const uploadName = explicitName || deriveUploadRoot(filePaths);

            if (!uploadName) {
                return res.json({
                    verdict: 'block',
                    code: 'no_name',
                    reason:
                        'No asset name could be determined. Select a FOLDER to ' +
                        'upload — the folder name is the asset name — or provide ' +
                        'one explicitly.',
                    upload_name: null,
                    asset_name: null,
                    match: { tier: 'different', matched_name: null },
                    next_upload_version: null
                });
            }

            const classification = classifyFolderName(uploadName);
            const parsed = classification.parsed;
            const assetName = parsed.name;

            const existingNames = workspace
                ? db.prepare(`
                    SELECT name
                    FROM workspace_assets
                    WHERE workspace_id = ?
                      AND is_active = 1
                `).all(workspace.id).map(r => r.name)
                : [];

            const match = matchAssetName(existingNames, assetName);

            // The version the upload WOULD become. Only meaningful for an
            // existing asset; a new one starts at 1.
            const targetName =
                match.tier === 'near' ? match.match :
                match.tier === 'exact' ? match.match :
                assetName;

            const target = workspace
                ? db.prepare(`
                    SELECT id FROM workspace_assets
                    WHERE workspace_id = ? AND name = ?
                `).get(workspace.id, targetName)
                : null;

            let nextUploadVersion = 1;

            if (target) {
                const latest = db.prepare(`
                    SELECT MAX(version_number) AS v
                    FROM workspace_versions
                    WHERE workspace_asset_id = ?
                `).get(target.id);

                nextUploadVersion = (latest?.v || 0) + 1;
            }

            return res.json({
                verdict: classification.verdict,
                code: classification.code,
                reason: classification.reason || null,
                upload_name: uploadName,
                asset_name: assetName,
                version_marker: parsed.version,
                match: {
                    tier: match.tier,
                    matched_name: match.match || null
                },
                next_upload_version: nextUploadVersion,
                existing_asset_names: existingNames
            });

        } catch (err) {
            console.error('Failed to check upload name:', err);

            return res.status(500).json({ error: 'Failed to check upload name' });
        }
    }
);

router.post(
    '/upload',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    assetUpload.fields([
        { name: 'files', maxCount: 1000 }
    ]),

    async (req, res) => {

        const uploadedFiles = req.files?.files || [];

        if (uploadedFiles.length === 0) {
            return res.status(400).json({
                error: 'No files uploaded'
            });
        }

        const developerId = req.user?.id;

        if (!developerId) {
            return res.status(401).json({
                error: 'Invalid authentication context'
            });
        }


        // --------------------------------------------------------
        // Temporary and newly-created physical files
        // --------------------------------------------------------

        const tempPaths = uploadedFiles.map(file => file.path);

        try {

            // ----------------------------------------------------
            // Metadata
            // ----------------------------------------------------

            const assetType =
                String(req.body.asset_type || '').trim();

            // Which part of the game this belongs to. Normalised here so the
            // stored spelling is always canonical; an unknown value becomes
            // null rather than an error, because "no category yet" is a normal
            // state for an asset and refusing the upload over a label would be
            // a worse outcome than the label being blank.
            const category = normaliseCategory(req.body.category);

            const description =
                String(req.body.description || '').trim();

            const versionNote =
                String(
                    req.body.version_note ||
                    'Initial upload'
                ).trim();


            if (!versionNote) {
                throw new Error('Version note is required');
            }


            // ----------------------------------------------------
            // File paths supplied by the browser
            //
            // One entry for each uploaded file.
            //
            // Example:
            //
            // [
            //   "models/OakTree.blend",
            //   "textures/OakTree.png"
            // ]
            // ----------------------------------------------------

            let filePaths = [];

            if (req.body.file_paths) {

                try {
                    filePaths = JSON.parse(req.body.file_paths);
                } catch (err) {
                    throw new Error(
                        'Invalid file path information'
                    );
                }

                if (!Array.isArray(filePaths)) {
                    throw new Error(
                        'Invalid file path information'
                    );
                }
            }


            // ----------------------------------------------------
            // The asset name comes from the FOLDER the developer
            // uploaded. See docs/uploadmodel01.
            //
            // It is DERIVED FROM THE PATHS rather than taken on
            // trust from a separate field, so the name cannot
            // disagree with the content it describes.
            //
            //   bigTree_v04/scripts/nuke.nk
            //     -> root  "bigTree_v04"
            //     -> asset "bigTree"
            //
            // The _v04 is the DEVELOPER'S labelling — their own
            // iteration marker — not the system's version. The
            // upload version is a separate per-asset counter, which
            // is what MAX(version_number) + 1 below still does.
            // ----------------------------------------------------

            const explicitUploadName =
                String(req.body.upload_name || '').trim();

            const uploadName =
                explicitUploadName ||
                deriveUploadRoot(filePaths) ||
                deriveUploadRoot(uploadedFiles.map(f => f.originalname));

            if (!uploadName) {
                throw new Error(
                    'No asset name could be determined. Select a FOLDER to ' +
                    'upload — the folder name is the asset name.'
                );
            }

            const classification =
                classifyFolderName(uploadName);

            // Deliberately fatal: a name ending in a file extension is a file,
            // not an asset, and proceeding would create a nonsense asset.
            if (classification.verdict === 'block') {
                const namingError = new Error(classification.reason);
                namingError.status = 422;
                throw namingError;
            }

            const parsedName =
                classification.parsed;


            // ----------------------------------------------------
            // Filename overrides
            //
            // Optional JSON object:
            //
            // {
            //   "models/OakTree.blend": "OakTree_LOD.blend"
            // }
            // ----------------------------------------------------

            let filenameOverrides = {};

            if (req.body.filename_overrides) {

                try {
                    filenameOverrides =
                        JSON.parse(
                            req.body.filename_overrides
                        );
                } catch (err) {
                    throw new Error(
                        'Invalid filename override information'
                    );
                }

                if (
                    typeof filenameOverrides !== 'object' ||
                    Array.isArray(filenameOverrides) ||
                    filenameOverrides === null
                ) {
                    throw new Error(
                        'Invalid filename override information'
                    );
                }
            }


            // ----------------------------------------------------
            // Construct the final logical file information.
            //
            // The browser has already allowed the developer to
            // review/change these values.
            // ----------------------------------------------------

            const processedFiles = [];
            const logicalPaths = new Set();

            // Backup files found in this upload. Reported rather than acted on
            // beyond dropping them — see below.
            const skippedBackups = [];


            for (
                let i = 0;
                i < uploadedFiles.length;
                i++
            ) {

                const file = uploadedFiles[i];


                // ------------------------------------------------
                // Backup files are DROPPED, not rejected.
                //
                // A `.blend1` is a full copy of the .blend beside it, and a
                // `hereiam.txt~` is an editor leftover. Neither is an asset.
                // Failing the whole upload over one would be a hostile way to
                // react to something the developer did not do deliberately, so
                // they are skipped and reported instead.
                // ------------------------------------------------

                if (isBackupFile(file.originalname)) {
                    skippedBackups.push(file.originalname);
                    continue;
                }


                // ------------------------------------------------
                // Original relative path
                // ------------------------------------------------

                let logicalPath =
                    typeof filePaths[i] === 'string' &&
                    filePaths[i].trim()
                        ? filePaths[i].trim()
                        : file.originalname;


                logicalPath = logicalPath
                    .replace(/\\/g, '/')
                    .replace(/^\/+/, '');


                // ------------------------------------------------
                // Normalise and prevent directory traversal.
                // ------------------------------------------------

                logicalPath = path.posix.normalize(
                    logicalPath
                );

                while (
                    logicalPath.startsWith('../')
                ) {
                    logicalPath =
                        logicalPath.substring(3);
                }

                logicalPath =
                    logicalPath.replace(/^\/+/, '');


                if (
                    !logicalPath ||
                    logicalPath === '.'
                ) {
                    throw new Error(
                        `Invalid path for uploaded file: ${file.originalname}`
                    );
                }


                // ------------------------------------------------
                // Original filename
                // ------------------------------------------------

                const originalFilename =
                    path.posix.basename(logicalPath);


                if (!originalFilename) {
                    throw new Error(
                        `Invalid filename: ${logicalPath}`
                    );
                }


                // ------------------------------------------------
                // Relative directory
                // ------------------------------------------------

                let relativePath =
                    path.posix.dirname(logicalPath);

                if (relativePath === '.') {
                    relativePath = '';
                }


                // ------------------------------------------------
                // Optional filename override
                //
                // The key is the ORIGINAL logical path.
                // ------------------------------------------------

                const override =
                    filenameOverrides[logicalPath];


                let filename =
                    originalFilename;


                if (
                    typeof override === 'string' &&
                    override.trim()
                ) {

                    filename =
                        path.posix.basename(
                            override.trim()
                        );

                    if (!filename) {
                        throw new Error(
                            `Invalid filename override for ${logicalPath}`
                        );
                    }
                }


                // ------------------------------------------------
                // Final logical path.
                // ------------------------------------------------

                const finalLogicalPath =
                    relativePath
                        ? `${relativePath}/${filename}`
                        : filename;


                // ------------------------------------------------
                // Prevent two uploaded files from ending up at
                // exactly the same logical location.
                // ------------------------------------------------

                if (
                    logicalPaths.has(finalLogicalPath)
                ) {
                    throw new Error(
                        `Duplicate destination path: ${finalLogicalPath}`
                    );
                }

                logicalPaths.add(finalLogicalPath);


                processedFiles.push({
                    file,
                    filename,
                    relativePath
                });
            }


            // ----------------------------------------------------
            // Everything in the upload was a backup.
            //
            // Worth its own message: "no files uploaded" would be confusing
            // when the developer did select files, and naming them makes it
            // obvious what happened.
            // ----------------------------------------------------

            if (processedFiles.length === 0) {
                if (skippedBackups.length > 0) {
                    const shown = skippedBackups.slice(0, 5).join(', ');
                    const rest = skippedBackups.length > 5
                        ? ` and ${skippedBackups.length - 5} more`
                        : '';

                    throw new Error(
                        `Every file in this upload is a backup (${skippedBackups.length}): ` +
                        `${shown}${rest}. Backups are not uploaded — remove them and ` +
                        `try again.`
                    );
                }

                throw new Error('No usable files in this upload');
            }


            // ----------------------------------------------------
            // Find the developer's workspace
            // ----------------------------------------------------

            let workspace = db.prepare(`
                SELECT
                    id
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);


            if (!workspace) {

                const result = db.prepare(`
                    INSERT INTO developer_workspaces (
                        developer_id
                    )
                    VALUES (?)
                `).run(developerId);

                workspace = {
                    id: result.lastInsertRowid
                };
            }


            // ----------------------------------------------------
            // Three-tier match against the developer's existing
            // assets.
            //
            //   exact      the parsed name is an existing asset
            //   near       it differs only by case, separators,
            //              whitespace, or is within an edit
            //              distance of one -> ASK, because parsing
            //              is fuzzy and a forgotten capital or
            //              underscore is exactly when a developer
            //              does NOT mean to create a new asset
            //   different  genuinely new
            //
            // The confirmation arrives as confirmed_asset_name,
            // which must be one of the two names offered. Anything
            // else is refused rather than guessed at.
            // ----------------------------------------------------

            const existingAssetNames = db.prepare(`
                SELECT name
                FROM workspace_assets
                WHERE workspace_id = ?
                  AND is_active = 1
            `).all(workspace.id).map(r => r.name);

            const nameMatch =
                matchAssetName(existingAssetNames, parsedName.name);

            const confirmedName =
                String(req.body.confirmed_asset_name || '').trim();

            let assetName = parsedName.name;

            if (nameMatch.tier === 'near') {

                if (!confirmedName) {
                    const prompt = new Error(
                        `"${uploadName}" looks like it belongs to the existing ` +
                        `asset "${nameMatch.match}", but it is not an exact ` +
                        `match. Confirm which one you meant.`
                    );

                    prompt.status = 409;
                    prompt.details = {
                        reason: 'near_match',
                        upload_name: uploadName,
                        parsed_name: parsedName.name,
                        matched_name: nameMatch.match,
                        options: [parsedName.name, nameMatch.match],
                        message: prompt.message
                    };

                    throw prompt;
                }

                if (![parsedName.name, nameMatch.match].includes(confirmedName)) {
                    throw new Error(
                        `Confirmed name "${confirmedName}" is neither the name ` +
                        `in the upload ("${parsedName.name}") nor the existing ` +
                        `asset ("${nameMatch.match}").`
                    );
                }

                assetName = confirmedName;
            }


            // ----------------------------------------------------
            // Move new physical files and prepare their metadata.
            //
            // Existing identical files are reused.
            // ----------------------------------------------------

            // ----------------------------------------------------
            // Calculate SHA-256 for every uploaded file before
            // entering the database transaction.
            // ----------------------------------------------------

            async function calculateSha256(filePath) {
                return new Promise((resolve, reject) => {
                    const hash = crypto.createHash('sha256');
                    const stream = fs.createReadStream(filePath);

                    stream.on('error', reject);
                    stream.on('data', chunk => hash.update(chunk));
                    stream.on('end', () => {
                        resolve(hash.digest('hex'));
                    });
                });
            }


            for (const item of processedFiles) {
                item.sha256 =
                    await calculateSha256(item.file.path);
            }


            // ----------------------------------------------------
            // Quota check.
            //
            // Runs BEFORE anything is written, so a refusal leaves no partial
            // state — no temp files moved, no rows inserted.
            //
            // The delta is the size of content this upload would newly commit
            // the workspace to holding: not already held by the workspace, and
            // not already game-owned. Duplicates within one upload are counted
            // once.
            // ----------------------------------------------------

            const usage = workspaceUsage(workspace.id);

            let addedBytes = 0;
            const countedInThisUpload = new Set();

            for (const item of processedFiles) {
                const sha = item.sha256;

                if (countedInThisUpload.has(sha)) continue;
                if (shaInGameStore.get(sha)) continue;
                if (shaHeldByWorkspace.get(workspace.id, sha)) continue;

                addedBytes += item.file.size;
                countedInThisUpload.add(sha);
            }

            const projectedBytes = usage.bytes + addedBytes;

            if (projectedBytes > WORKSPACE_LIMIT_BYTES) {
                const quotaError = new Error(
                    `This upload would take the workspace to ${formatBytes(projectedBytes)}, ` +
                    `over the ${formatBytes(WORKSPACE_LIMIT_BYTES)} limit. ` +
                    `It is currently using ${formatBytes(usage.bytes)}, and this upload ` +
                    `adds ${formatBytes(addedBytes)} of content the workspace does not ` +
                    `already hold. Delete something from the workspace, or reduce ` +
                    `what is being uploaded.`
                );
                quotaError.status = 413;
                throw quotaError;
            }


            // ----------------------------------------------------
            // Permanent content storage directory.
            // ----------------------------------------------------

            const storageDir =
                path.join(
                    __dirname,
                    '../uploads/files'
                );

            fs.mkdirSync(
                storageDir,
                { recursive: true }
            );


            // ----------------------------------------------------
            // Everything below is one SQLite transaction.
            //
            // IMMEDIATE is important:
            //
            // Once this transaction starts, another writer cannot
            // enter its own write transaction until this one has
            // finished.
            //
            // The physical content-store operation therefore occurs
            // while the database write lock is held.
            // ----------------------------------------------------

            const createAssetVersion =
                db.transaction(() => {

                    // Physical files created by THIS transaction.
                    //
                    // If anything below fails, these are removed
                    // before the SQLite transaction is allowed to
                    // roll back and release its write lock.
                    const newlyStoredPaths = [];

                    try {

                        // --------------------------------------------
                        // Find existing workspace asset
                        // --------------------------------------------

                        let asset = db.prepare(`
                            SELECT
                                id,
                                name,
                                asset_type,
                                description,
                                created_at,
                                updated_at,
                                is_active
                            FROM workspace_assets
                            WHERE workspace_id = ?
                              AND name = ?
                        `).get(
                            workspace.id,
                            assetName
                        );


                        // --------------------------------------------
                        // Create asset if it doesn't exist.
                        // --------------------------------------------

                        if (!asset) {

                            const result = db.prepare(`
                                INSERT INTO workspace_assets (
                                    workspace_id,
                                    name,
                                    asset_type,
                                    category,
                                    description
                                )
                                VALUES (?, ?, ?, ?, ?)
                            `).run(
                                workspace.id,
                                assetName,
                                assetType || null,
                                category,
                                description || null
                            );


                            asset = db.prepare(`
                                SELECT
                                    id,
                                    name,
                                    asset_type,
                                    category,
                                    description,
                                    created_at,
                                    updated_at,
                                    is_active
                                FROM workspace_assets
                                WHERE id = ?
                            `).get(
                                result.lastInsertRowid
                            );

                        } else {

                            // ----------------------------------------
                            // An asset under review is frozen.
                            //
                            // While a creative approval is pending the asset
                            // accepts no changes at all — not a new version and
                            // not a metadata edit. The submitted version is
                            // already locked by creative_locked; this extends
                            // the freeze to the asset around it, so what the
                            // approver is looking at cannot shift underneath
                            // them.
                            //
                            // This runs inside the write transaction, so it
                            // cannot race a concurrent approval request.
                            // ----------------------------------------

                            const pending = db.prepare(`
                                SELECT id
                                FROM creative_approvals
                                WHERE workspace_asset_id = ?
                                  AND status = 'pending'
                                LIMIT 1
                            `).get(asset.id);

                            if (pending) {
                                const freezerError = new Error(
                                    `"${asset.name}" is under review and cannot be ` +
                                    `changed until the pending approval is decided.`
                                );
                                freezerError.status = 409;
                                throw freezerError;
                            }


                            // ----------------------------------------
                            // Update supplied metadata.
                            // ----------------------------------------

                            db.prepare(`
                                UPDATE workspace_assets
                                SET
                                    asset_type =
                                        COALESCE(?, asset_type),

                                    category =
                                        COALESCE(?, category),

                                    description =
                                        COALESCE(?, description),

                                    updated_at =
                                        CURRENT_TIMESTAMP

                                WHERE id = ?
                            `).run(
                                assetType || null,
                                category,
                                description || null,
                                asset.id
                            );


                            asset = db.prepare(`
                                SELECT
                                    id,
                                    name,
                                    asset_type,
                                    category,
                                    description,
                                    created_at,
                                    updated_at,
                                    is_active
                                FROM workspace_assets
                                WHERE id = ?
                            `).get(asset.id);
                        }


                        // --------------------------------------------
                        // Find next workspace version number.
                        // --------------------------------------------

                        const latestVersion =
                            db.prepare(`
                                SELECT
                                    MAX(version_number)
                                        AS version_number
                                FROM workspace_versions
                                WHERE workspace_asset_id = ?
                            `).get(asset.id);


                        const versionNumber =
                            (latestVersion?.version_number || 0) + 1;


                        // --------------------------------------------
                        // Create workspace version.
                        // --------------------------------------------

                        const versionResult =
                            db.prepare(`
                                INSERT INTO workspace_versions (
                                    workspace_asset_id,
                                    version_number,
                                    created_by,
                                    version_note
                                )
                                VALUES (?, ?, ?, ?)
                            `).run(
                                asset.id,
                                versionNumber,
                                developerId,
                                versionNote
                            );


                        const versionId =
                            versionResult.lastInsertRowid;


                        // --------------------------------------------
                        // Prepare stored_files statements.
                        // --------------------------------------------

                        const getStoredFile =
                            db.prepare(`
                                SELECT
                                    id,
                                    sha256,
                                    file_size,
                                    storage_key,
                                    mime_type,
                                    created_at
                                FROM stored_files
                                WHERE sha256 = ?
                            `);


                        const insertStoredFile =
                            db.prepare(`
                                INSERT INTO stored_files (
                                    sha256,
                                    file_size,
                                    storage_key,
                                    mime_type
                                )
                                VALUES (?, ?, ?, ?)
                            `);


                        const insertVersionFile =
                            db.prepare(`
                                INSERT INTO workspace_version_files (
                                    workspace_version_id,
                                    stored_file_id,
                                    filename,
                                    relative_path
                                )
                                VALUES (?, ?, ?, ?)
                            `);


                        // --------------------------------------------
                        // Process every uploaded file.
                        //
                        // The database write lock is already held.
                        // --------------------------------------------

                        for (const item of processedFiles) {

                            const file = item.file;
                            const sha256 = item.sha256;

                            let storedFile =
                                getStoredFile.get(sha256);


                            // ----------------------------------------
                            // Existing content.
                            // ----------------------------------------

                            if (storedFile) {

                                const storagePath =
                                    path.join(
                                        storageDir,
                                        storedFile.storage_key
                                    );


                                // The database says the file exists.
                                // If the physical file is missing, repair
                                // it from this upload.
                                if (!fs.existsSync(storagePath)) {

                                    fs.linkSync(
                                        file.path,
                                        storagePath
                                    );
                                }


                            } else {

                                // ------------------------------------
                                // New content.
                                // ------------------------------------

                                const storageKey = sha256;

                                const storagePath =
                                    path.join(
                                        storageDir,
                                        storageKey
                                    );


                                // Normally this path cannot already
                                // exist because the database transaction
                                // serialises all upload writers.
                                //
                                // If it does exist, it is an untracked
                                // physical file left by an earlier failed
                                // operation. Replace it with the verified
                                // temporary upload.
                                if (fs.existsSync(storagePath)) {

                                    fs.unlinkSync(storagePath);
                                }


                                // Create the canonical physical file.
                                //
                                // This is a hard link, not a file copy.
                                // It is therefore effectively an atomic
                                // creation of the content-store entry.
                                fs.linkSync(
                                    file.path,
                                    storagePath
                                );


                                newlyStoredPaths.push(
                                    storagePath
                                );


                                // Create its database identity.
                                insertStoredFile.run(
                                    sha256,
                                    file.size,
                                    storageKey,
                                    file.mimetype
                                );


                                storedFile =
                                    getStoredFile.get(sha256);
                            }


                            if (!storedFile) {
                                throw new Error(
                                    `Unable to create stored file record for ${sha256}`
                                );
                            }


                            // ----------------------------------------
                            // Connect the content to this workspace
                            // version.
                            // ----------------------------------------

                            insertVersionFile.run(
                                versionId,
                                storedFile.id,
                                item.filename,
                                item.relativePath || null
                            );
                        }


                        // --------------------------------------------
                        // Return the newly-created records.
                        // --------------------------------------------

                        const version =
                            db.prepare(`
                                SELECT
                                    id,
                                    workspace_asset_id,
                                    version_number,
                                    created_by,
                                    version_note,
                                    created_at
                                FROM workspace_versions
                                WHERE id = ?
                            `).get(versionId);


                        const files =
                            db.prepare(`
                                SELECT
                                    wvf.id,
                                    wvf.stored_file_id,
                                    wvf.filename,
                                    wvf.relative_path
                                FROM workspace_version_files wvf
                                WHERE wvf.workspace_version_id = ?
                                ORDER BY
                                    wvf.relative_path,
                                    wvf.filename
                            `).all(versionId);


                        return {
                            asset,
                            version,
                            files
                        };


                    } catch (err) {

                        // --------------------------------------------
                        // IMPORTANT:
                        //
                        // We are still inside the SQLite transaction
                        // here. No other upload transaction can have
                        // started using these content-store paths.
                        // --------------------------------------------

                        for (
                            const storagePath of
                            newlyStoredPaths
                        ) {

                            try {
                                fs.unlinkSync(storagePath);
                            } catch (cleanupError) {
                                console.error(
                                    'Failed to remove newly-created content file:',
                                    storagePath,
                                    cleanupError
                                );
                            }
                        }

                        throw err;
                    }
                });


            // ----------------------------------------------------
            // Start the transaction as an IMMEDIATE transaction.
            // ----------------------------------------------------

            const result =
                  createAssetVersion.immediate();

           for (const tempPath of tempPaths) {

                try {
                    await fs.promises.unlink(tempPath);
                } catch (err_) {
                    // Temporary file may already have been removed.
                    // This does not invalidate the successful upload.
                }
            }

            return res.status(201).json({
                status: 'created',
                // Backups were found and dropped. Said out loud so the
                // developer is not left wondering why the file count differs
                // from what they selected.
                skipped_backups: skippedBackups,
                ...result
            });


        } catch (err) {

            console.error(
                'Developer asset upload error:',
                err
            );


            // ----------------------------------------------------
            // Remove temporary files which were not moved.
            // ----------------------------------------------------

            for (const tempPath of tempPaths) {

                try {
                    await fs.promises.unlink(tempPath);
                } catch (err_) {
                    // Already deleted or moved.
                }
            }

            console.error(
                'Developer asset upload failed:',
                err.message
            );


            // Errors raised deliberately carry their own status — the freeze
            // check (409), a blocked name (422), and the near-match prompt
            // (409, with details the client needs to ask the right question).
            // Everything else stays a 400 as before.
            return res.status(err.status || 400).json({
                error:
                    err.message ||
                    'Failed to process uploaded files',
                ...(err.details ? { details: err.details } : {})
            });
        }
    }
);





// ============================================================
// TECHNICAL VALIDATION
// ============================================================
//
// Runs automated technical checks against ONE workspace
// version.
//
// Technical validation is private to the developer.
//
// It does NOT:
//   - lock the version
//   - request Creative Approval
//   - publish anything
//
// The developer may run it repeatedly.
// ============================================================

router.post(
    '/assets/:assetId/versions/:versionId/technical-check',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {

        const developerId =
            req.user?.id;

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        const assetId =
            Number(req.params.assetId);

        const versionId =
            Number(req.params.versionId);

        if (
            !Number.isInteger(assetId) ||
            !Number.isInteger(versionId)
        ) {
            return res.status(400).json({
                error: 'Invalid asset or version ID'
            });
        }

        try {

            // ----------------------------------------------------
            // Find the developer's workspace
            // ----------------------------------------------------

            const workspace = db.prepare(`
                SELECT id
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);

            if (!workspace) {
                return res.status(404).json({
                    error: 'Developer workspace not found'
                });
            }


            // ----------------------------------------------------
            // Find the requested version and make sure it belongs
            // to this developer's workspace.
            // ----------------------------------------------------

            const version = db.prepare(`
                SELECT
                    wv.id,
                    wv.workspace_asset_id,
                    wv.version_number,
                    wv.version_note,
                    wv.created_by,
                    wv.created_at,
                    wv.creative_locked,
                    wa.name AS asset_name,
                    wa.workspace_id
                FROM workspace_versions wv
                JOIN workspace_assets wa
                    ON wa.id = wv.workspace_asset_id
                WHERE wv.id = ?
                  AND wv.workspace_asset_id = ?
                  AND wa.id = ?
                  AND wa.workspace_id = ?
                  AND wa.is_active = 1
            `).get(
                versionId,
                assetId,
                assetId,
                workspace.id
            );

            if (!version) {
                return res.status(404).json({
                    error: 'Workspace version not found'
                });
            }


            // ----------------------------------------------------
            // A locked version is immutable.
            //
            // There is no reason to run a new technical check
            // against an immutable accepted version.
            // ----------------------------------------------------

            if (version.creative_locked) {
                return res.status(409).json({
                    error:
                        'This workspace version is locked and cannot be validated again.'
                });
            }


            // ----------------------------------------------------
            // Create technical check run.
            // ----------------------------------------------------

            const runResult = db.prepare(`
                INSERT INTO technical_check_runs (
                    workspace_asset_id,
                    workspace_version_id,
                    started_by,
                    status
                )
                VALUES (?, ?, ?, 'running')
            `).run(
                assetId,
                versionId,
                developerId
            );

            const runId =
                runResult.lastInsertRowid;


            // ----------------------------------------------------
            // Technical checks
            //
            // These are deliberately basic for the first
            // implementation. The validation framework can be
            // expanded later with asset-specific validators.
            // ----------------------------------------------------

            const files = db.prepare(`
                SELECT
                    wvf.id,
                    wvf.filename,
                    wvf.relative_path,
                    wvf.stored_file_id,
                    sf.sha256,
                    sf.file_size,
                    sf.storage_key,
                    sf.mime_type
                FROM workspace_version_files wvf
                JOIN stored_files sf
                    ON sf.id = wvf.stored_file_id
                WHERE wvf.workspace_version_id = ?
                ORDER BY
                    COALESCE(wvf.relative_path, ''),
                    wvf.filename
            `).all(versionId);


            const results = [];


            // ----------------------------------------------------
            // Check: version contains files
            // ----------------------------------------------------

            if (files.length === 0) {

                results.push({
                    name: 'files_present',
                    status: 'failed',
                    message:
                        'The workspace version contains no files.'
                });

            } else {

                results.push({
                    name: 'files_present',
                    status: 'passed',
                    message:
                        `${files.length} file(s) found.`
                });
            }


            // ----------------------------------------------------
            // Check each stored file.
            // ----------------------------------------------------

            for (const file of files) {

                const storagePath =
                    path.join(
                        __dirname,
                        '../uploads/files',
                        file.storage_key
                    );


                let exists = false;

                try {

                    const stat =
                        await fs.promises.stat(
                            storagePath
                        );

                    exists =
                        stat.isFile() &&
                        stat.size === file.file_size;

                } catch (err) {

                    exists = false;
                }


                results.push({
                    name:
                        `stored_file:${file.id}`,

                    status:
                        exists
                            ? 'passed'
                            : 'failed',

                    message:
                        exists
                            ? `Physical file exists and size matches: ${file.filename}`
                            : `Physical file is missing or its size does not match: ${file.filename}`
                });
            }


            // ----------------------------------------------------
            // Check logical paths.
            // ----------------------------------------------------

            const logicalPaths =
                new Set();

            let duplicatePaths = false;


            for (const file of files) {

                const logicalPath =
                    file.relative_path
                        ? `${file.relative_path}/${file.filename}`
                        : file.filename;


                if (logicalPaths.has(logicalPath)) {
                    duplicatePaths = true;
                    break;
                }

                logicalPaths.add(logicalPath);
            }


            results.push({
                name: 'logical_paths_unique',

                status:
                    duplicatePaths
                        ? 'failed'
                        : 'passed',

                message:
                    duplicatePaths
                        ? 'Duplicate logical file paths detected.'
                        : 'All logical file paths are unique.'
            });


            // ----------------------------------------------------
            // Check: every file is a type we recognise.
            //
            // ONE FUNCTION DECIDES WHAT A FILE IS — assetTypeOf() in
            // shared/assetRules.mjs. This does not keep its own list of
            // extensions and neither does anywhere else; the check is simply
            // where the answer gets recorded and reported.
            //
            // An unrecognised extension FAILS the run rather than being
            // ignored. It means nobody can say what the file is, and a
            // technical check that shrugs at that is not checking anything.
            // ----------------------------------------------------

            const typeCounts = new Map();
            const unrecognised = [];

            for (const file of files) {
                const type = assetTypeOf(file.filename);

                if (!type) {
                    unrecognised.push(file.filename);
                    continue;
                }

                typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
            }

            const typesFound = [...typeCounts.keys()].sort();

            results.push({
                name: 'asset_types_recognised',

                status: unrecognised.length ? 'failed' : 'passed',

                message: unrecognised.length
                    ? `Unrecognised file type(s): ${unrecognised.join(', ')}`
                    : `${files.length} file(s) recognised: ${typesFound.join(', ')}.`
            });


            // ----------------------------------------------------
            // Check: no file is empty.
            //
            // A zero-byte file passes every other check here — it exists, its
            // size matches what was recorded, its path is unique — and it is
            // never a real asset. It is a failed export, an interrupted write,
            // or a placeholder someone meant to come back to.
            //
            // The size is read from stored_files, which the per-file check
            // above has already compared against the file on disk. So a
            // recorded zero is a real zero, not a stale row.
            // ----------------------------------------------------

            const emptyFiles = files
                .filter(file => !file.file_size)
                .map(file => file.filename);

            results.push({
                name: 'files_not_empty',

                status: emptyFiles.length ? 'failed' : 'passed',

                message: emptyFiles.length
                    ? `Empty file(s) — 0 bytes: ${emptyFiles.join(', ')}`
                    : 'No file is empty.'
            });


            // ----------------------------------------------------
            // Check: is each file what its NAME says it is?
            //
            // The extension is a claim. checkFileContent() reads the first
            // bytes and answers in one of four ways — and the fourth is the
            // important one:
            //
            //   confirmed      the bytes match a signature this extension may
            //                  have
            //   contradicted   they match something ELSE. The name is wrong, or
            //                  the file is not what it claims.
            //   blocked        refused content, whatever it is called
            //   unverifiable   nothing reliable to check against
            //
            // UNVERIFIABLE IS NOT A PASS. A file the system cannot vouch for is
            // reported as such rather than counted as good; a tick that cannot
            // fail tells a reviewer nothing, and telling them nothing while
            // looking like approval is worse than saying so.
            //
            // Read-only, and only the first SIGNATURE_HEAD_BYTES of each file.
            // Nothing here executes, parses or interprets what it reads.
            // ----------------------------------------------------

            const blocked = [];
            const contradicted = [];
            const unverifiable = [];
            let confirmed = 0;

            for (const file of files) {

                const storagePath = path.join(
                    __dirname,
                    '../uploads/files',
                    file.storage_key
                );

                let head;

                try {
                    const handle = await fs.promises.open(storagePath, 'r');

                    try {
                        const buffer = Buffer.alloc(SIGNATURE_HEAD_BYTES);
                        const { bytesRead } =
                            await handle.read(buffer, 0, SIGNATURE_HEAD_BYTES, 0);

                        head = buffer.subarray(0, bytesRead);
                    } finally {
                        await handle.close();
                    }

                } catch (err) {
                    // Unreadable here is already reported by the per-file check
                    // above; this one simply has nothing to say about it.
                    continue;
                }

                const verdict = checkFileContent(
                    extensionOf(file.filename),
                    head
                );

                if (verdict.outcome === 'blocked') {
                    blocked.push(`${file.filename} (${verdict.actual})`);
                } else if (verdict.outcome === 'contradicted') {
                    contradicted.push(
                        verdict.actual
                            ? `${file.filename} (looks like ${verdict.actual}, not ${verdict.expected})`
                            : `${file.filename} (not ${verdict.expected})`
                    );
                } else if (verdict.outcome === 'unverifiable') {
                    unverifiable.push(file.filename);
                } else {
                    confirmed++;
                }
            }


            // Reported separately from a mismatch, because they are different
            // things. A .png that is really a JPEG is a mislabelled asset. A
            // .png that is really a Windows executable is not an asset at all,
            // and burying the two in one list would hide the one that matters.
            results.push({
                name: 'no_executable_content',

                status: blocked.length ? 'failed' : 'passed',

                message: blocked.length
                    ? `Refused content, whatever the file is called: ${blocked.join('; ')}`
                    : 'No file contains executable content.'
            });


            // The count is ALWAYS reported, and so is the unverifiable list —
            // including when something failed. Dropping it on failure would
            // hide the fact that most of the upload was never actually checked,
            // which is the one thing a reviewer must not be left guessing at.
            const contentSummary =
                `${confirmed} of ${files.length} file(s) verified against their extension.` +
                (unverifiable.length
                    ? ` ${unverifiable.length} could not be verified — no reliable ` +
                      `signature for the format: ${unverifiable.join(', ')}`
                    : '');

            results.push({
                name: 'content_matches_extension',

                status: contradicted.length ? 'failed' : 'passed',

                message: contradicted.length
                    ? `Content does not match the file name: ${contradicted.join('; ')}. ` +
                      contentSummary
                    : contentSummary
            });


            // ----------------------------------------------------
            // Record the asset's type, WHEN THERE IS ONE ANSWER.
            //
            // Only when every file in the version is the same type. An asset
            // holding a .blend and forty .png textures has no single type, and
            // picking the most common would report "Image" for something
            // everybody would call a Blender asset — a confident wrong answer,
            // which is worse than none. The per-file types are in the check
            // message above, so nothing is lost by leaving the column null.
            // ----------------------------------------------------

            const singleType =
                typeCounts.size === 1 ? [...typeCounts.keys()][0] : null;

            // COALESCE, so an ambiguous version cannot WIPE a type an earlier
            // version established. Mixed content means "no new answer", not
            // "the answer is now nothing".
            db.prepare(`
                UPDATE workspace_assets
                SET asset_type = COALESCE(?, asset_type)
                WHERE id = (
                    SELECT workspace_asset_id
                    FROM workspace_versions
                    WHERE id = ?
                )
            `).run(singleType, versionId);


            // ----------------------------------------------------
            // Determine overall result.
            // ----------------------------------------------------

            const failed =
                results.some(
                    result =>
                        result.status === 'failed'
                );

            const finalStatus =
                failed
                    ? 'failed'
                    : 'passed';


            // ----------------------------------------------------
            // Store individual results.
            // ----------------------------------------------------

            const insertResult =
                db.prepare(`
                    INSERT INTO technical_check_results (
                        technical_check_run_id,
                        check_name,
                        status,
                        message
                    )
                    VALUES (?, ?, ?, ?)
                `);


            const storeResults =
                db.transaction(() => {

                    for (const result of results) {

                        insertResult.run(
                            runId,
                            result.name,
                            result.status,
                            result.message
                        );
                    }


                    db.prepare(`
                        UPDATE technical_check_runs
                        SET
                            status = ?,
                            completed_at = CURRENT_TIMESTAMP,
                            summary = ?
                        WHERE id = ?
                    `).run(
                        finalStatus,

                        failed
                            ? 'Technical validation failed.'
                            : 'Technical validation passed.',

                        runId
                    );
                });


            storeResults();


            const completedRun =
                db.prepare(`
                    SELECT
                        id,
                        workspace_asset_id,
                        workspace_version_id,
                        started_by,
                        status,
                        started_at,
                        completed_at,
                        summary
                    FROM technical_check_runs
                    WHERE id = ?
                `).get(runId);


            const checkResults =
                db.prepare(`
                    SELECT
                        id,
                        check_name,
                        status,
                        message,
                        details,
                        started_at,
                        completed_at
                    FROM technical_check_results
                    WHERE technical_check_run_id = ?
                    ORDER BY id
                `).all(runId);


            return res.json({
                status: finalStatus,
                run: completedRun,
                results: checkResults
            });


        } catch (err) {

            console.error(
                'Technical validation failed:',
                err
            );


            return res.status(500).json({
                error:
                    'Technical validation failed'
            });
        }
    }
);


// ============================================================
// REQUEST CREATIVE APPROVAL
// ============================================================
//
// The developer explicitly submits ONE workspace version.
//
// Requirements:
//
//   - version belongs to this developer
//   - version is not already locked
//   - technical validation has passed
//   - no existing pending approval
//
// The specific version is then locked.
//
// The workspace asset itself remains completely editable.
// ============================================================

router.post(
    '/assets/:assetId/versions/:versionId/creative-approval',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {

        const developerId =
            req.user?.id;

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        const assetId =
            Number(req.params.assetId);

        const versionId =
            Number(req.params.versionId);

        if (
            !Number.isInteger(assetId) ||
            !Number.isInteger(versionId)
        ) {
            return res.status(400).json({
                error: 'Invalid asset or version ID'
            });
        }


        const requestComment =
            String(
                req.body?.request_comment || ''
            ).trim();


        try {

            const workspace = db.prepare(`
                SELECT id
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);

            if (!workspace) {
                return res.status(404).json({
                    error: 'Developer workspace not found'
                });
            }


            const version = db.prepare(`
                SELECT
                    wv.id,
                    wv.workspace_asset_id,
                    wv.version_number,
                    wv.creative_locked,
                    wa.name AS asset_name
                FROM workspace_versions wv
                JOIN workspace_assets wa
                    ON wa.id = wv.workspace_asset_id
                WHERE wv.id = ?
                  AND wv.workspace_asset_id = ?
                  AND wa.workspace_id = ?
                  AND wa.is_active = 1
            `).get(
                versionId,
                assetId,
                workspace.id
            );


            if (!version) {
                return res.status(404).json({
                    error: 'Workspace version not found'
                });
            }


            if (version.creative_locked) {
                return res.status(409).json({
                    error:
                        'This workspace version is already locked.'
                });
            }


            // ----------------------------------------------------
            // Require a successful technical validation for this
            // exact version.
            // ----------------------------------------------------

            const technicalPass =
                db.prepare(`
                    SELECT id
                    FROM technical_check_runs
                    WHERE workspace_version_id = ?
                      AND status = 'passed'
                    ORDER BY completed_at DESC, id DESC
                    LIMIT 1
                `).get(versionId);


            if (!technicalPass) {
                return res.status(409).json({
                    error:
                        'This version must pass Technical Validation before Creative Approval can be requested.'
                });
            }


            // ----------------------------------------------------
            // Make sure another approval is not already pending.
            // ----------------------------------------------------

            const pendingApproval =
                db.prepare(`
                    SELECT id
                    FROM creative_approvals
                    WHERE workspace_version_id = ?
                      AND status = 'pending'
                    LIMIT 1
                `).get(versionId);


            if (pendingApproval) {
                return res.status(409).json({
                    error:
                        'Creative Approval has already been requested for this version.'
                });
            }


            // ----------------------------------------------------
            // Lock this specific version and create approval
            // request atomically.
            // ----------------------------------------------------

            const submit =
                db.transaction(() => {

                    db.prepare(`
                        UPDATE workspace_versions
                        SET
                            creative_locked = 1,
                            locked_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(versionId);


                    const result =
                        db.prepare(`
                            INSERT INTO creative_approvals (
                                workspace_asset_id,
                                workspace_version_id,
                                requested_by,
                                status,
                                request_comment
                            )
                            VALUES (?, ?, ?, 'pending', ?)
                        `).run(
                            assetId,
                            versionId,
                            developerId,
                            requestComment || null
                        );


                    return result.lastInsertRowid;
                });

            // db.transaction() RETURNS a function; it does not run it. This
            // result was passed straight to .get() below, so the insert never
            // happened and the bind failed with "can only bind numbers,
            // strings, bigints, buffers, and null" — the function itself was
            // being offered as a parameter value.
            //
            // Every other transaction in this file is invoked:
            // createAssetVersion.immediate(), storeResults(), reject(), and
            // the immediately-invoked `})()` in the approve route.
            const approvalId = submit();

            const approval =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(approvalId);


            return res.status(201).json({
                status: 'pending',
                approval
            });


        } catch (err) {

            console.error(
                'Creative Approval request failed:',
                err
            );


            return res.status(500).json({
                error:
                    'Failed to request Creative Approval'
            });
        }
    }
);


// ============================================================
// REJECT CREATIVE APPROVAL
// ============================================================
//
// Director/admin/superuser rejects the specific submitted
// workspace version.
//
// That version becomes editable again.
//
// Other versions of the same workspace asset are unaffected.
// ============================================================

router.post(
    '/creative-approvals/:approvalId/reject',
    authenticateToken,
    requireRole('admin', 'superuser'),

    async (req, res) => {

        const approvalId =
            Number(req.params.approvalId);

        const decidedBy =
            req.user?.id;

        if (!decidedBy) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        if (!Number.isInteger(approvalId)) {
            return res.status(400).json({
                error: 'Invalid approval ID'
            });
        }


        const decisionComment =
            String(
                req.body?.decision_comment || ''
            ).trim();


        try {

            const approval =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(approvalId);


            if (!approval) {
                return res.status(404).json({
                    error: 'Creative Approval not found'
                });
            }


            if (approval.status !== 'pending') {
                return res.status(409).json({
                    error:
                        `Creative Approval is already ${approval.status}.`
                });
            }


            const reject =
                db.transaction(() => {

                    db.prepare(`
                        UPDATE creative_approvals
                        SET
                            status = 'rejected',
                            decided_by = ?,
                            decision_comment = ?,
                            decided_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        decidedBy,
                        decisionComment || null,
                        approvalId
                    );


                    db.prepare(`
                        UPDATE workspace_versions
                        SET
                            creative_locked = 0,
                            locked_at = NULL
                        WHERE id = ?
                    `).run(
                        approval.workspace_version_id
                    );
                });


            reject();


            const updated =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(approvalId);


            return res.json({
                status: 'rejected',
                approval: updated
            });


        } catch (err) {

            console.error(
                'Creative Approval rejection failed:',
                err
            );


            return res.status(500).json({
                error:
                    'Failed to reject Creative Approval'
            });
        }
    }
);


// ============================================================
// APPROVE CREATIVE APPROVAL
// ============================================================
//
// Director/admin/superuser approves ONE specific workspace
// version.
//
// This creates an immutable repository version.
//
// The workspace version remains locked.
//
// IMPORTANT:
// If the workspace asset is not already associated with a
// repository asset, this creates a NEW repository asset.
//
// If a repository asset already exists with the same name but
// there is no explicit association, approval is rejected rather
// than accidentally attaching the work to the wrong asset.
//
// Collision handling will be added separately.
// ============================================================

router.post(
    '/creative-approvals/:approvalId/approve',
    authenticateToken,
    requireRole('admin', 'superuser'),

    async (req, res) => {

        const approvalId =
            Number(req.params.approvalId);

        const decidedBy =
            req.user?.id;

        if (!decidedBy) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        if (!Number.isInteger(approvalId)) {
            return res.status(400).json({
                error: 'Invalid approval ID'
            });
        }


        const decisionComment =
            String(
                req.body?.decision_comment || ''
            ).trim();


        try {

            const approval =
                db.prepare(`
                    SELECT
                        ca.*,

                        wa.name AS workspace_asset_name,
                        wa.asset_type AS workspace_asset_type,
                        wa.category AS workspace_asset_category,
                        wa.description AS workspace_asset_description,

                        wv.version_number,
                        wv.version_note,
                        wv.creative_locked,
                        wv.repository_version_id

                    FROM creative_approvals ca

                    JOIN workspace_assets wa
                        ON wa.id = ca.workspace_asset_id

                    JOIN workspace_versions wv
                        ON wv.id = ca.workspace_version_id

                    WHERE ca.id = ?
                `).get(approvalId);


            if (!approval) {
                return res.status(404).json({
                    error: 'Creative Approval not found'
                });
            }


            if (approval.status !== 'pending') {
                return res.status(409).json({
                    error:
                        `Creative Approval is already ${approval.status}.`
                });
            }


            if (!approval.creative_locked) {
                return res.status(409).json({
                    error:
                        'The submitted workspace version is not locked.'
                });
            }


            const result =
                db.transaction(() => {

                    let repositoryAsset = null;


                    // ------------------------------------------------
                    // If this workspace asset was explicitly derived
                    // from an existing repository asset, use it.
                    // ------------------------------------------------

                    const workspaceAsset =
                        db.prepare(`
                            SELECT
                                repository_asset_id
                            FROM workspace_assets
                            WHERE id = ?
                        `).get(
                            approval.workspace_asset_id
                        );


                    if (
                        workspaceAsset?.repository_asset_id
                    ) {

                        repositoryAsset =
                            db.prepare(`
                                SELECT *
                                FROM assets
                                WHERE id = ?
                                  AND is_active = 1
                            `).get(
                                workspaceAsset.repository_asset_id
                            );


                        if (!repositoryAsset) {
                            throw new Error(
                                'The repository asset associated with this workspace asset no longer exists.'
                            );
                        }


                        // --------------------------------------------
                        // Carry the category across.
                        //
                        // COALESCE so an acceptance never clears a
                        // category the repository already has: the
                        // sandbox value fills a blank, and a sandbox
                        // asset the developer never categorised
                        // leaves whatever was there alone.
                        // --------------------------------------------

                        db.prepare(`
                            UPDATE assets
                            SET category =
                                COALESCE(?, category)
                            WHERE id = ?
                        `).run(
                            approval.workspace_asset_category || null,
                            repositoryAsset.id
                        );

                    } else {

                        // --------------------------------------------
                        // This is a new repository asset.
                        //
                        // Do NOT silently attach it to an existing
                        // asset merely because the names match.
                        // --------------------------------------------

                        const sameName =
                            db.prepare(`
                                SELECT id
                                FROM assets
                                WHERE name = ?
                            `).get(
                                approval.workspace_asset_name
                            );


                        if (sameName) {
                            throw new Error(
                                'A repository asset with this name already exists, but this workspace asset is not associated with it.'
                            );
                        }


                        const assetResult =
                            db.prepare(`
                                INSERT INTO assets (
                                    name,
                                    asset_type,
                                    category,
                                    description
                                )
                                VALUES (?, ?, ?, ?)
                            `).run(
                                approval.workspace_asset_name,
                                approval.workspace_asset_type || null,
                                approval.workspace_asset_category || null,
                                approval.workspace_asset_description || null
                            );


                        repositoryAsset =
                            db.prepare(`
                                SELECT *
                                FROM assets
                                WHERE id = ?
                            `).get(
                                assetResult.lastInsertRowid
                            );


                        // --------------------------------------------
                        // Record the permanent ancestry.
                        // --------------------------------------------

                        db.prepare(`
                            UPDATE workspace_assets
                            SET
                                repository_asset_id = ?
                            WHERE id = ?
                        `).run(
                            repositoryAsset.id,
                            approval.workspace_asset_id
                        );
                    }


                    // ------------------------------------------------
                    // Find next repository version.
                    // ------------------------------------------------

                    const latestRepositoryVersion =
                        db.prepare(`
                            SELECT
                                MAX(version_number)
                                    AS version_number
                            FROM asset_versions
                            WHERE asset_id = ?
                        `).get(
                            repositoryAsset.id
                        );


                    const repositoryVersionNumber =
                        (
                            latestRepositoryVersion?.version_number ||
                            0
                        ) + 1;


                    // ------------------------------------------------
                    // Create immutable repository version.
                    // ------------------------------------------------

                    const repositoryVersionResult =
                        db.prepare(`
                            INSERT INTO asset_versions (
                                asset_id,
                                version_number,
                                created_by,
                                version_note
                            )
                            VALUES (?, ?, ?, ?)
                        `).run(
                            repositoryAsset.id,
                            repositoryVersionNumber,
                            decidedBy,
                            approval.version_note
                        );


                    const repositoryVersionId =
                        repositoryVersionResult.lastInsertRowid;


                    // ------------------------------------------------
                    // Copy the logical file references.
                    //
                    // The physical stored_files records are NOT
                    // copied. They are shared by content hash.
                    // ------------------------------------------------

                    db.prepare(`
                        INSERT INTO asset_version_files (
                            asset_version_id,
                            stored_file_id,
                            filename,
                            relative_path
                        )
                        SELECT
                            ?,
                            stored_file_id,
                            filename,
                            relative_path
                        FROM workspace_version_files
                        WHERE workspace_version_id = ?
                    `).run(
                        repositoryVersionId,
                        approval.workspace_version_id
                    );


                    // ------------------------------------------------
                    // Link the workspace version permanently to the
                    // repository version.
                    // ------------------------------------------------

                    db.prepare(`
                        UPDATE workspace_versions
                        SET
                            repository_version_id = ?,
                            creative_locked = 1,
                            locked_at = COALESCE(
                                locked_at,
                                CURRENT_TIMESTAMP
                            )
                        WHERE id = ?
                    `).run(
                        repositoryVersionId,
                        approval.workspace_version_id
                    );


                    // ------------------------------------------------
                    // Complete Creative Approval.
                    // ------------------------------------------------

                    db.prepare(`
                        UPDATE creative_approvals
                        SET
                            status = 'approved',
                            decided_by = ?,
                            decision_comment = ?,
                            decided_at = CURRENT_TIMESTAMP,
                            repository_asset_id = ?,
                            repository_version_id = ?
                        WHERE id = ?
                    `).run(
                        decidedBy,
                        decisionComment || null,
                        repositoryAsset.id,
                        repositoryVersionId,
                        approvalId
                    );


                    return {
                        repositoryAsset,
                        repositoryVersionId,
                        repositoryVersionNumber
                    };
                })();


            const updatedApproval =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(approvalId);


            return res.json({
                status: 'approved',

                approval:
                    updatedApproval,

                repository: {
                    asset:
                        result.repositoryAsset,

                    version_id:
                        result.repositoryVersionId,

                    version_number:
                        result.repositoryVersionNumber
                }
            });


        } catch (err) {

            console.error(
                'Creative Approval approval failed:',
                err
            );


            return res.status(409).json({
                error:
                    err.message ||
                    'Failed to approve Creative Approval'
            });
        }
    }
);







module.exports = router;
