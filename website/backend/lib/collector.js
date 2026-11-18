// backend/lib/collector.js
//
// THE COLLECTOR — the one thing in this system that destroys content.
//
// It finds blobs that NO table points at any more and removes their files and
// their rows. Everything else in the portal adds; this subtracts, permanently,
// which is why it is the code most worth testing and the code least able to
// test itself.
//
// ============================================================
// WHY IT LIVES HERE RATHER THAN IN THE JOB
// ============================================================
//
// It was in backend/jobs/daily.js, bound to the live database at require time.
// That made it unrunnable against a fixture: a check could only test it by
// running the real job against the real store, which is exactly the wrong way
// to find out that the real job deletes the wrong thing.
//
// So the dependencies are arguments — db, blobPath, thumbPath, say — and the
// job and the check construct it differently. Same code, same statements, same
// ordering; the check simply points it at a throwaway database and two
// throwaway directories. This is the arrangement storeIntegrity already has
// with check:store, and for the same reason.
//
// WHAT IT IS GIVEN, AND WHAT THAT MEANS:
//
//   db        the database. Any database with the schema.
//   blobPath  builds the path to a blob from its storage_key. The REAL one is
//             storagePaths.blobPath, which validates the key and returns null
//             for anything that is not a SHA-256.
//   thumbPath builds the path to a preview from (storage_key, kind).
//   say       where the running commentary goes. Silent in a check.

const fs = require('fs');

/**
 * Build a collector bound to one database and one pair of path builders.
 *
 * The prepared statements are created once, here, so every call — the nightly
 * job, the check, a future one-off — asks exactly the same question of exactly
 * the same query.
 */
