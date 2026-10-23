// backend/lib/backfillManifestHashes.js
//
// GIVE EVERY VERSION ITS CONTENT IDENTITY, including the ones that were already
// in the database when the column arrived.
//
// ============================================================
// WHY THIS IS NOT IN db.js, WHICH IS WHERE THE SCHEMA LIVES
// ============================================================
//
// db.js MUST BE SELF-CONTAINED. scripts/check-schema-drift.js copies it ALONE
// into a temp directory and symlinks only node_modules, which is how it proves
// the schema comes from db.js rather than from the live database. A sibling
// require there breaks that check — and it did: this code lived in db.js for an
// hour before check:schema caught it, which is the check doing its job.
//
// So the schema stays in db.js and the DATA REPAIR lives here, called from
// server.js once the database is open.
//
// ============================================================
// WHY IT RUNS AT ALL
// ============================================================
//
// A version without its manifest_hash is a version that cannot be compared with
// an upload, and nothing would say why. Rather than leave that until somebody
// noticed, the column is filled in from the files each version already holds.
//
// IT IS IDEMPOTENT. It selects only rows where the column is NULL, so it does
// nothing after the first run and nothing at all on a fresh database.

const { manifestHash } = require('./manifestHash');

const TARGETS = [
    {
        versions: 'workspace_versions',
        files: 'workspace_version_files',
        key: 'workspace_version_id'
    },
    {
        versions: 'asset_versions',
        files: 'asset_version_files',
        key: 'asset_version_id'
    }
];

/**
 * Fill in manifest_hash wherever it is missing.
 *
 * @param {object} db  the better-sqlite3 handle
 * @returns {number} how many rows were written, across both tables
 */
function backfillManifestHashes(db) {
    let written = 0;

    for (const target of TARGETS) {
        const pending = db.prepare(
            `SELECT id FROM ${target.versions} WHERE manifest_hash IS NULL`
        ).all();

        if (pending.length === 0) continue;

        const filesOf = db.prepare(`
            SELECT f.relative_path, f.filename, sf.sha256, sf.file_size AS size
            FROM ${target.files} f
            JOIN stored_files sf ON sf.id = f.stored_file_id
            WHERE f.${target.key} = ?
        `);

        const setHash = db.prepare(
            `UPDATE ${target.versions} SET manifest_hash = ? WHERE id = ?`
        );

        db.transaction(() => {
            for (const row of pending) {
                setHash.run(manifestHash(filesOf.all(row.id)), row.id);
            }
        })();

        written += pending.length;

        console.log(
            `  manifest hashes backfilled: ${pending.length} in ${target.versions}`
        );
    }

    return written;
}

module.exports = { backfillManifestHashes };
