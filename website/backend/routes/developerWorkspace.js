//backend/routes/developerWorkspace.js
const express = require('express');
const router = express.Router();

const db = require('../db');
const audit = require('../lib/audit');
// The quota accounting, shared with the admin Storage tab so the two pages
// cannot show different figures for the same workspace.
const { workspaceUsage } = require('../lib/workspaceUsage');
// retentionDays() is a FUNCTION, not a value, because the retention window is
// an admin setting. Destructuring a value here would freeze it at boot and a
// change on the admin page would never reach the bin this route serves.
const { retentionDays, retentionFor } = require('../lib/retention');
// The purge itself lives in lib/, because the daily job runs the same one.
const { purgeVersionFiles } = require('../lib/wastebin');
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
// Byte sizes, spelled the same way here as on screen. shared/ is the one copy —
// the client formatter used to be a second implementation and the two had
// already drifted apart.
const { formatBytes } = require('../../shared/formatBytes.mjs');
// Where the store's files live, and the only safe way to build a path to one.
const { BLOB_DIR, TMP_DIR, isStorageKey, blobPath, thumbPath } = require('../lib/storagePaths');
// A version's content identity — one SHA-256 over its components.
const { manifestHash } = require('../lib/manifestHash');

// PREVIEWS — so the approver can SEE the work without downloading it. The
// generation itself is shared with the library; see backend/lib/thumbnails.js.
const { makePreview, previewKindOf } = require('../lib/thumbnails');

// Keyed by the FILE, because a preview is a property of a blob rather than of
// any one asset that happens to reference it (item 84).
const upsertFileThumbnail = db.prepare(`
    INSERT INTO file_thumbnails (
        stored_file_id, kind, storage_key, width, height
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (stored_file_id, kind)
    DO UPDATE SET
        storage_key = excluded.storage_key,
        width = excluded.width,
        height = excluded.height
`);
// THE PREVIEWS FOR ONE UPLOAD, made AFTER the response has been sent.
//
// One after another rather than Promise.all, so one upload's files do not all
// queue for the shared threads at once; the queue in lib/thumbnails.js is the
// backstop, not a reason to be greedy. A failure is logged and skipped — the
// upload has already committed and a picture is not worth failing it.
async function generatePreviews(items) {
    for (const item of items) {
        if (!item.storedFileId) continue;

        const kind = previewKindOf(item.filename);

        if (!kind) continue;

        const sourcePath = blobPath(item.sha256);

        if (!sourcePath) continue;

        try {
            const made = await makePreview(sourcePath, item.sha256, kind);

            if (made) {
                upsertFileThumbnail.run(
                    item.storedFileId,
                    made.kind,
                    item.sha256,
                    made.width,
                    made.height
                );
            }

        } catch (err) {
            console.error(
                `Could not make a preview for ${item.filename}:`,
                err.message
            );
        }
    }
}

// Getting bytes into the store. SHARED WITH THE LIBRARY'S UPLOAD — there is one
// implementation of this on purpose; see the note at the top of the file.
const { storeOne } = require('../lib/ingestFiles');


// ============================================================
// Temporary upload storage
// ============================================================
//
// Both directories come from backend/lib/storagePaths.js rather than being
// joined here. '<something>/uploads/files' depends on how deep the file writing
// it sits, and there were five copies of it across the backend that agreed only
// because all five happened to be two levels under backend/.

const tempUploadDir = TMP_DIR;

