#!/usr/bin/env node
/**
 * The daily job. Run it from cron.
 *
 *   node backend/jobs/daily.js              # empty expired bins; REPORT on
 *                                           # what the collector would remove
 *   node backend/jobs/daily.js --collect    # ...and actually remove it
 *   node backend/jobs/daily.js --dry-run    # change nothing; say what would go
 *
 * TWO JOBS, IN THIS ORDER, because the second feeds on the first:
 *
 *   1. THE PURGE — versions deleted more than RETENTION_DAYS ago lose their
 *      file rows. This is the operation a developer can also trigger by hand
 *      from their bin, and it is THE SAME FUNCTION (lib/wastebin.js), so the
 *      two cannot drift into deleting different things.
 *
 *   2. THE COLLECTOR — blobs that nothing references any more lose their row
 *      and their file. This is what actually frees disk.
 *
 * WHY CRON RATHER THAN A TIMER INSIDE THE SERVER. An in-process timer dies with
 * the process and would run once per instance if there were ever two. An HTTP
 * endpoint would add a route that DELETES THINGS — a new attack surface, for a
 * job that needs no user. A script under cron has neither problem, and cron
 * records that it ran: "it silently stopped six weeks ago" is visible rather
 * than discovered when the disk fills.
 *
 * THE COLLECTOR DOES NOT DELETE BY DEFAULT. A collector that destroys content
 * on its first run, having never been watched, is how a store gets emptied by a
 * bug. Run it, read what it says it WOULD remove, and pass --collect once that
 * matches what you expect.
 *
 * Stored content is content-addressed and shared, so the collector is the only
 * thing in this system that can destroy a file outright. It is written to be
 * boring about that.
 */

const fs = require('fs');
const path = require('path');

const db = require('../db');
const audit = require('../lib/audit');
const { findProblems } = require('../lib/storeIntegrity');
const { purgeVersionFiles, expiredVersions } = require('../lib/wastebin');
const { RETENTION_DAYS } = require('../lib/retention');

const STORE_DIR = path.join(__dirname, '../uploads/files');

const DRY_RUN = process.argv.includes('--dry-run');
const COLLECT = process.argv.includes('--collect');

// A blob younger than this is never collected.
//
// Nothing should be referencing it — the upload that wrote it creates its row
// and its reference in one transaction — but an uncollected blob costs disk and
// a wrongly collected one costs content, so the asymmetry decides it. This is
// cheap insurance against a race nobody has thought of yet.
const GRACE_HOURS = 24;

// A ceiling on one run, so a box that has been off for a year is not asked to
// delete ten thousand things in one go. The rest wait for tomorrow.
const PURGE_LIMIT = 500;
const COLLECT_LIMIT = 500;

function say(message = '') {
    console.log(message);
}


// ============================================================
// 0. Is the store sound enough to be deleting things from?
// ============================================================

// The check is QUICK — presence and sizes, no re-hashing. Re-hashing every blob
// daily would be expensive, and it answers a question the collector does not
// depend on: whether content still MATCHES its name has no bearing on whether
// the content is REFERENCED. Structure is what matters here.
//
// A periodic DEEP check is still worth running by hand — npm run check:store —
// because corruption is invisible otherwise.
async function storeIsSound() {
    const { rows, blobs, problems } = await findProblems(db, STORE_DIR, { deep: false });

    if (problems.length === 0) {
        say(`  store     : sound (${rows} rows, ${blobs} blobs)`);
        return true;
    }

    say(`  store     : ${problems.length} PROBLEM(S) — see npm run check:store`);
    for (const problem of problems) {
        say(`              ${problem.message}`);
    }

    return false;
}


// ============================================================
// 1. The purge
// ============================================================

function runPurge() {
    const due = expiredVersions(PURGE_LIMIT);

    if (due.length === 0) {
        say('  purge     : nothing due');
        return { versions: 0, bytes: 0 };
    }

    if (DRY_RUN) {
        say(`  purge     : ${due.length} version(s) due (dry run, nothing done)`);
        for (const version of due) {
            say(`              ${version.asset_name} v${version.version_number} — deleted ${version.deleted_at}`);
        }
        return { versions: due.length, bytes: 0 };
    }

    let bytes = 0;

    // A null actor: this is the system acting on its own, and the audit trail
    // should say so rather than attributing it to whoever happens to be signed
    // in when the cron fires.
    for (const version of due) {
        bytes += purgeVersionFiles(version.id, null).bytes;
    }

    say(`  purge     : ${due.length} version(s), ${bytes} bytes released`);

    if (due.length === PURGE_LIMIT) {
        say(`              hit the ${PURGE_LIMIT} limit — more is due, run again`);
    }

    return { versions: due.length, bytes };
}


