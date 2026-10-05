#!/usr/bin/env node
/**
 * One-off: bring the live database back in line with backend/db.js.
 *
 * Two problems, same root cause — `db.js` did not describe the database it ran
 * against, and nothing caught it.
 *
 * 1) `assets` could never receive a game asset
 *    Commit 240f34c removed owner_id from db.js ("no owner for game assets —
 *    implicitly owned by game"), but:
 *      - `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so the
 *        live table kept owner_id — declared NOT NULL, FK to users(id)
 *      - the migrations only ever ADD COLUMN, never drop
 *    So the game store was blocked by two stacked bugs: the INSERT in the
 *    approve route had 4 placeholders for 3 columns, and once that was fixed
 *    the live table still demanded an owner_id the code no longer supplies
 *    (NOT NULL constraint failed: assets.owner_id).
 *    `ALTER TABLE DROP COLUMN` cannot repair it — SQLite refuses to drop a
 *    column named in a foreign key definition.
 *    Fix: drop the asset-domain tables, let db.js recreate them. That data is
 *    disposable (one workspace, one version, one file).
 *
 * 2) `invitations` was missing CHECK(reissue_count <= 6)
 *    applySchemaPatches() added the column via
 *      ALTER TABLE invitations ADD COLUMN reissue_count INTEGER DEFAULT 0;
 *    with no CHECK, while db.js's CREATE TABLE declares one. The live table
 *    therefore accepted reissue_count = 99 where db.js rejects it.
 *    inviteDevs.js enforces the limit in application code, so it was not
 *    exploitable — but the database did not back up what db.js claimed.
 *    Fix: SQLite cannot add a CHECK to an existing table, so this needs the
 *    12-step rebuild (create replacement, copy, drop, rename). The row is
 *    PRESERVED — invitations hold live tokens.
 *
 * NOT TOUCHED: users, audit_logs, sessions, api_keys.
 *
 * The invitations DDL below is deliberately spelled out rather than derived
 * from db.js: this script runs once and should record what it did, not track
 * later changes to db.js. Correctness is confirmed by the constraint tests at
 * the end, which assert the constraints actually reject bad values.
 *
 * USAGE
 *   node backend/reset/reconcileAssetSchema.js
 *
 * Stop the server first — a running instance holds prepared statements compiled
 * against the old schema.
 */

const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '../../node_modules/better-sqlite3'));

const dbPath = path.join(__dirname, '../database.db');
// The blob directory, from the module that owns the layout. This script
// DELETES what is in it, which is the last place that should be deriving
// the path for itself.
const { BLOB_DIR: uploadsDir } = require('../lib/storagePaths');

// Asset domain: dropped and recreated from db.js. Contains only disposable
// test data.
const ASSET_TABLES = [
    'asset_comments',
    'technical_check_results',
    'technical_check_runs',
    'creative_approvals',
    'asset_version_files',
    'asset_recommended_versions',
    'asset_versions',
    'assets',
    'workspace_version_files',
    'workspace_versions',
    'workspace_assets',
    'developer_workspaces',
    'stored_files'
];

// Rebuilt in place, data preserved.
const REBUILT_TABLES = ['invitations'];

// Must survive untouched, asserted before and after.
const PRESERVED = ['users', 'audit_logs', 'sessions', 'api_keys'];

const countOf = (db, t) => {
    try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; }
    catch { return null; }
};

const snapshot = (db) => {
    const out = {};
    for (const t of [...ASSET_TABLES, ...REBUILT_TABLES, ...PRESERVED]) {
        const c = countOf(db, t);
        if (c !== null) out[t] = c;
    }
    return out;
};

const show = (label, snap) => {
    console.log(`\n  ${label}`);
    for (const [t, c] of Object.entries(snap)) {
        const tag = PRESERVED.includes(t) ? ' (preserved)'
                  : REBUILT_TABLES.includes(t) ? ' (rebuilt, data kept)'
                  : '';
        console.log('    ' + t.padEnd(28) + String(c).padStart(3) + tag);
    }
};

// ---------------------------------------------------------------- before

console.log('Database:', dbPath);

let db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const before = snapshot(db);
show('BEFORE', before);

if (before.users === undefined) {
    console.error('\n  Refusing to run: no users table found. Wrong database?');
    process.exit(1);
}

// ------------------------------------------------- 1. asset tables: drop

console.log('\n  [1] Dropping asset-domain tables (disposable data)...');

db.pragma('foreign_keys = OFF');

const dropAll = db.transaction(() => {
    for (const t of ASSET_TABLES) {
        const exists = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
        ).get(t);
        if (!exists) { console.log('    skip    ' + t); continue; }
        db.exec(`DROP TABLE "${t}"`);
        console.log('    dropped ' + t);
    }
});

dropAll();
db.pragma('foreign_keys = ON');
db.close();

console.log('\n  Recreating asset tables from db.js...');
require(path.join(__dirname, '../db.js'));

// ------------------------------------------ 2. invitations: rebuild in place

console.log('\n  [2] Rebuilding invitations to add CHECK(reissue_count <= 6)...');

db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const invitationsSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='invitations'"
).get();

