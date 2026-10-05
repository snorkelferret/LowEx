#!/usr/bin/env node
/**
 * Checks the CONTENT-ADDRESSED STORE — the heart of the system.
 *
 *   node scripts/check-store.js            # exit 0 = clean
 *
 * THE DETECTION IS IN backend/lib/storeIntegrity.js, not here. That is not
 * tidiness: backend/jobs/daily.js refuses to collect garbage unless the store
 * is sound, and it asks the same question through the same code. Two
 * implementations of "is the store consistent" would eventually disagree, and
 * the one that agreed with itself would be whichever ran last.
 *
 * This file is the command-line half: where the store is, what the answer looks
 * like on screen, and what the exit code should be.
 *
 * WHAT IT PROVES, in decreasing order of how much it matters:
 *
 *   1. CONTENT ADDRESSING IS INTACT. Every blob's bytes actually hash to the
 *      name it is stored under. If a file's contents ever stop matching its
 *      name, every reference to it is silently serving the wrong thing, and
 *      nothing else in the system would notice. Also the slow check.
 *
 *   2. NO DANGLING ROWS. Every stored_files row has its blob. A row without a
 *      file is a download that 500s.
 *
 *   3. NO ORPHAN BLOBS. Every file on disk has a row. An orphan occupies space
 *      and is referenced by nothing.
 *
 *   4. SIZES MATCH. stored_files.file_size equals the real size on disk.
 *
 * NOTE WHAT IT DOES NOT CHECK: whether anything REFERENCES a blob. A row with
 * no referrers is not a fault — it is garbage waiting to be collected, and
 * finding those is the collector's job in backend/jobs/daily.js.
 *
 * READ ONLY, so it is safe against a live server. It cannot write.
 *
 *   --quick   skip hashing; check presence and sizes only (fast on big stores)
 *   --deep    the default; re-hash every blob
 *
 * DB_PATH and STORE_DIR override the defaults, so a backup or a copied store
 * can be checked without touching the live one.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { findProblems } = require('../backend/lib/storeIntegrity');

const ROOT = path.join(__dirname, '..');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(ROOT, 'backend/database.db');

// The default comes from the module that owns the layout; STORE_DIR still
// overrides it, because checking a backup without touching the live store is
// the whole reason this script takes one.
const STORE_DIR = process.env.STORE_DIR
    ? path.resolve(process.env.STORE_DIR)
    : require('../backend/lib/storagePaths').BLOB_DIR;

const quick = process.argv.includes('--quick');

(async () => {
    console.log(`\n  store  : ${STORE_DIR}`);
    console.log(`  db     : ${DB_PATH}`);
    console.log(`  mode   : ${quick ? 'quick (no hashing)' : 'deep (re-hashes every blob)'}`);

    if (!fs.existsSync(DB_PATH)) {
        console.error(`\n  FAIL — no database at ${DB_PATH}\n`);
        process.exit(1);
    }

    // readonly, so this cannot accidentally write.
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    const { rows, blobs, problems } =
        await findProblems(db, STORE_DIR, { deep: !quick });

    console.log(`\n  rows: ${rows}   blobs on disk: ${blobs}\n`);

    for (const problem of problems) {
        console.log(`  FAIL  ${problem.message}`);
        if (problem.detail) console.log(`        ${problem.detail}`);
    }

    console.log(`  ${rows} row(s) checked`);
    if (!quick) console.log(`  every blob re-hashed`);

    if (problems.length === 0) {
        console.log('\n  PASS — the store and the database agree\n');
        process.exit(0);
    }

    console.log(`\n  FAIL — ${problems.length} problem(s)\n`);
    process.exit(1);
})().catch(err => {
    console.error('\n  check-store crashed:', err.message, '\n');
    process.exit(1);
});
