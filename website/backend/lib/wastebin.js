// backend/lib/wastebin.js
//
// Removing the content of deleted work, and finding what is due.
//
// A LIBRARY BECAUSE TWO CALLERS MUST DO IT IDENTICALLY:
//
//   * the route a developer uses to empty part of their bin by hand
//     (POST .../versions/:versionId/purge)
//   * the daily job that empties it on time (backend/jobs/daily.js)
//
// A purge written twice would eventually differ, and the difference would be in
// what gets deleted. That is not a class of bug worth having two of.

const db = require('../db');
const audit = require('./audit');
const { RETENTION_DAYS } = require('./retention');

/**
 * Remove a version's content, keeping the record of it.
 *
 * THE WHOLE OPERATION IS THE DELETE OF workspace_version_files. Those rows hold
 * the only reference from this workspace to the stored content, so removing
 * them is what makes the content unreachable — and eventually collectable.
 *
 * WHAT IT DOES NOT DO: remove the blob. A blob is freed when NOTHING references
 * it, and for content that reached the game store, asset_version_files still
 * does. So a developer physically deleting their copy of approved work cannot
 * take it out of the game — the store's own reference keeps it alive, which is
 * the rule enforcing itself rather than being asserted.
 *
 * The manifest is what is kept in the files' place: names, paths, sizes and
 * hashes. If it ever starts holding content, the point has been undone.
 *
 * Safe to call twice — the second call finds no rows, writes an empty manifest
 * over the first, and reports nothing freed. Callers should still check
 * files_purged_at first so the answer they give reads sensibly.
 */
function purgeVersionFiles(versionId, actorId) {
    const files = db.prepare(`
        SELECT
            wvf.filename,
            wvf.relative_path,
            sf.file_size,
            sf.sha256
        FROM workspace_version_files wvf
        JOIN stored_files sf ON sf.id = wvf.stored_file_id
        WHERE wvf.workspace_version_id = ?
        ORDER BY COALESCE(wvf.relative_path, '') COLLATE NOCASE, wvf.filename COLLATE NOCASE
    `).all(versionId);

    const manifest = files.map(file => ({
        filename: file.filename,
        path: file.relative_path || null,
        size: file.file_size,
        sha256: file.sha256,
    }));

    const bytes = files.reduce((total, file) => total + (file.file_size || 0), 0);

    const purge = db.transaction(() => {
        db.prepare(`
            DELETE FROM workspace_version_files
            WHERE workspace_version_id = ?
        `).run(versionId);

        db.prepare(`
            UPDATE workspace_versions
            SET
                files_purged_at = COALESCE(files_purged_at, CURRENT_TIMESTAMP),
                purged_file_manifest = ?
            WHERE id = ?
        `).run(JSON.stringify(manifest), versionId);

        audit.record(
            actorId,
            'workspace_version.purge',
            `workspace_version:${versionId}`,
            { files: manifest.length, bytes }
        );
    });

    purge();

    return { files: manifest.length, bytes };
}

/**
 * Every version whose retention window has closed and whose files are still
 * there.
 *
 * Scoped to VERSIONS rather than assets, because files belong to versions — an
 * asset is only ever as purged as its versions are, so walking the versions
 * covers everything without a second pass over the assets.
 *
 * The comparison is done in SQL so it uses the same clock as deleted_at was
 * written with. Doing it in JavaScript would mean trusting this process's idea
 * of "now" against a timestamp the database wrote.
 *
 * @param limit  a ceiling on one run, so a box that has been off for a year
 *               cannot be asked to delete ten thousand versions in one go
 */
function expiredVersions(limit = 500) {
    return db.prepare(`
        SELECT
            wv.id,
            wv.version_number,
            wv.deleted_at,
            wa.name AS asset_name
        FROM workspace_versions wv
        JOIN workspace_assets wa ON wa.id = wv.workspace_asset_id
        WHERE wv.is_active = 0
          AND wv.files_purged_at IS NULL
          AND wv.deleted_at IS NOT NULL
          AND datetime(wv.deleted_at, '+' || ? || ' days') <= datetime('now')
        ORDER BY wv.deleted_at
        LIMIT ?
    `).all(RETENTION_DAYS, limit);
}

module.exports = { purgeVersionFiles, expiredVersions };