if (!invitationsSql) {
    console.log('    invitations table does not exist; db.js will create it correctly');
} else if (invitationsSql.sql.includes('reissue_count <= 6')) {
    console.log('    constraint already present, nothing to do');
} else {
    // Refuse to copy rows that would violate the constraint we are adding —
    // better to stop than to discover it mid-rebuild.
    const offending = db.prepare(
        'SELECT id, reissue_count FROM invitations WHERE reissue_count > 6'
    ).all();

    if (offending.length) {
        console.error('    ABORT: rows violate CHECK(reissue_count <= 6):');
        for (const r of offending) console.error(`      id=${r.id} reissue_count=${r.reissue_count}`);
        process.exit(1);
    }

    db.pragma('foreign_keys = OFF');

    const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE invitations_rebuilt (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            assigned_role TEXT
              CHECK (assigned_role IN ('user','developer','admin','superuser'))
              NOT NULL,
            token TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','used','revoked')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME DEFAULT (datetime('now', '+28 days')),
            reissue_count INTEGER DEFAULT 0
              CHECK (reissue_count <= 6),
            last_reissued_at DATETIME
          );
        `);

        db.exec(`
          INSERT INTO invitations_rebuilt
            (id, email, assigned_role, token, status,
             created_at, expires_at, reissue_count, last_reissued_at)
          SELECT
             id, email, assigned_role, token,
             CASE WHEN is_used = 1 THEN 'used' ELSE 'pending' END,
             created_at, expires_at, reissue_count, last_reissued_at
          FROM invitations;
        `);

        db.exec('DROP TABLE invitations');
        db.exec('ALTER TABLE invitations_rebuilt RENAME TO invitations');
    });

    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('    rebuilt, rows copied');
}

db.close();

// ---------------------------------------------------------------- verify

db = new Database(dbPath, { readonly: true });

const after = snapshot(db);
show('AFTER', after);

let preservedOk = true;
for (const t of PRESERVED) {
    if (before[t] !== after[t]) {
        console.log(`\n  !! ${t} changed: ${before[t]} -> ${after[t]}`);
        preservedOk = false;
    }
}
for (const t of REBUILT_TABLES) {
    if (before[t] !== after[t]) {
        console.log(`\n  !! ${t} row count changed: ${before[t]} -> ${after[t]}`);
        preservedOk = false;
    }
}

console.log('\n  Preserved + rebuilt tables intact: ' + (preservedOk ? 'yes' : 'NO'));

const assetCols = db.prepare('PRAGMA table_info(assets)').all().map(c => c.name);
console.log('  assets columns  : ' + assetCols.join(', '));
console.log('  owner_id removed: ' + (assetCols.includes('owner_id') ? 'NO' : 'yes'));

console.log('  integrity_check : ' + db.pragma('integrity_check')[0].integrity_check);
console.log('  foreign_key_check: ' +
    (db.pragma('foreign_key_check').length === 0 ? 'clean' : 'PROBLEMS'));

db.close();

// ---------------------------------------- prove the constraints are live

console.log('\n  Constraint tests (each must be REJECTED):');

db = new Database(dbPath);
const mustReject = (label, sql, args, cleanup) => {
    try {
        db.prepare(sql).run(...args);
        if (cleanup) db.prepare(cleanup).run();
        console.log('    FAIL  ' + label + ' was accepted');
        return false;
    } catch {
        console.log('    ok    ' + label + ' rejected');
        return true;
    }
};

let constraintsOk = true;
constraintsOk &= mustReject('invitations.reissue_count = 99',
    'INSERT INTO invitations (email,assigned_role,token,reissue_count) VALUES (?,?,?,?)',
    ['t@t.t', 'developer', 'tok-x', 99], "DELETE FROM invitations WHERE email='t@t.t'");
constraintsOk &= mustReject('invitations bad role',
    'INSERT INTO invitations (email,assigned_role,token) VALUES (?,?,?)',
    ['t@t.t', 'NOT_A_ROLE', 'tok-y'], "DELETE FROM invitations WHERE email='t@t.t'");
constraintsOk &= mustReject('assets.owner_id gone',
    'INSERT INTO assets (name, asset_type, description, owner_id) VALUES (?,?,?,?)',
    ['X', null, null, 1], 'DELETE FROM assets');

// And the thing the whole exercise is for: a game asset can be created.
let insertOk = false;
try {
    const r = db.prepare('INSERT INTO assets (name, asset_type, description) VALUES (?,?,?)')
        .run('__probe__', 'model', 'constraint probe');
    db.prepare('DELETE FROM assets WHERE id = ?').run(r.lastInsertRowid);
    insertOk = true;
    console.log('    ok    assets INSERT (the blocked path) succeeds');
} catch (e) {
    console.log('    FAIL  assets INSERT still broken: ' + e.message);
}

db.close();

// ---------------------------------------------------------------- files

// The stored_files rows are gone, so every file in the content store is now
// unreferenced.
if (fs.existsSync(uploadsDir)) {
    const entries = fs.readdirSync(uploadsDir);
    for (const name of entries) {
        fs.rmSync(path.join(uploadsDir, name), { recursive: true, force: true });
    }
    console.log(`\n  Cleared ${entries.length} orphaned file(s) from ${uploadsDir}`);
}

console.log(
    '\n  ' +
    (preservedOk && constraintsOk && insertOk
        ? 'DONE — schema reconciled, constraints enforced'
        : 'DONE WITH PROBLEMS — review the output above')
);
process.exit(preservedOk && constraintsOk && insertOk ? 0 : 1);
