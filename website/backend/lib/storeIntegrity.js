// backend/lib/storeIntegrity.js
//
// Does the content store agree with the database?
//
// A LIBRARY, because two callers need the answer and they must not disagree:
//
//   * scripts/check-store.js — the command someone runs by hand.
//   * backend/jobs/daily.js — which REFUSES TO COLLECT GARBAGE unless the
//     store is sound. Collecting from a store you cannot trust is how a
//     repairable problem becomes an unrepairable one.
//
// The database enforces most of this on its own — UNIQUE (sha256) means one row
// per content — but the DATABASE AND THE DISK ARE TWO THINGS, and nothing else
// enforces that they agree.
//
// Read-only. It never writes, and takes a database handle rather than opening
// one, so a caller can hand it a read-only connection.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The key format, from the module that owns the layout. This file used to carry
// its own copy of the regex — which is how a second copy starts, and the other
// copy guards a download path.
const { isStorageKey } = require('./storagePaths');

function sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * Walk the store and the database and report every disagreement.
 *
 * @param db        an open better-sqlite3 handle
 * @param storeDir  the flat content directory
 * @param options   { deep } — deep re-hashes every blob. Slow, and the only
 *                  way to catch content that no longer matches its own name.
 *
 * @returns { rows, blobs, problems: [{ level, message, detail }] }
 *          level is 'fatal' for anything that means the store cannot be
 *          trusted, which is what the collector gates on.
 */
async function findProblems(db, storeDir, { deep = true } = {}) {
    const problems = [];

    const rows = db.prepare(`
        SELECT id, sha256, file_size, storage_key, mime_type
        FROM stored_files
        ORDER BY id
    `).all();

    let blobs = [];

    try {
        blobs = fs.readdirSync(storeDir).filter(name =>
            fs.statSync(path.join(storeDir, name)).isFile());
    } catch {
        blobs = [];
    }

    const seenSha = new Set();
    const seenKey = new Set();

    for (const row of rows) {
        const label = `stored_files #${row.id}`;

        if (seenSha.has(row.sha256)) {
            problems.push({
                level: 'fatal',
                message: `${label}: duplicate sha256`,
                detail: String(row.sha256),
            });
        }

        if (seenKey.has(row.storage_key)) {
            problems.push({
                level: 'fatal',
                message: `${label}: duplicate storage_key`,
                detail: String(row.storage_key),
            });
        }

        seenSha.add(row.sha256);
        seenKey.add(row.storage_key);

        if (!isStorageKey(row.sha256)) {
            problems.push({
                level: 'fatal',
                message: `${label}: sha256 is not 64 lowercase hex`,
                detail: String(row.sha256),
            });
            continue;
        }

        // storage_key IS the sha256 — that is what makes the path safe to build
        // from the column without validating the column first.
        if (row.storage_key !== row.sha256) {
            problems.push({
                level: 'fatal',
                message: `${label}: storage_key does not equal sha256`,
                detail: `sha=${row.sha256} key=${row.storage_key}`,
            });
        }

        // Built from THIS function's storeDir argument, not from BLOB_DIR:
        // scripts/check-store.js points this at a backup or a copy via STORE_DIR,
        // and a global path here would quietly check the live store instead of
        // the one it was asked about.
        //
        // The join is still safe without re-checking: the sha256 was validated
        // above and storage_key must equal it, or that was reported as fatal.
        const blob = path.join(storeDir, String(row.storage_key));

        let stat;

        try {
            stat = fs.statSync(blob);
        } catch {
            problems.push({
                level: 'fatal',
                message: `${label}: NO BLOB ON DISK`,
                detail: `${row.storage_key} — a download of this file will fail`,
            });
            continue;
        }

        if (stat.size !== row.file_size) {
            problems.push({
                level: 'fatal',
                message: `${label}: size disagrees with disk`,
                detail: `db says ${row.file_size}, disk says ${stat.size}`,
            });
        }

        if (deep) {
            const actual = await sha256OfFile(blob);

            if (actual !== row.sha256) {
                problems.push({
                    level: 'fatal',
                    message: `${label}: CONTENTS DO NOT MATCH THE NAME`,
                    detail:
                        `stored as ${row.sha256}\n` +
                        `        actually ${actual}\n` +
                        `        every reference to this file is serving something else`,
                });
            }
        }
    }

    for (const name of blobs) {
        if (!seenKey.has(name)) {
            const size = fs.statSync(path.join(storeDir, name)).size;
            problems.push({
                level: 'fatal',
                message: `orphan blob on disk: ${name}`,
                detail: `${size} bytes, referenced by no row`,
            });
        }
    }

    return { rows: rows.length, blobs: blobs.length, problems };
}

module.exports = { findProblems };