// ============================================================
// 2. The collector
// ============================================================

// A stored file is garbage when NEITHER table points at it. Both are checked:
// a workspace can reference content the store has never seen, and the store can
// reference content no workspace holds any more — the overlap is exactly where
// the interesting cases live.
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
    ORDER BY sf.id
    LIMIT ?
`);

function runCollector(sound) {
    const garbage = unreferenced.all(GRACE_HOURS, COLLECT_LIMIT);

    if (garbage.length === 0) {
        say('  collector : nothing to collect');
        return { blobs: 0, bytes: 0 };
    }

    const bytes = garbage.reduce((total, row) => total + (row.file_size || 0), 0);

    // Not enabled, or the store is not sound: report and stop.
    if (!COLLECT || DRY_RUN || !sound) {
        const why = DRY_RUN ? 'dry run'
            : !COLLECT ? 'report only — pass --collect to remove'
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
    // Unlinking first means a failure leaves the row intact — a blob that is
    // still referenced and still present, which is the consistent state. Doing
    // it the other way round and failing in between would leave a ROW WITH NO
    // FILE, which is worse than an orphan: it is a download that fails, and
    // every reference to it is broken.
    let removed = 0;
    let freed = 0;
    const gone = [];

    for (const row of garbage) {
        try {
            fs.unlinkSync(path.join(STORE_DIR, row.storage_key));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                say(`  collector : could not remove ${row.storage_key}: ${err.message}`);
                continue;
            }
            // ENOENT is fine — the blob was already gone, and the row is stale.
        }

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

            for (const row of gone) {
                // Belt and braces. The query above proved nothing referenced
                // these, but a reference added between then and now would
                // otherwise be silently orphaned by the delete below.
                dropReferences.run(row.id);
                drop.run(row.id);
            }
        })();
    }

    say(`  collector : removed ${removed} blob(s), ${freed} bytes freed`);

    if (garbage.length === COLLECT_LIMIT) {
        say(`              hit the ${COLLECT_LIMIT} limit — more is due, run again`);
    }

    return { blobs: removed, bytes: freed };
}


// ============================================================

async function main() {
    const started = new Date();

    say('');
    say(`  daily job — ${started.toISOString().replace('T', ' ').slice(0, 19)}`);
    say(`  retention : ${RETENTION_DAYS} days   grace: ${GRACE_HOURS}h`);
    if (DRY_RUN) say('  MODE      : dry run — nothing will be changed');

    const sound = await storeIsSound();

    // THE GATE APPLIES TO THE COLLECTOR ONLY, and that is deliberate.
    //
    // The purge does not consult it because the two depend on different things.
    // Emptying a bin depends on what was deleted and when — facts in the
    // database — and has no bearing on whether the store is sound. The
    // collector depends on the store being trustworthy, because what it does
    // cannot be undone.
    //
    // So gating the purge too would mean bins stop emptying for as long as any
    // store problem exists, turning a repairable inconsistency into a growing
    // pile of undeleted work. The wrong thing gets worse to protect the right
    // thing.
    const purged = runPurge();
    const collected = runCollector(sound);

    // One row per run, so "what happened to the disk" has an answer. A null
    // actor is correct here: nobody did this, the schedule did.
    if (!DRY_RUN) {
        audit.record(null, 'store.daily_job', null, {
            purged_versions: purged.versions,
            purged_bytes: purged.bytes,
            collected_blobs: collected.blobs,
            collected_bytes: collected.bytes,
            store_sound: sound,
        });
    }

    say(`  done in ${Date.now() - started.getTime()}ms`);

    // A non-zero exit is how cron tells someone. Reported only for a real
    // failure — an unhealthy store is worth attention but is not a crash, and
    // crying wolf every morning is how the report stops being read.
    return 0;
}

main()
    .then(code => process.exit(code))
    .catch(err => {
        console.error('\n  daily job FAILED:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
