#!/usr/bin/env node
/**
 * Checks the COLLECTOR — the one thing in this system that destroys content.
 *
 *   node scripts/check-collector.js        # exit 0 = clean
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Every other check answers "do the parts agree with each other". This one
 * answers "does the nightly job still do what it says", by RUNNING it — against
 * a throwaway database and two throwaway directories, never the real store.
 *
 * The collector had no such test. It was proved by hand on 2026-10-29, when
 * previews started its having to delete a second kind of row and file, and the
 * proof was a script in /tmp that nobody would ever run again. A failure here
 * is silent and slow: the job throws at 3am, the log is not read, and the disk
 * simply stops being freed — which the portal notices only when it is full.
 *
 * ============================================================
 * WHAT IT PROVES, IN THE ORDER IT MATTERS
 * ============================================================
 *
 *   1. A REFERENCED BLOB SURVIVES. The worst bug this file could have: content
 *      in the library is deleted because a clause went missing from the query.
 *      Silent, irreversible, and the first symptom is broken pages.
 *
 *   2. A RELEASED BLOB GOES. A soft-deleted library item does not protect its
 *      blob, which is a rule and not an accident.
 *
 *   3. A YOUNG BLOB SURVIVES. The grace window is a guard against a race
 *      nobody has thought of; if it is not honoured, uploads can be collected
 *      out from under the developer.
 *
 *   4. A MALFORMED KEY IS REFUSED. The collector reports it and moves on
 *      rather than building a path from a string that is not a hash.
 *
 *   5. GARBAGE GOES — FILE AND ROW. Both, in that order.
 *
 *   6. A PREVIEW GOES WITH ITS BLOB. The file and the row. This is the case
 *      added when previews were built, and the one that would have failed
 *      silently: the foreign key refuses the delete, the job throws, and
 *      nothing on screen changes.
 *
 *   7. NOTHING GOES WITHOUT --collect. The default is report-only, deliberately.
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * The schema is copied from the live database's sqlite_master into an IN-MEMORY
 * database, so this cannot drift from the real schema and cannot touch it. The
 * live file is opened read-only and only SELECTed. The blobs and previews are
 * small files in a temporary directory that is removed at the end.
 *
 * DB_PATH overrides where the schema is copied FROM, for a machine whose
 * database lives elsewhere. It is never written to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { createCollector } = require('../backend/lib/collector');
const { isStorageKey } = require('../backend/lib/storagePaths');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(ROOT, 'backend/database.db');

// A key that is a valid SHA-256 and cannot collide with anything real: it is
// the hash of a phrase, not of any file that exists.
const keyOf = label => crypto.createHash('sha256').update(`check-collector:${label}`).digest('hex');

// ---------------------------------------------------------------------------
// Reporting, in the shape the other checks use
// ---------------------------------------------------------------------------

let failures = 0;

function ok(label) {
    console.log(`  ok     : ${label}`);
}

function bad(label, detail) {
    failures++;
    console.log(`  FAIL   : ${label}`);
    if (detail) console.log(`           ${detail}`);
}

function check(label, condition, detail) {
    if (condition) ok(label);
    else bad(label, detail);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`\n  FAIL — no database at ${DB_PATH} to copy the schema from\n`);
        process.exit(1);
    }

    const source = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    const ddl = source.prepare(`
        SELECT type, sql
        FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END
    `).all();

    const mem = new Database(':memory:');
    mem.pragma('foreign_keys = ON');

    for (const { sql } of ddl) mem.exec(sql);

    const required = [
        'stored_files', 'file_thumbnails', 'library_items',
        'workspace_version_files', 'asset_version_files'
    ];

    for (const table of required) {
        if (!mem.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
            console.error(`\n  FAIL — ${DB_PATH} has no ${table} table; the schema copy is incomplete\n`);
            process.exit(1);
        }
    }

    // The collector's own directories, never the real ones.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lowex-collector-'));
    const blobDir = path.join(tmp, 'files');
    const thumbDir = path.join(tmp, 'thumbs');
    fs.mkdirSync(blobDir);
    fs.mkdirSync(thumbDir);

    // THE SAME CONTRACT storagePaths GIVES THE JOB: null for a key that is not
    // a SHA-256, so the collector's refusal can be tested.
    const blobPath = key => (isStorageKey(key) ? path.join(blobDir, key) : null);
    const thumbPath = (key, kind) => (
        isStorageKey(key) && kind ? path.join(thumbDir, `${key}_${kind}.webp`) : null
    );

    // Silent, but recorded: some failures are only visible in what the job says.
    const said = [];
    const say = line => said.push(line);

    const collector = createCollector({ db: mem, blobPath, thumbPath, say });

    // -----------------------------------------------------------------
    // The fixtures. Every one is OLD except the young blob, so the only
    // difference between them is what references them.
    // -----------------------------------------------------------------

    const OLD = "datetime('now', '-48 hours')";

    const addBlob = (label, { age = OLD, referenced = null } = {}) => {
        const key = keyOf(label);

        const info = mem.prepare(`
            INSERT INTO stored_files (sha256, storage_key, file_size, created_at)
            VALUES (?, ?, ?, ${age})
        `).run(key, key, 12);

        const file = blobPath(key);
        fs.writeFileSync(file, 'fake blob');

        if (referenced === 'library') {
            // content_state is supplied because the column's DEFAULT is
            // 'unverified', which its own CHECK does not allow — see the note
            // at the top of this file.
            mem.prepare(`
                INSERT INTO library_items
                    (stored_file_id, display_name, content_state, is_active)
                VALUES (?, ?, 'unverifiable', 1)
            `).run(info.lastInsertRowid, label);
        }

        if (referenced === 'library-released') {
            mem.prepare(`
                INSERT INTO library_items
                    (stored_file_id, display_name, content_state, is_active)
                VALUES (?, ?, 'unverifiable', 0)
            `).run(info.lastInsertRowid, label);
        }

        return { key, id: info.lastInsertRowid, file };
    };

    const garbage = addBlob('garbage');            // nothing says so: goes
    const held = addBlob('held', { referenced: 'library' });          // survives
    const released = addBlob('released', { referenced: 'library-released' }); // goes
    const young = addBlob('young', { age: 'CURRENT_TIMESTAMP' });     // survives

    // A preview of the garbage blob, so the derived-content case is real.
    const preview = thumbPath(garbage.key, 'image');
    fs.writeFileSync(preview, 'fake preview');

    mem.prepare(`
        INSERT INTO file_thumbnails (stored_file_id, kind, storage_key, width, height)
        VALUES (?, 'image', ?, 320, 320)
    `).run(garbage.id, garbage.key);

    // A malformed key: unreferenced, old, and not a hash. The collector must
    // refuse it rather than build a path from it.
    const brokenKey = 'not-a-sha256';
    mem.prepare(`
        INSERT INTO stored_files (sha256, storage_key, file_size, created_at)
        VALUES (?, ?, 5, datetime('now', '-48 hours'))
    `).run('f'.repeat(64), brokenKey);

    // -----------------------------------------------------------------
    // 1. Report-only: the default must change nothing.
    // -----------------------------------------------------------------

    const reported = collector.collect({ remove: false, dryRun: false, sound: true });

    check('report-only finds the garbage', reported.wouldRemove === 3,
        `said wouldRemove=${reported.wouldRemove}, expected 3 (garbage, released, malformed)`);

    check('report-only deletes nothing', fs.existsSync(garbage.file) && fs.existsSync(preview),
        'a file disappeared during a report-only run');

    check('report-only keeps every row',
        mem.prepare('SELECT COUNT(*) AS n FROM stored_files').get().n === 5,
        'a stored_files row was removed during a report-only run');

    // -----------------------------------------------------------------
    // 2. The real run.
    // -----------------------------------------------------------------

    const result = collector.collect({ remove: true, dryRun: false, sound: true });

    check('two blobs collected', result.blobs === 2,
        `collected ${result.blobs}, expected 2 (garbage and released)`);

    check('the garbage blob file is gone', !fs.existsSync(garbage.file));
    check('the garbage blob row is gone',
        !mem.prepare('SELECT id FROM stored_files WHERE id = ?').get(garbage.id));

    check('the preview file is gone', !fs.existsSync(preview));
    check('the preview row is gone',
        mem.prepare('SELECT COUNT(*) AS n FROM file_thumbnails').get().n === 0);

    check('the released blob is gone',
        !mem.prepare('SELECT id FROM stored_files WHERE id = ?').get(released.id));

    check('the released library row is gone',
        !mem.prepare('SELECT id FROM library_items WHERE stored_file_id = ?').get(released.id),
        'a released library item was left pointing at a deleted blob');

    check('the library-held item remains',
        !!mem.prepare('SELECT id FROM library_items WHERE stored_file_id = ?').get(held.id));

    check('the library-held blob survives',
        mem.prepare('SELECT id FROM stored_files WHERE id = ?').get(held.id)
        && fs.existsSync(held.file),
        'the collector deleted a blob an active library item still holds');

    check('the young blob survives',
        mem.prepare('SELECT id FROM stored_files WHERE id = ?').get(young.id)
        && fs.existsSync(young.file),
        'the collector ignored the grace window');

    check('the malformed key is refused',
        mem.prepare('SELECT id FROM stored_files WHERE storage_key = ?').get(brokenKey),
        'the collector deleted a row whose storage_key is not a hash');

    check('the refusal is reported',
        said.some(line => line.includes('REFUSING malformed storage_key')),
        'nothing was said about the malformed key');

    // -----------------------------------------------------------------
    // 3. A second run has nothing left to do.
    // -----------------------------------------------------------------

    const again = collector.collect({ remove: true, dryRun: false, sound: true });

    // The malformed row is the only thing left, and it is refused every time —
    // so a second run removes nothing and is not silently stuck in report mode.
    check('a second run removes nothing', again.blobs === 0,
        `second run removed ${again.blobs} blob(s)`);

    check('the malformed row is still there',
        !!mem.prepare('SELECT id FROM stored_files WHERE storage_key = ?').get(brokenKey));

    // -----------------------------------------------------------------

    mem.close();
    source.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    if (failures > 0) {
        console.log(`\n  FAILED — ${failures} problem(s)\n`);
        process.exit(1);
    }

    console.log('\n  PASS — the collector removes garbage, its previews, and nothing else\n');
}

main();