fs.mkdirSync(tempUploadDir, { recursive: true });



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
    requireRole('developer', 'admin'),
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
                    repository_version_id,
                    files_purged_at
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

            // How much is in the bin. A COUNT here rather than a second request
            // from the client, so the badge on the Bin tab is right when the
            // page loads and the tab itself can still be filled in lazily.
            const binCounts = db.prepare(`
                SELECT
                    (SELECT COUNT(*) FROM workspace_assets
                      WHERE workspace_id = ? AND is_active = 0) AS assets,
                    (SELECT COUNT(*) FROM workspace_versions wv
                       JOIN workspace_assets wa ON wa.id = wv.workspace_asset_id
                      WHERE wa.workspace_id = ?
                        AND wa.is_active = 1
                        AND wv.is_active = 0)                     AS versions
            `).get(workspace.id, workspace.id);

            return res.json({
                workspace,
                // Lets the panel show "4.2 GB of 5 GB used" and warn about a
                // pending upload BEFORE it is attempted. The client figure is
                // advisory only; the server enforces on upload regardless.
                usage: workspaceUsage(workspace.id),
                bin: {
                    assets: binCounts.assets,
                    versions: binCounts.versions,
                },
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


// WHAT THIS DEVELOPER HAS DOWNLOADED, newest first.
//
// AN ASSERTION RATHER THAN AN OBSERVATION — the client says what it wrote,
// because the server cannot see a developer's disk. So it is the same class as
// the changelist an importer records: a fact about something that happened
// elsewhere, typed by the person it happened to.
//
// IT READS THE AUDIT LOG, which until now was write-only from the application's
// point of view. A download IS an event, and the log is the record of events,
// so there is no second table to keep in step.
function readDownloads(developerId) {
    const rows = db.prepare(`
        SELECT id, target, details, created_at
        FROM audit_logs
        WHERE actor_id = ?
          AND action = 'store.download'
        ORDER BY id DESC
        LIMIT 50
    `).all(developerId);

    return rows.map(row => {
        let details = {};

        try {
            details = JSON.parse(row.details || '{}');
        } catch {
            // A malformed details column is not worth failing a page over.
            details = {};
        }

        return {
            id: row.id,
            asset_name: row.target,
            version_number: details.version_number ?? null,
            files_written: details.files_written ?? 0,
            files_unchanged: details.files_unchanged ?? 0,
            files_failed: details.files_failed ?? 0,
            target_folder: details.target_folder ?? null,
            created_at: row.created_at
        };
    });
}

// ============================================================
/*
 * Uploads the server REFUSED, because nothing in them had changed.
 *
 * A REFUSAL IS A THING THAT HAPPENED TO THE DEVELOPER'S WORK, and it is the
 * one kind of upload that leaves no row anywhere else: nothing was stored,
 * nothing was versioned, so the workspace has no trace of it. Without this, an
 * upload refused for being identical would simply vanish — the developer is
 * told once, at the moment it happens, and can never look it up again.
 *
 * Same shape as readDownloads above, and for the same reason.
 */
function readRefusedUploads(developerId) {
    const rows = db.prepare(`
        SELECT id, target, details, created_at
        FROM audit_logs
        WHERE actor_id = ?
          AND action = 'workspace.upload_refused'
        ORDER BY id DESC
        LIMIT 50
    `).all(developerId);

    return rows.map(row => {
        let details = {};

        try {
            details = JSON.parse(row.details || '{}');
        } catch {
            details = {};
        }

        return {
            id: row.id,
            asset_name: row.target,
            version_number: details.version_number ?? null,
            file_count: details.file_count ?? 0,
            metadata_changed: details.metadata_changed ?? [],
            created_at: row.created_at
        };
    });
}

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
    requireRole('developer', 'admin'),

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
                    assets: [],
                    downloads: readDownloads(developerId)
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
                    is_active,
                    deleted_at,
                    files_purged_at,
                    purged_file_manifest
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
            return res.json({
                totals,
                assets,
                // WHAT THEY HAVE TAKEN, not only what they have made. A download
                // is something a developer did and wants to look back at, and it
                // leaves no row anywhere else — it copies nothing, so the store
                // has no record of it and the workspace has none either. The
                // audit log is where it lives.
                downloads: readDownloads(developerId),

                // AND WHAT WAS REFUSED. An upload that changed nothing leaves
                // no other trace, so this is the only record that the developer
                // tried.
                refused_uploads: readRefusedUploads(developerId)
            });

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
    requireRole('admin'),

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
    requireRole('developer', 'admin'),

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

            // deleted_at is stamped at the same moment as is_active, and only
            // if it is not already set: re-deleting something already deleted
            // must not restart its retention clock, or a developer could keep
            // an asset alive for ever by deleting it again every thirteen days.
            const remove = db.transaction(() => {
                db.prepare(`
                    UPDATE workspace_versions
                    SET is_active = 0,
                        deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
                    WHERE workspace_asset_id = ?
                `).run(assetId);

                db.prepare(`
                    UPDATE workspace_assets
                    SET is_active = 0,
                        deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP),
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
    requireRole('developer', 'admin'),

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

            // COALESCE for the same reason as the asset delete above: deleting
            // something twice must not restart its retention clock.
            db.prepare(`
                UPDATE workspace_versions
                SET is_active = 0,
                    deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
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
// THE PHYSICAL DELETE
// ============================================================
//
// Removes a version's CONTENT while keeping the RECORD of it.
//
// This is the operation the wastebin's 14-day purge will call, and it is also
// what "empty the bin now" does. It is deliberately NOT wired to a timer yet —
// there is no scheduler (TODO 32) — so today it runs only when asked.
//
// WHAT ACTUALLY GETS DELETED: the workspace_version_files rows. That is the
// whole of it, and it is the step that matters — those rows hold the only
// reference from this workspace to the stored content. Everything else stays:
// the version, its note, its technical checks, its approval and its history.
//
// WHAT DELETING THOSE ROWS DOES NOT DO is remove the content itself. A blob is
// freed only when NOTHING references it, and if the version went into the game
// store then asset_version_files still does. So a developer physically deleting
// their copy of approved work cannot remove it from the game — not because a
// check refuses, but because the store's own reference keeps it alive. That is
// the rule enforcing itself rather than being asserted.
//
// The manifest is the record kept in the files' place: names, paths, sizes and
// hashes, so the version still says what it was made of. Names and hashes only
// — if it ever starts holding content, the point has been undone.
// ============================================================

// ============================================================
// POST /api/developer/workspace/assets/:assetId/versions/:versionId/purge
// ============================================================
//
// Removes the content of one DELETED version, permanently.
//
// ONLY ALREADY-DELETED VERSIONS. This is the second half of the wastebin rather
// than a way around it: a version must have been deleted first, so the
// reversible step is never skipped by accident. Deleting and purging in one
// action is a different feature with different wording, and it is not this.
//
// Scoped to the caller's own workspace, like every other route here.
// ============================================================

router.post(
    '/assets/:assetId/versions/:versionId/purge',
    authenticateToken,
    requireRole('developer', 'admin'),

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
                    wv.is_active,
                    wv.deleted_at,
                    wv.files_purged_at,
                    wv.repository_version_id,
                    wa.id         AS asset_id,
                    wa.name       AS asset_name,
                    wa.workspace_id
                FROM workspace_versions wv
                JOIN workspace_assets wa     ON wa.id = wv.workspace_asset_id
                JOIN developer_workspaces dw ON dw.id = wa.workspace_id
                WHERE wv.id = ?
                  AND wa.id = ?
                  AND dw.developer_id = ?
            `).get(versionId, assetId, developerId);

            if (!version) {
                return res.status(404).json({ error: 'Workspace version not found' });
            }

            if (version.is_active) {
                return res.status(409).json({
                    error:
                        'This version is still in your workspace. Delete it first — ' +
                        'that is reversible, and this is not.'
                });
            }

            // Idempotent rather than an error: asking twice should not be a
            // failure, and the answer is the same either way.
            if (version.files_purged_at) {
                return res.json({
                    status: 'already purged',
                    version_id: version.id,
                    version_number: version.version_number,
                    purged_at: version.files_purged_at,
                    files_removed: 0,
                    bytes_removed: 0,
                });
            }

            const freed = purgeVersionFiles(versionId, developerId);

            // Said plainly, because it is the thing a developer will otherwise
            // get wrong: the bytes are now unreferenced, NOT yet reclaimed.
            // Nothing in this route touches the store.
            const note = version.repository_version_id !== null
                ? 'Your copy of the files is gone. This version is in the game ' +
                  'store, which keeps its own, so the content has not been removed.'
                : 'The files are gone and the content is no longer referenced. ' +
                  'The space is reclaimed when the store is next collected.';

            return res.json({
                status: 'purged',
                version_id: version.id,
                version_number: version.version_number,
                files_removed: freed.files,
                bytes_removed: freed.bytes,
                in_game_store: version.repository_version_id !== null,
                note,
                usage: workspaceUsage(version.workspace_id),
            });

        } catch (err) {
            console.error('Failed to purge workspace version:', err);

            return res.status(500).json({ error: 'Failed to remove the version content' });
        }
    }
);


// ============================================================
// THE WASTEBIN
// ============================================================
//
// What a developer has deleted, and what can still be taken back.
//
// Deleting is reversible for the retention window; after that the files go
// and it is not. The bin exists so that grace period is visible — something a
// developer can get back but cannot see is a grace period nobody can use.
//
// TWO KINDS OF THING, and they behave differently:
//
//   * A deleted ASSET takes its versions with it. Restoring it brings back the
//     asset and every version whose files are still there.
//
//   * A deleted VERSION of a live asset is restored on its own.
//
// A version whose files have been purged CANNOT come back, in either case — the
// content is gone. It is listed rather than hidden, because "this is gone for
// good" is something a developer needs to be able to see, and a bin that
// silently omits things is one nobody can trust.
// ============================================================

// What each version is still holding, so a developer can see what is at stake
// before the clock runs out. Read from the file rows, not from the manifest —
// the manifest describes what WAS there, and after a purge says nothing about
// what is.
const versionFileTotals = db.prepare(`
    SELECT
        COUNT(*)                        AS file_count,
        COALESCE(SUM(sf.file_size), 0)  AS bytes
    FROM workspace_version_files wvf
    JOIN stored_files sf ON sf.id = wvf.stored_file_id
    WHERE wvf.workspace_version_id = ?
`);

function binVersion(version) {
    const totals = versionFileTotals.get(version.id);

    return {
        id: version.id,
        version_number: version.version_number,
        version_note: version.version_note,
        deleted_at: version.deleted_at,
        files_purged_at: version.files_purged_at,
        file_count: totals.file_count,
        bytes: totals.bytes,
        // Says plainly whether restore is even possible, so the UI does not
        // offer a button that will be refused.
        can_restore: !version.files_purged_at,
        ...retentionFor(version.deleted_at),
    };
}

router.get(
    '/assets/bin',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const developerId = req.user?.id;

        if (!developerId) {
            return res.status(401).json({ error: 'Authenticated user ID not found' });
        }

        try {
            const workspace = db.prepare(`
                SELECT id FROM developer_workspaces WHERE developer_id = ?
            `).get(developerId);

            if (!workspace) {
                return res.json({
                    retention_days: retentionDays(),
                    totals: { assets: 0, versions: 0, bytes: 0 },
                    assets: [],
                    versions: [],
                });
            }

            const getVersions = db.prepare(`
                SELECT
                    id,
                    version_number,
                    version_note,
                    deleted_at,
                    files_purged_at
                FROM workspace_versions
                WHERE workspace_asset_id = ?
                ORDER BY version_number DESC
            `);

            // Whole assets that were deleted, with everything they took with
            // them.
            const deletedAssets = db.prepare(`
                SELECT id, name, category, description, deleted_at
                FROM workspace_assets
                WHERE workspace_id = ?
                  AND is_active = 0
                ORDER BY deleted_at DESC, name COLLATE NOCASE
            `).all(workspace.id);

            const assets = deletedAssets.map(asset => {
                const versions = getVersions.all(asset.id).map(binVersion);

                return {
                    id: asset.id,
                    name: asset.name,
                    category: asset.category,
                    description: asset.description,
                    deleted_at: asset.deleted_at,
                    versions,
                    // An asset can only come back if something in it can.
                    can_restore: versions.some(v => v.can_restore),
                    ...retentionFor(asset.deleted_at),
                };
            });

            // Versions deleted on their own, where the asset is still live.
            // These are NOT included above, because above is for assets that
            // are entirely gone.
            const looseVersions = db.prepare(`
                SELECT
                    wv.id,
                    wv.version_number,
                    wv.version_note,
                    wv.deleted_at,
                    wv.files_purged_at,
                    wa.id   AS asset_id,
                    wa.name AS asset_name
                FROM workspace_versions wv
                JOIN workspace_assets wa ON wa.id = wv.workspace_asset_id
                WHERE wa.workspace_id = ?
                  AND wa.is_active = 1
                  AND wv.is_active = 0
                ORDER BY wv.deleted_at DESC
            `).all(workspace.id);

            const versions = looseVersions.map(version => ({
                ...binVersion(version),
                asset_id: version.asset_id,
                asset_name: version.asset_name,
            }));

            const bytes = [...assets, ...versions]
                .flatMap(item => item.versions ? item.versions : [item])
                .reduce((total, version) => total + version.bytes, 0);

            return res.json({
                retention_days: retentionDays(),
                totals: {
                    assets: assets.length,
                    versions: versions.length,
                    bytes,
                },
                assets,
                versions,
            });

        } catch (err) {
            console.error('Failed to load the wastebin:', err);

            return res.status(500).json({ error: 'Failed to load the bin' });
        }
    }
);


// ============================================================
// POST .../assets/:assetId/restore
// POST .../assets/:assetId/versions/:versionId/restore
// ============================================================
//
// Takes something back out of the bin.
//
// A RESTORE IS AN UPDATE, not a move — nothing was ever removed from the row.
// That is the whole reward for having built deletion as a flag rather than a
// delete: bringing something back is one column, and it works exactly as long
// as the files are still there.
//
// PURGED VERSIONS DO NOT COME BACK, and are skipped rather than failing the
// whole restore. Restoring an asset whose third version was purged should
// return the other two and SAY that one could not, rather than refusing
// everything because part of it is gone.
//
// The deletion is REFUSED while an approval is pending, so nothing in the bin
// can be under review — there is no equivalent check needed here.
// ============================================================

function restoreVersions(versionIds) {
    const restore = db.prepare(`
        UPDATE workspace_versions
        SET is_active = 1,
            deleted_at = NULL
        WHERE id = ?
    `);

    for (const id of versionIds) restore.run(id);
}

router.post(
    '/assets/:assetId/restore',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const developerId = req.user?.id;
        const assetId = Number(req.params.assetId);

        if (!Number.isInteger(assetId)) {
            return res.status(400).json({ error: 'Invalid asset ID' });
        }

        try {
            const asset = db.prepare(`
                SELECT wa.id, wa.name, wa.is_active, wa.workspace_id
                FROM workspace_assets wa
                JOIN developer_workspaces dw ON dw.id = wa.workspace_id
                WHERE wa.id = ?
                  AND dw.developer_id = ?
            `).get(assetId, developerId);

            if (!asset) {
                return res.status(404).json({ error: 'Workspace asset not found' });
            }

            if (asset.is_active) {
                return res.status(409).json({
                    error: 'That asset is not in the bin — it is already in your workspace.'
                });
            }

            const versions = db.prepare(`
                SELECT id, files_purged_at
                FROM workspace_versions
                WHERE workspace_asset_id = ?
            `).all(assetId);

            const restorable = versions.filter(v => !v.files_purged_at);
            const lost = versions.length - restorable.length;

            if (restorable.length === 0) {
                return res.status(409).json({
                    error:
                        'Every version of that asset has had its files removed. ' +
                        'There is nothing left to restore.'
                });
            }

            db.transaction(() => {
                restoreVersions(restorable.map(v => v.id));

                db.prepare(`
                    UPDATE workspace_assets
                    SET is_active = 1,
                        deleted_at = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(assetId);

                audit.record(
                    developerId,
                    'workspace_asset.restore',
                    asset.name,
                    { versions_restored: restorable.length, versions_lost: lost }
                );
            })();

            return res.json({
                status: 'restored',
                asset_id: asset.id,
                name: asset.name,
                versions_restored: restorable.length,
                versions_lost: lost,
                note: lost
                    ? `${lost} version(s) had their files removed and could not come back.`
                    : 'Everything came back.',
                usage: workspaceUsage(asset.workspace_id),
            });

        } catch (err) {
            console.error('Failed to restore workspace asset:', err);

            return res.status(500).json({ error: 'Failed to restore the asset' });
        }
    }
);

router.post(
    '/assets/:assetId/versions/:versionId/restore',
    authenticateToken,
    requireRole('developer', 'admin'),

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
                    wv.is_active,
                    wv.files_purged_at,
                    wa.name       AS asset_name,
                    wa.is_active  AS asset_active,
                    wa.workspace_id
                FROM workspace_versions wv
                JOIN workspace_assets wa     ON wa.id = wv.workspace_asset_id
                JOIN developer_workspaces dw ON dw.id = wa.workspace_id
                WHERE wv.id = ?
                  AND wa.id = ?
                  AND dw.developer_id = ?
            `).get(versionId, assetId, developerId);

            if (!version) {
                return res.status(404).json({ error: 'Workspace version not found' });
            }

            if (version.is_active) {
                return res.status(409).json({
                    error: 'That version is not in the bin.'
                });
            }

            // If the whole asset is in the bin, restoring one version of it out
            // of turn would leave a live version inside a deleted asset — a
            // state nothing else in the system expects. Restore the asset.
            if (!version.asset_active) {
                return res.status(409).json({
                    error:
                        `"${version.asset_name}" is itself in the bin. ` +
                        'Restore the asset, and this version comes back with it.'
                });
            }

            if (version.files_purged_at) {
                return res.status(409).json({
                    error:
                        'The files for that version have been removed, so it cannot ' +
                        'come back. The record of it stays in your history.'
                });
            }

            db.transaction(() => {
                restoreVersions([versionId]);

                audit.record(
                    developerId,
                    'workspace_version.restore',
                    `${version.asset_name} v${version.version_number}`,
                    null
                );
            })();

            return res.json({
                status: 'restored',
                asset_id: assetId,
                version_id: versionId,
                version_number: version.version_number,
                usage: workspaceUsage(version.workspace_id),
            });

        } catch (err) {
            console.error('Failed to restore workspace version:', err);

            return res.status(500).json({ error: 'Failed to restore the version' });
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
    requireRole('developer', 'admin'),

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
// The review queue. PROD ONLY, as of 2026-10-06.
//
// IT WAS requireRole('admin') — and admin is precisely the role that may NOT
// decide a creative approval, so the queue was readable by everyone except the
// person whose job it is. The approve and reject routes had the same problem
// and were fixed with it. See TODO 51.
//
// Without this there was no way to discover a pending approval: those routes
// take an approval id, and nothing else listed them, so the workflow could not
// be driven at all.
//
// Optional ?status= filter, defaulting to pending. Returns the requesting
// developer and the submitted files.
//
// WHAT "THE SUBMITTED FILES" CANNOT MEAN YET: a workspace is private and there
// is no read path into one, for anybody — so a reviewer sees the file LIST and
// cannot open the content. That is recorded as work to do once the game exists;
// see the AFTER THE GAME EXISTS section of the TODO.
// ============================================================

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

router.get(
    '/creative-approvals',
    authenticateToken,
    requireRole('prod'),

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
                    sf.sha256,
                    -- WHETHER A PREVIEW EXISTS, so the queue can draw the ones
                    -- it has and an icon for the ones it has not. A file with
                    -- no preview is normal: a .uasset has no picture.
                    (SELECT ft.kind
                       FROM file_thumbnails ft
                      WHERE ft.stored_file_id = wvf.stored_file_id
                      LIMIT 1) AS preview_kind
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
// GET /api/developer/workspace/creative-approvals/:approvalId/preview/:sha256
// ============================================================
//
// THE PREVIEW OF ONE FILE IN A SUBMISSION, so the approver can SEE what they
// are deciding. docs/assettypes01 §1 B, and the answer to the note below about
// there being no read path into a workspace.
//
// ============================================================
// IT SERVES A PICTURE, NOT THE FILE
// ============================================================
//
// A PREVIEW IS DERIVED CONTENT. It is made from the blob, it is not the blob,
// and it lives in THUMB_DIR rather than in the store (see storagePaths.js).
// SERVING IT DOES NOT OPEN THE WORKSPACE — the developer's actual files are
// still unreachable without impersonating, which is the rule the block below
// states and which this does not weaken.
//
// THE DISTINCTION IS THE WHOLE POINT: an approver needs to look, and looking at
// a rendered picture is not the same as holding the source. A .blend is useless
// to production anyway; the picture is the thing they can judge.
//
// ============================================================
// AND THE PERMISSION IS THE APPROVAL ITSELF
// ============================================================
//
// There is no "prod may read any blob" route here. The caller names an
// approval, and THE FILE MUST BE ONE OF THAT APPROVAL'S FILES — so what can be
// seen is exactly what has been submitted for a decision, which is the same
// scope as the queue that lists it.
// ============================================================

const approvalVersion = db.prepare(`
    SELECT ca.workspace_version_id
    FROM creative_approvals ca
    WHERE ca.id = ?
`);

const fileInVersion = db.prepare(`
    SELECT
        sf.id,
        sf.sha256,
        sf.storage_key
    FROM workspace_version_files wvf
    JOIN stored_files sf ON sf.id = wvf.stored_file_id
    WHERE wvf.workspace_version_id = ?
      AND sf.sha256 = ?
`);

const previewsForFile = db.prepare(`
    SELECT kind, storage_key
    FROM file_thumbnails
    WHERE stored_file_id = ?
`);

router.get(
    '/creative-approvals/:approvalId/preview/:sha256',
    authenticateToken,
    requireRole('prod'),

    async (req, res) => {
        const approvalId = Number(req.params.approvalId);
        const sha256 = String(req.params.sha256 || '').toLowerCase();

        if (!Number.isInteger(approvalId)) {
            return res.status(400).json({ error: 'Invalid approval ID' });
        }

        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            return res.status(400).json({ error: 'Invalid file hash' });
        }

        try {
            const approval = approvalVersion.get(approvalId);

            if (!approval) {
                return res.status(404).json({ error: 'Creative Approval not found' });
            }

            // THE FILE MUST BE IN THIS APPROVAL. A hash that is not is not a
            // mistake worth explaining in detail — it is simply not here.
            const file = fileInVersion.get(approval.workspace_version_id, sha256);

            if (!file) {
                return res.status(404).json({ error: 'That file is not in this submission' });
            }

            // `image` is what an image gets and `video_frame` is a poster;
            // anything else has none, and answers 404 rather than a broken img.
            const thumbs = previewsForFile.all(file.id);

            if (thumbs.length === 0) {
                return res.status(404).json({ error: 'No preview exists for that file' });
            }

            const preferred = thumbs.find(t => t.kind === 'image')
                || thumbs.find(t => t.kind === 'video_frame')
                || thumbs[0];

            const previewPath = thumbPath(preferred.storage_key, preferred.kind);

            if (!previewPath) {
                return res.status(404).json({ error: 'No preview exists for that file' });
            }

            // `res.sendFile` handles range requests and caching, and the type
            // is safe to declare: these are always the WebP this system wrote,
            // never the developer's bytes — which is what makes an inline
            // preview safe here at all (TODO item 35). nosniff says so to the
            // browser as well, as the download route does.
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.type('image/webp');

            return res.sendFile(previewPath);

        } catch (err) {
            console.error('Could not serve a preview:', err);

            return res.status(500).json({ error: 'Could not serve that preview' });
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

// SHA256_HEX used to be defined here as well as in backend/lib/storeIntegrity.js
// — the same regex, twice. It now lives with the path it protects, in
// backend/lib/storagePaths.js: the key format is what makes the path safe, and
// splitting them is how one of the two checks gets forgotten.

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
    requireRole('developer', 'admin'),

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
    requireRole('developer', 'admin'),

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
            // blobPath() does the checking, so the guard and the join cannot
            // drift apart — and a null is the only way it can fail.
            const absolutePath = blobPath(file.storage_key);

            if (!absolutePath) {
                console.error(
                    'Refusing to serve stored file with a malformed storage_key:',
                    file.storage_key
                );

                return res.status(500).json({
                    error: 'Stored file record is malformed'
                });
            }

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
    requireRole('developer', 'admin'),

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
    requireRole('developer', 'admin'),

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

            // asset_type IS NOT READ FROM THE REQUEST.
            //
            // It is a property of the FILES, not a field a client chooses:
            // assetTypeOf() classifies every file against TYPE_BY_EXTENSION,
            // and the technical check records the type when every file in the
            // version agrees — with COALESCE, so an ambiguous version cannot
            // wipe a type an earlier one established. The client deliberately
            // stopped sending one (see its own note in
            // frontend/src/developerWorkspace.js).
            //
            // ACCEPTING IT HERE AS WELL WOULD BE A SECOND WAY TO SET IT, and
            // the client never sends it, so the way nobody uses is the way
            // nobody notices drifting. Removed 2026-10-23.

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


            // FILENAME OVERRIDES WERE REMOVED on 2026-10-23. The client keyed
            // the map by the ORIGINAL path and this end looked it up by the
            // EDITED path, so it could never match and had never done
            // anything. Under the upload model in TODO 87 a pathname change IS
            // a change — it makes a new version — so the path the developer
            // sends is the path that is stored, and there is nothing left to
            // override.


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


                // THE FILENAME AS SENT. There is no override: see the note
                // where it used to be parsed, above.
                const filename = originalFilename;


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
            // HAS ANYTHING ACTUALLY CHANGED?
            //
            // THE RULE (TODO 87, A5/A10): A VERSION IS THE ASSET'S FILE SET.
            // An upload whose components are identical to the newest version's
            // makes no version — it is refused with an explanation, and the
            // developer can INSIST, which is the one case where a version is
            // created without a byte changing.
            //
            // HERE, BEFORE THE QUOTA CHECK AND BEFORE ANY WRITE, for the same
            // reason the quota check is here: a refusal must leave no partial
            // state and no changed metadata.
            //
            // CONTENT ONLY — path, name, hash. Metadata must never make
            // identical files look changed, and files must never look changed
            // because a description was edited.
            // ----------------------------------------------------

            const incomingHash = manifestHash(
                processedFiles.map(item => ({
                    relative_path: item.relativePath,
                    filename: item.filename,
                    sha256: item.sha256,
                    size: item.file.size
                }))
            );

            // A multipart body delivers strings. Named rather than a boolean
            // because a browser sends "on" for a ticked box, not "true".
            const forceNewVersion =
                String(req.body?.force_new_version || '') === '1';

            if (!forceNewVersion) {
                const existing = db.prepare(`
                    SELECT id, name, category, description
                    FROM workspace_assets
                    WHERE workspace_id = ?
                      AND name = ?
                      AND is_active = 1
                `).get(workspace.id, assetName);

                const latest = existing
                    ? db.prepare(`
                        SELECT id, version_number, manifest_hash
                        FROM workspace_versions
                        WHERE workspace_asset_id = ?
                          AND is_active = 1
                        ORDER BY version_number DESC
                        LIMIT 1
                    `).get(existing.id)
                    : null;

                if (latest && latest.manifest_hash === incomingHash) {
                    // WHICH METADATA DIFFERS, SO THE EXPLANATION CAN BE
                    // SPECIFIC. "Nothing has really changed except the
                    // description you provided" is only honest if it is true,
                    // and it is not when nothing at all differs.
                    //
                    // ONLY A VALUE THE DEVELOPER ACTUALLY SENT COUNTS. Both
                    // fields are optional and an absent one leaves the asset's
                    // value alone, so an absent one is not a change.
                    const changed = [];

                    if (description && description !== (existing.description || '')) {
                        changed.push('description');
                    }

                    if (category && category !== (existing.category || null)) {
                        changed.push('category');
                    }

                    // IN THE HISTORY, because a refusal the developer never sees
                    // reads as a failed upload.
                    audit.record(
                        developerId,
                        'workspace.upload_refused',
                        assetName,
                        {
                            workspace_asset_id: existing.id,
                            workspace_version_id: latest.id,
                            version_number: latest.version_number,
                            manifest_hash: incomingHash,
                            file_count: processedFiles.length,
                            metadata_changed: changed
                        }
                    );

                    return res.status(409).json({
                        error: changed.length
                            ? `Nothing has really changed except the ${changed.join(' and ')} you provided.`
                            : 'Nothing has changed: these are the components the latest version already holds.',
                        nothing_changed: true,
                        metadata_changed: changed,
                        latest_version_number: latest.version_number,
                        manifest_hash: incomingHash
                    });
                }
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

            // usage.limit_bytes, not a constant: the allowance is a setting, and
            // the figure refused here has to be the one the developer was shown.
            if (projectedBytes > usage.limit_bytes) {
                const quotaError = new Error(
                    `This upload would take the workspace to ${formatBytes(projectedBytes)}, ` +
                    `over the ${formatBytes(usage.limit_bytes)} limit. ` +
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

            const storageDir = BLOB_DIR;

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
                        // A DELETED ASSET STILL HOLDS ITS NAME. BRING IT BACK.
                        //
                        // THE UNIQUE CONSTRAINT IS ON (workspace_id, name) AND
                        // DOES NOT MENTION is_active, so an asset in the bin is
                        // still holding the name it was deleted under. THIS
                        // LOOKUP FINDS IT — and used to carry on as though it
                        // had not, adding the new version to a row that is
                        // INVISIBLE.
                        //
                        // WHICH MEANT THE UPLOAD SUCCEEDED, THE FILES WERE
                        // STORED AND CHARGED TO THE DEVELOPER'S QUOTA, AND
                        // NOTHING APPEARED. Silent loss, and the worst shape of
                        // failure there is: it reports success.
                        //
                        // SO IT IS RESTORED, for the reason the import is
                        // restored (routes/game.js): the developer has just
                        // uploaded work under that name, so they plainly want
                        // it, and the row is the thing that holds the name.
                        // THE VERSIONS COME BACK TOO, which is what the bin's
                        // own Restore does — an asset returning without its
                        // history would be stranger than one returning with it.
                        // --------------------------------------------

                        if (asset && !asset.is_active) {

                            db.prepare(`
                                UPDATE workspace_assets
                                SET is_active = 1,
                                    deleted_at = NULL,
                                    updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                            `).run(asset.id);

                            db.prepare(`
                                UPDATE workspace_versions
                                SET is_active = 1,
                                    deleted_at = NULL
                                WHERE workspace_asset_id = ?
                            `).run(asset.id);

                            asset.is_active = 1;

                            audit.record(
                                developerId,
                                'workspace_asset.restore',
                                asset.name,
                                {
                                    workspace_asset_id: asset.id,
                                    reason: 'uploaded to again'
                                }
                            );
                        }


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
                                // derived by the check, never from the client
                                null,
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
                                // derived by the check, never from the client
                                null,
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
                        // The statements this transaction still needs.
                        //
                        // stored_files USED TO BE PREPARED HERE — a lookup by
                        // sha256 and an insert — and they are GONE rather than
                        // merely unused: both now live in
                        // backend/lib/ingestFiles.js, where the library's upload
                        // reaches them too. Leaving a second copy here is how a
                        // file ends up stored twice or not at all.
                        // --------------------------------------------

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

                            // ----------------------------------------
                            // Into the store.
                            //
                            // ONE IMPLEMENTATION, SHARED WITH THE LIBRARY'S
                            // UPLOAD. The lookup by SHA that makes the one-copy
                            // rule true lives in backend/lib/ingestFiles.js, and
                            // so does the hard link. Two copies of those steps
                            // would be two chances to disagree about what a file
                            // is — see the note in that file.
                            // ----------------------------------------

                            const { storedFile, createdBlobPath } =
                                storeOne({
                                    sha256,
                                    tempPath: file.path,
                                    size: file.size,
                                    mimeType: file.mimetype
                                });

                            // Kept for the preview pass after the transaction,
                            // which needs the row rather than the temp file.
                            item.storedFileId = storedFile.id;


                            // ONLY A GENUINELY NEW BLOB IS ROLLED BACK. A repair
                            // is not: it restored a file the database said should
                            // be there, and undoing it would leave the store in
                            // the state the repair was fixing.
                            if (createdBlobPath) {
                                newlyStoredPaths.push(createdBlobPath);
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
                        // The version's CONTENT IDENTITY.
                        //
                        // Computed from the files just written, inside the same
                        // transaction, so a version cannot exist without the
                        // value that says which content it is. See
                        // shared/manifest.mjs and docs/SPEC.md §4.
                        // --------------------------------------------

                        db.prepare(`
                            UPDATE workspace_versions
                            SET manifest_hash = ?
                            WHERE id = ?
                        `).run(
                            manifestHash(
                                processedFiles.map(item => ({
                                    relative_path: item.relativePath,
                                    filename: item.filename,
                                    sha256: item.sha256,
                                    size: item.file.size
                                }))
                            ),
                            versionId
                        );


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


                        // THE UPLOAD ITSELF, RECORDED — inside the
                        // transaction, so an upload that rolls back leaves no
                        // record of having happened, and one that commits
                        // cannot exist without one (TODO 87 C1).
                        //
                        // A REFUSAL IS NOT RECORDED HERE. The refusal that
                        // matters — identical components, with the popup and
                        // the override — does not exist yet (TODO 87, A5/A10).
                        // When it does it belongs BEFORE this transaction
                        // opens, at the point the comparison is made.
                        audit.record(
                            developerId,
                            'workspace.upload',
                            asset.name,
                            {
                                workspace_asset_id: asset.id,
                                workspace_version_id: version.id,
                                version_number: version.version_number,
                                file_count: files.length,
                                version_note: versionNote
                            }
                        );


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

            // ----------------------------------------------------
            // RESPOND FIRST, THEN MAKE THE PREVIEWS.
            //
            // docs/assettypes01 §1 B: "seeing the asset on the website, so an
            // approver can judge it without downloading." PRODUCTION DOES NOT
            // HAVE BLENDER OR UNREAL — a download is useless to them even when
            // they are allowed one. They need to look, and this is the looking.
            //
            // BUT A PICTURE IS NOT THE UPLOAD. The upload has already
            // committed and the developer is waiting on the reply. Encoding an
            // image takes milliseconds and a video frame can take seconds, so
            // running that first made a bundle with clips in it feel like a
            // hung upload — a regression previews introduced, fixed here.
            //
            // THE PREVIEWS ARE DERIVED CONTENT. Nothing depends on them
            // existing at the moment of the reply, and a preview that fails is
            // logged and skipped. The shared queue in lib/thumbnails.js keeps
            // the background work from becoming a flood: at most two at a
            // time, across every caller.
            // ----------------------------------------------------

            res.status(201).json({
                status: 'created',
                // Backups were found and dropped. Said out loud so the
                // developer is not left wondering why the file count differs
                // from what they selected.
                skipped_backups: skippedBackups,
                ...result
            });

            // NOT AWAITED. The promise is given a catch here rather than left
            // to become an unhandled rejection, which in Node 22 takes the
            // process down — an upload succeeding and the server dying a
            // second later would be the worst possible trade.
            generatePreviews(processedFiles).catch(err => {
                console.error('Previews for an upload failed:', err.message);
            });

            return;


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
    requireRole('developer', 'admin'),

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
                    wv.manifest_hash,
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

            // THE RECEIPT'S ASSET HALF, recorded when the run starts.
            //
            // The version's manifest hash is written with the run, so the
            // record says WHICH CONTENT was tested rather than only which
            // version number — and submission can check that they still agree.
            const runResult = db.prepare(`
                INSERT INTO technical_check_runs (
                    workspace_asset_id,
                    workspace_version_id,
                    manifest_hash,
                    started_by,
                    status
                )
                VALUES (?, ?, ?, ?, 'running')
            `).run(
                assetId,
                versionId,
                version.manifest_hash,
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

                const storagePath = blobPath(file.storage_key);


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

                const storagePath = blobPath(file.storage_key);

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


                    // THE VERDICT, WITH WHO ASKED FOR IT. Inside the same
                    // transaction as the results and the completion, so the
                    // record cannot describe a run that was not stored
                    // (TODO 87 C1).
                    //
                    // THE FAILED CHECK NAMES GO IN, not only the verdict:
                    // "technical validation failed" without saying which check
                    // is a summary, and this is meant to be a record.
                    audit.record(
                        developerId,
                        'technical_check.run',
                        version.asset_name,
                        {
                            workspace_asset_id: version.workspace_asset_id,
                            workspace_version_id: versionId,
                            version_number: version.version_number,
                            run_id: runId,
                            status: finalStatus,
                            failed_checks: results
                                .filter(result => result.status === 'failed')
                                .map(result => result.name)
                        }
                    );
                });


            storeResults();


            const completedRun =
                db.prepare(`
                    SELECT
                        id,
                        workspace_asset_id,
                        workspace_version_id,
                        manifest_hash,
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


            // ----------------------------------------------------
            // THE TEST RECEIPT.
            //
            // What was tested, what it found, who ran it and when — bound to
            // the CONTENT by the manifest hash rather than to a version number.
            // Submission checks this hash against the version's (see the
            // request-creative-approval route), which is what makes "the
            // version I tested is the version I submitted" a fact rather than
            // an assumption.
            //
            // `game` IS NULL AND THAT IS HONEST, NOT A PLACEHOLDER. The spec's
            // receipt also identifies the game build — branch, build number,
            // commit — and NO GAME BUILD EXISTS (TODO 87, E5; items 53, 60).
            // A field that is absent says that; a field that is empty or
            // fabricated would not.
            // ----------------------------------------------------

            const receipt = {
                workspace_asset_id: completedRun.workspace_asset_id,
                workspace_version_id: completedRun.workspace_version_id,
                version_number: version.version_number,
                asset_manifest_hash: completedRun.manifest_hash,
                tested_by: completedRun.started_by,
                result: completedRun.status,
                tested_at: completedRun.completed_at,
                checks: checkResults.map(result => ({
                    name: result.check_name,
                    status: result.status,
                    message: result.message
                })),
                game: null
            };


            return res.json({
                status: finalStatus,
                run: completedRun,
                results: checkResults,
                receipt
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
    requireRole('developer', 'admin'),

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
                    wv.manifest_hash,
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
                    SELECT id, manifest_hash
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
            // THE RECEIPT'S JOB (TODO 87, E1): the content that PASSED the
            // test must be the content being submitted.
            //
            // The version id alone is not enough to say that. It is enough
            // today, because a version's files are written once and cannot be
            // edited — but that is a property of the current code, not of the
            // record, and the moment a version can change or a test can be
            // reported by an external harness, the version number stops being
            // evidence.
            //
            // The manifest hash is evidence. It travels with the run and is
            // compared here.
            //
            // THE GAME BUILD is the receipt's other half and is not checked,
            // because no game build exists (E5). When it does, it belongs
            // here, against the build required by the target release.
            // ----------------------------------------------------

            if (technicalPass.manifest_hash !== version.manifest_hash) {
                return res.status(409).json({
                    error:
                        'The technical test passed against different content from this version. ' +
                        'Run Technical Validation again before submitting.'
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


                    // THE MOMENT A DEVELOPER DECLARES A VERSION READY, and the
                    // moment the freeze on that version begins. Recorded inside
                    // the same transaction as the lock and the request, so the
                    // three cannot disagree — an approval row with no record of
                    // who asked for it is exactly what TODO 87 C1 is about.
                    audit.record(
                        developerId,
                        'creative_approval.submit',
                        version.asset_name,
                        {
                            workspace_asset_id: assetId,
                            workspace_version_id: versionId,
                            version_number: version.version_number,
                            approval_id: result.lastInsertRowid
                        }
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
    // PROD, NOT ADMIN — and until now it WAS admin, which is the opposite of
    // the decision. These two were requireRole('admin','superuser'); a sweep
    // removing the removed role turned them into requireRole('admin') and
    // silently handed the power to the one role that is not supposed to have
    // it. Approving work is a judgement about the WORK; administering the
    // system is a different job. See TODO 51.
    requireRole('prod'),

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

            // THE ASSET'S NAME COMES WITH IT, because the audit record names
            // what was rejected rather than only numbering it.
            const approval =
                db.prepare(`
                    SELECT
                        ca.*,
                        wa.name AS workspace_asset_name,
                        wv.version_number

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


                    // See the note on the approve record: same transaction as
                    // the decision, actor only, the role comes from the switch.
                    audit.record(
                        decidedBy,
                        'creative_approval.reject',
                        approval.workspace_asset_name,
                        {
                            approval_id: approvalId,
                            workspace_asset_id: approval.workspace_asset_id,
                            workspace_version_id: approval.workspace_version_id,
                            version_number: approval.version_number,
                            decision_comment: decisionComment || null
                        }
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
    // PROD, NOT ADMIN — and until now it WAS admin, which is the opposite of
    // the decision. These two were requireRole('admin','superuser'); a sweep
    // removing the removed role turned them into requireRole('admin') and
    // silently handed the power to the one role that is not supposed to have
    // it. Approving work is a judgement about the WORK; administering the
    // system is a different job. See TODO 51.
    requireRole('prod'),

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
                        wv.repository_version_id,
                        -- WHO AUTHORED IT. The store version records the
                        -- APPROVER (created_by, set to the decider below);
                        -- the author comes from the workspace version, and is
                        -- recorded here so the store row stands alone.
                        wv.created_by AS uploaded_by

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
                                uploaded_by,
                                version_note
                            )
                            VALUES (?, ?, ?, ?, ?)
                        `).run(
                            repositoryAsset.id,
                            repositoryVersionNumber,
                            // WHO DECIDED.
                            decidedBy,
                            // WHO AUTHORED — a different person, and the one
                            // the store row previously could not name.
                            approval.uploaded_by,
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
                    // The repository version's CONTENT IDENTITY.
                    //
                    // Computed from the rows just copied, in the same
                    // transaction — so the store's version carries the same
                    // kind of identity the workspace version does, and the two
                    // are computed the same way.
                    // ------------------------------------------------

                    db.prepare(`
                        UPDATE asset_versions
                        SET manifest_hash = ?
                        WHERE id = ?
                    `).run(
                        manifestHash(
                            db.prepare(`
                                SELECT
                                    f.relative_path,
                                    f.filename,
                                    sf.sha256,
                                    sf.file_size AS size
                                FROM asset_version_files f
                                JOIN stored_files sf
                                    ON sf.id = f.stored_file_id
                                WHERE f.asset_version_id = ?
                            `).all(repositoryVersionId)
                        ),
                        repositoryVersionId
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


                    // WHO DECIDED, AND WHAT THEY DECIDED. Inside the same
                    // transaction as the decision, so the record and the
                    // decision land together or not at all — an approval that
                    // happened with nothing to show who made it is the gap
                    // TODO 87 C1 is about.
                    //
                    // THE ROLE IS NOT RECORDED PER DECISION. An admin acting as
                    // prod is recorded by the role switch itself, once, and the
                    // log's chronology carries the rest; repeating it on every
                    // row would be the same fact said twice (item 84).
                    audit.record(
                        decidedBy,
                        'creative_approval.approve',
                        approval.workspace_asset_name,
                        {
                            approval_id: approvalId,
                            workspace_asset_id: approval.workspace_asset_id,
                            workspace_version_id: approval.workspace_version_id,
                            version_number: approval.version_number,
                            repository_asset_id: repositoryAsset.id,
                            repository_version_id: repositoryVersionId,
                            repository_version_number:
                                repositoryVersionNumber,
                            decision_comment: decisionComment || null
                        }
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