function createCollector({ db, blobPath, thumbPath, say = () => {} }) {

    // ============================================================
    // WHAT COUNTS AS GARBAGE
    // ============================================================
    //
    // A stored file is garbage when NO table points at it. ALL THREE are
    // checked: a workspace can reference content the store has never seen, the
    // store can reference content no workspace holds any more, and the LIBRARY
    // holds content that is in neither — the overlap is exactly where the
    // interesting cases live.
    //
    // THE LIBRARY CLAUSE IS NOT OPTIONAL, AND ITS ABSENCE IS SILENT.
    // library_items is the THIRD referencer of stored_files. Before it existed,
    // this query was complete. With it, a missing clause here means EVERY
    // LIBRARY BLOB becomes collectable the moment it ages past the grace
    // window — the library empties itself on a schedule, with no error, and the
    // first symptom is a page of broken thumbnails and a store that has "lost"
    // files nobody deleted.
    //
    // SO IF A FOURTH REFERENCER EVER APPEARS, IT BELONGS IN THIS LIST, and the
    // same is true of the quota exclusion in backend/lib/workspaceUsage.js.
    // Those two are the only places that enumerate what may reference a blob.
    //
    // A SOFT-DELETED LIBRARY ITEM DOES NOT PROTECT ITS BLOB. Removing something
    // from the library is the act of releasing it, so `is_active = 1` in the
    // query is deliberate and the released blob is freed when nothing else
    // holds it.
    //
    // BUT THE RELEASED ROW CANNOT OUTLIVE THE BLOB. library_items.stored_file_id
    // is NOT NULL and the foreign key is not cascaded, so leaving the row behind
    // makes the DELETE below fail with a constraint error — the whole run
    // aborts, and the collector stops freeing disk until somebody reads the log.
    // The row goes too, scoped to `is_active = 0` so an active item can never be
    // removed by mistake. This was found by tests/check-collector.js, not by
    // reading: the rule had been stated and never exercised.
    //
    // FILE_THUMBNAILS IS THE FIRST REFERENCER THAT DOES NOT BELONG IN THE LIST
    // ABOVE. A preview is produced FROM a blob — derived content, named from
    // its hash — so it does not keep the blob alive, and a preview row must
    // never stop a blob being collected. What it does mean is that the
    // collector has to clear the rows and the preview files itself, because
    // they are not cascaded: see removePreviews() and the delete below.
    const unreferenced = db.prepare(`
        SELECT id, storage_key, file_size, created_at
        FROM stored_files sf
        WHERE sf.created_at <= datetime('now', '-' || ? || ' hours')
          AND NOT EXISTS (
              SELECT 1 FROM workspace_version_files WHERE stored_file_id = sf.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM asset_version_files WHERE stored_file_id = sf.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM library_items
              WHERE stored_file_id = sf.id
                AND is_active = 1
          )
        ORDER BY sf.id
        LIMIT ?
    `);

    const previewKindsFor = db.prepare(
        'SELECT kind FROM file_thumbnails WHERE stored_file_id = ?'
    );

    // THE PREVIEWS GO WHEN THE BLOB GOES.
    //
    // They are derived content and their names are derived from the hash, so
    // once the blob has been collected nothing can reach them again — leaving
    // them would be a slow leak of files nothing will ever ask for. ENOENT is
    // fine here for the same reason it is fine for a blob: the file may already
    // be gone, and the row is what this call is clearing the way for.
    function removePreviews(storageKey, storedFileId) {
        for (const { kind } of previewKindsFor.all(storedFileId)) {
            const preview = thumbPath(storageKey, kind);

            if (!preview) continue;

            try {
                fs.unlinkSync(preview);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    say(`  collector : could not remove preview ${preview}: ${err.message}`);
                }
            }
        }
    }

    /**
     * One run.
     *
     *   graceHours  a blob younger than this is never collected
     *   limit       a ceiling on one run
     *   dryRun      report what would go; change nothing
     *   remove      actually remove. FALSE does not delete, and that is the
     *               default because a collector that destroys content on its
     *               first run, having never been watched, is how a store gets
     *               emptied by a bug.
     *   sound       the caller's verdict on the store (check:store). The
     *               collector refuses to destroy anything on an unsound store:
     *               what it does cannot be undone.
     *
     * Returns { blobs, bytes, wouldRemove }.
     */
    function collect({
        graceHours = 24,
        limit = 500,
        dryRun = false,
        remove = false,
        sound = true
    } = {}) {
        const garbage = unreferenced.all(graceHours, limit);

        if (garbage.length === 0) {
            say('  collector : nothing to collect');
            return { blobs: 0, bytes: 0 };
        }

        const bytes = garbage.reduce((total, row) => total + (row.file_size || 0), 0);

        // Not enabled, or the store is not sound: report and stop.
        if (!remove || dryRun || !sound) {
            const why = dryRun ? 'dry run'
                : !remove ? 'report only — pass --collect to remove'
                : 'store is not sound';

            say(`  collector : would remove ${garbage.length} blob(s), ${bytes} bytes (${why})`);

            for (const row of garbage.slice(0, 10)) {
                say(`              ${row.storage_key} (${row.file_size} bytes, written ${row.created_at})`);
            }

            if (garbage.length > 10) {
                say(`              ... and ${garbage.length - 10} more`);
            }

            return { blobs: 0, bytes: 0, wouldRemove: garbage.length };
        }

        // FILES FIRST, ROWS SECOND, and the order is deliberate.
        //
        // Unlinking first means a failure leaves the row intact — a blob that
        // is still referenced and still present, which is the consistent state.
        // Doing it the other way round and failing in between would leave a ROW
        // WITH NO FILE, which is worse than an orphan: it is a download that
        // fails, and every reference to it is broken.
        let removed = 0;
        let freed = 0;
        const gone = [];

        for (const row of garbage) {
            // blobPath() returns null for a key that is not a plain SHA-256.
            // There should never be one — the collector refuses to run on a
            // store that fails its integrity check, which reports a malformed
            // key as fatal — but this is the line that destroys data, and a
            // null here means "nothing to delete" rather than a path built from
            // a bad string.
            const blob = blobPath(row.storage_key);

            if (!blob) {
                say(`  collector : REFUSING malformed storage_key ${row.storage_key}`);
                continue;
            }

            try {
                fs.unlinkSync(blob);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    say(`  collector : could not remove ${row.storage_key}: ${err.message}`);
                    continue;
                }
                // ENOENT is fine — the blob was already gone, and the row is
                // stale.
            }

            removePreviews(row.storage_key, row.id);

            gone.push(row);
            removed++;
            freed += row.file_size || 0;
        }

        if (gone.length) {
            db.transaction(() => {
                const drop = db.prepare('DELETE FROM stored_files WHERE id = ?');
                const dropReferences = db.prepare(
                    'DELETE FROM asset_version_files WHERE stored_file_id = ?'
                );
                // The FK to stored_files is not cascaded, on purpose: nothing
                // in the schema may quietly destroy a row. file_thumbnails is
                // derived, so its rows go here, before the blob's row can be
                // refused by the constraint.
                const dropPreviews = db.prepare(
                    'DELETE FROM file_thumbnails WHERE stored_file_id = ?'
                );
                // A RELEASED LIBRARY ITEM GOES WITH ITS BLOB, and only a
                // released one. The query above excludes active items, so this
                // cannot touch a live one even if the two ever disagreed.
                const dropReleasedLibraryItem = db.prepare(
                    'DELETE FROM library_items WHERE stored_file_id = ? AND is_active = 0'
                );

                for (const row of gone) {
                    // Belt and braces. The query above proved nothing
                    // referenced these, but a reference added between then and
                    // now would otherwise be silently orphaned by the delete
                    // below.
                    dropReferences.run(row.id);
                    dropPreviews.run(row.id);
                    dropReleasedLibraryItem.run(row.id);
                    drop.run(row.id);
                }
            })();
        }

        say(`  collector : removed ${removed} blob(s), ${freed} bytes freed`);

        if (garbage.length === limit) {
            say(`              hit the ${limit} limit — more is due, run again`);
        }

        return { blobs: removed, bytes: freed };
    }

    return { collect };
}

module.exports = { createCollector };
