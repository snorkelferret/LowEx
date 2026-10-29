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
 *   1. THE PURGE — versions deleted longer ago than the retention window lose
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

const db = require('../db');
const audit = require('../lib/audit');
const { findProblems } = require('../lib/storeIntegrity');
const { purgeVersionFiles, expiredVersions } = require('../lib/wastebin');
// The window is an admin setting. This job is a fresh process on every cron
// run, so reading it once here would be safe — but retentionDays() is called
// at the point of use anyway, so there is no snapshot to forget about.
const { retentionDays } = require('../lib/retention');
// Where the blobs are, and the only safe way to build a path to one. This job
// is the only thing in the system that deletes content, so it is the last place
// that should be deriving the path for itself.
const { BLOB_DIR: STORE_DIR, blobPath, thumbPath } = require('../lib/storagePaths');
// The collector itself — shared with the check, see the note over section 2.
const { createCollector } = require('../lib/collector');

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
//
// THE CODE IS IN backend/lib/collector.js, and that is for the check's sake as
// much as the job's: a check can only test what a throwaway database can be
// pointed at. Everything below this line in the original — what counts as
// garbage, the files-first ordering, why previews do not protect a blob — moved
// there with it.
//
// The paths are the REAL ones. The check passes its own, which is the only
// difference between the two callers.

const collector = createCollector({ db, blobPath, thumbPath, say });

function runCollector(sound) {
    return collector.collect({
        graceHours: GRACE_HOURS,
        limit: COLLECT_LIMIT,
        dryRun: DRY_RUN,
        remove: COLLECT,
        sound
    });
}


// ============================================================

async function main() {
    const started = new Date();

    say('');
    say(`  daily job — ${started.toISOString().replace('T', ' ').slice(0, 19)}`);
    say(`  retention : ${retentionDays()} days   grace: ${GRACE_HOURS}h`);
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
