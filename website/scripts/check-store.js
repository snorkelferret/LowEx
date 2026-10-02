#!/usr/bin/env node
/**
 * Checks the CONTENT-ADDRESSED STORE — the heart of the system.
 *
 *   node scripts/check-store.js            # exit 0 = clean
 *
 * Every file in the project exists exactly once, named by its own SHA-256.
 * stored_files has UNIQUE (sha256) so the database enforces that, but the
 * DATABASE AND THE DISK ARE TWO THINGS, and nothing enforces that they agree.
 * This walks both and compares.
 *
 * WHAT IT PROVES, in decreasing order of how much it matters:
 *
 *   1. CONTENT ADDRESSING IS INTACT. Every blob's bytes actually hash to the
 *      name it is stored under. This is the one that matters most: if a file's
 *      contents ever stop matching its name, every reference to it is silently
 *      serving the wrong thing, and nothing else in the system would notice.
 *      It is also the slow check, because it re-reads every byte.
 *
 *   2. NO DANGLING ROWS. Every stored_files row has its blob on disk. A row
 *      without a file is a download that 500s.
 *
 *   3. NO ORPHAN BLOBS. Every file on disk has a row. An orphan occupies space
 *      and is referenced by nothing. Cheap to find, and the usual cause is a
 *      crash between writing the file and committing the row.
 *
 *   4. SIZES MATCH. stored_files.file_size equals the real size on disk. The
 *      size is recorded from the upload, not measured from the stored file, so
 *      nothing has ever checked the two agree.
 *
 * READ ONLY. It opens the database read-only and never writes, so it is safe to
 * run against a live server — though --deep reads every byte, which is I/O
 * heavy on a large store.
 *
 *   --quick   skip hashing; check presence and sizes only (fast on big stores)
 *   --deep    the default; re-hash every blob
 *
 * DB_PATH and STORE_DIR override the defaults, so a backup or a copied store
 * can be checked without touching the live one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(ROOT, 'backend/database.db');

const STORE_DIR = process.env.STORE_DIR
    ? path.resolve(process.env.STORE_DIR)
    : path.join(ROOT, 'backend/uploads/files');

const quick = process.argv.includes('--quick');

const SHA256_HEX = /^[0-9a-f]{64}$/;

let problems = 0;
const report = (label, detail = '') => {
    problems++;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
};

function sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

(async () => {
    console.log(`\n  store  : ${STORE_DIR}`);
    console.log(`  db     : ${DB_PATH}`);
    console.log(`  mode   : ${quick ? 'quick (no hashing)' : 'deep (re-hashes every blob)'}`);

    if (!fs.existsSync(DB_PATH)) {
        console.error(`\n  FAIL — no database at ${DB_PATH}\n`);
        process.exit(1);
    }

    // immutable=1 tells SQLite the file will not change, so it skips locking
    // entirely. It also means this cannot accidentally write.
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    const rows = db.prepare(`
        SELECT id, sha256, file_size, storage_key, mime_type
        FROM stored_files
        ORDER BY id
    `).all();

    const onDisk = fs.existsSync(STORE_DIR)
        ? fs.readdirSync(STORE_DIR).filter(name => {
            // The store is flat. Anything that is not a plain file is either a
            // stray directory or something a reset script left behind.
            return fs.statSync(path.join(STORE_DIR, name)).isFile();
        })
        : [];

    console.log(`\n  rows: ${rows.length}   blobs on disk: ${onDisk.length}\n`);

    const seenSha = new Set();
    const seenKey = new Set();

    // ---------------------------------------------------------------- rows

    for (const row of rows) {
        const label = `stored_files #${row.id}`;

        // The database enforces these, so a failure here means something wrote
        // to the table without going through the upload route.
        if (seenSha.has(row.sha256)) {
            report(`${label}: duplicate sha256`, row.sha256);
        }
        if (seenKey.has(row.storage_key)) {
            report(`${label}: duplicate storage_key`, row.storage_key);
        }
        seenSha.add(row.sha256);
        seenKey.add(row.storage_key);

        if (!SHA256_HEX.test(String(row.sha256))) {
            report(`${label}: sha256 is not 64 lowercase hex`, String(row.sha256));
            continue;
        }

        // storage_key IS the sha256 — that is what makes the path safe to build
        // from the column without validating the column first. If these ever
        // diverge, the serving route's hex check is validating the wrong string.
        if (row.storage_key !== row.sha256) {
            report(
                `${label}: storage_key does not equal sha256`,
                `sha=${row.sha256} key=${row.storage_key}`
            );
        }

        const blobPath = path.join(STORE_DIR, String(row.storage_key));

        let stat;
        try {
            stat = fs.statSync(blobPath);
        } catch {
            report(
                `${label}: NO BLOB ON DISK`,
                `${row.storage_key} — a download of this file will fail`
            );
            continue;
        }

        if (stat.size !== row.file_size) {
            report(
                `${label}: size disagrees with disk`,
                `db says ${row.file_size}, disk says ${stat.size}`
            );
        }

        if (!quick) {
            const actual = await sha256OfFile(blobPath);

            if (actual !== row.sha256) {
                report(
                    `${label}: CONTENTS DO NOT MATCH THE NAME`,
                    `stored as ${row.sha256}\n` +
                    `        actually ${actual}\n` +
                    `        every reference to this file is serving something else`
                );
            }
        }
    }

    // ---------------------------------------------------------------- blobs

    for (const name of onDisk) {
        if (!seenKey.has(name)) {
            const size = fs.statSync(path.join(STORE_DIR, name)).size;
            report(
                `orphan blob on disk: ${name}`,
                `${size} bytes, referenced by no row`
            );
        }
    }

    // ------------------------------------------------------------- summary

    const db2 = { bytes: rows.reduce((n, r) => n + (r.file_size || 0), 0) };

    console.log(`  ${rows.length} row(s) checked`);
    if (!quick) console.log(`  every blob re-hashed`);
    console.log(`  recorded size: ${(db2.bytes / 1024 / 1024).toFixed(1)} MB\n`);

    if (problems === 0) {
        console.log('  PASS — the store and the database agree\n');
        process.exit(0);
    }

    console.log(`  FAIL — ${problems} problem(s)\n`);
    process.exit(1);
})().catch(err => {
    console.error('\n  check-store crashed:', err.message, '\n');
    process.exit(1);
});
