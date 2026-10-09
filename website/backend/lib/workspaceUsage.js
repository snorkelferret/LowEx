// backend/lib/workspaceUsage.js
//
// What a developer's workspace is holding, and against what limit.
//
// A LIBRARY BECAUSE TWO PAGES MUST SHOW THE SAME NUMBER. The developer's own
// panel shows them their usage; the admin's Storage tab shows the same figure
// per developer. If those were computed twice they would eventually disagree,
// and the disagreement would be invisible until somebody compared the two
// screens — one of them being told they have space and the other being told
// they do not.
//
// So the admin tab calls workspaceUsage() for each workspace rather than
// summing the tables itself: same function, same answer, by construction.
//
// ============================================================
// THE ACCOUNTING, and why it is shaped this way
// ============================================================
//
// A workspace is a STAGING AREA, not a store. The limit exists to stop it
// being used as permanent storage, not to ration legitimate work.
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
//     system TODAY, which is why it is the only thing the exclusion above is
//     about.
//
//     THE IMAGE LIBRARY (TODO 57) IS THE SECOND, and this is the sentence that
//     will cause the exclusion to be left wrong: library material is
//     STUDIO-OWNED, so pulling it into a workspace to build an asset with must
//     not consume quota either. WHEN THE LIBRARY IS BUILT, ITS FILES JOIN THE
//     `NOT IN` AT THE BOTTOM OF THIS FILE. A rule that is right today and reads
//     as a standing instruction is how the second case gets missed.
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
// NOT THE DISK. These figures are what each developer is CHARGED, and they do
// not sum to the filesystem: a file in the game store is charged to nobody and
// still occupies bytes, and one file referenced by two workspaces is counted
// twice against two quotas while existing once. The disk is a separate question
// with a separate answer, and the answer is `statfs`, not this.

const db = require('../db');

// The band, from the same place the disk's comes from. Whether a workspace is
// "nearly full" must mean the same thing here as it does for the hardware, and
// the admin panel and the developer panel must not be able to disagree — so it
// is decided once, here, and sent rather than recomputed.
//
// The levels are an admin setting, read per call. shared/ does the arithmetic
// and never touches the database — the frontend may import it.
const { usageStatus } = require('../../shared/usageStatus.mjs');
const settings = require('./settings');

// THE ALLOWANCE IS AN ADMIN SETTING, read per call.
//
// It used to be an environment variable, WORKSPACE_LIMIT_BYTES, which had to be
// changed on the box and needed a restart. That is gone rather than kept
// alongside: two places to set the same limit is how the number in the panel
// and the number refusing an upload end up different.
//
// THIS IS THE ONLY CONVERSION FROM GB TO BYTES. The setting is stated in GB
// because that is what an administrator types and reads; everything downstream
// of here is bytes. One conversion, in one place, so "GB" cannot mean 10^9
// here and 1024^3 there.
const BYTES_PER_GB = 1024 * 1024 * 1024;

function workspaceLimitBytes() {
    return settings.getSetting('workspace_limit_gb') * BYTES_PER_GB;
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

function workspaceUsage(workspaceId) {
    const rows = workspaceStoredFileIds.all(workspaceId);

    let bytes = 0;
    for (const row of rows) {
        const file = fileSizeOf.get(row.id);
        if (file) bytes += file.file_size;
    }

    const limit_bytes = workspaceLimitBytes();

    const percent_used = limit_bytes > 0
        ? Math.round((bytes / limit_bytes) * 1000) / 10
        : 0;

    return {
        bytes,
        limit_bytes,
        remaining_bytes: Math.max(0, limit_bytes - bytes),
        file_count: rows.length,
        percent_used,
        status: usageStatus(percent_used, {
            warning: settings.getSetting('usage_warning_percent'),
            critical: settings.getSetting('usage_critical_percent'),
        })
    };
}

// No exported limit value: it is a setting, and a value exported from here
// would be a snapshot a caller could hold. workspaceUsage() already reports the
// limit it applied, as limit_bytes, so a caller that needs the figure has it
// from the same read that produced the usage.
module.exports = { BYTES_PER_GB, workspaceLimitBytes, workspaceUsage };
