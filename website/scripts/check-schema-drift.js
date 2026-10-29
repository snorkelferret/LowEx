#!/usr/bin/env node
/**
 * Fails when the live database does not match the schema backend/db.js declares.
 *
 * WHY THIS EXISTS
 * ---------------
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, and the
 * migrations in applySchemaPatches() only ever ADD COLUMN. So a column REMOVED
 * from db.js does not disappear from an existing database, and a constraint
 * added to a CREATE TABLE does not appear on a table created earlier.
 *
 * Nothing detected that, and db.js drifted from reality in two ways that
 * blocked the entire game store:
 *
 *   - live `assets` kept owner_id NOT NULL after 240f34c removed it from db.js,
 *     so the approval INSERT failed with NOT NULL even once its placeholder bug
 *     was fixed
 *   - live `invitations` was missing CHECK(reissue_count <= 6), because
 *     applySchemaPatches() added that column with ADD COLUMN and no CHECK, so
 *     the database accepted reissue_count = 99 while db.js claimed otherwise
 *
 * Both cost real time. This check would have caught either in one run.
 *
 * HOW IT COMPARES
 * ---------------
 * It builds a scratch database from db.js and compares STRUCTURE, not DDL text.
 * Raw text is unusable: SQLite rewrites stored DDL after ALTER TABLE or RENAME,
 * so semantically identical tables differ by table-name quoting and by
 * whitespace inside CHECK clauses.
 *
 * Compared per table: columns, foreign keys, CHECK expressions, and indexes.
 *
 * USAGE
 *   npm run check:schema                    # exit 0 = in sync, 1 = drift
 *   node scripts/check-schema-drift.js <db>  # check a specific database file
 *
 * The optional path argument is for checking a backup or a copy — useful for
 * confirming the check actually detects a known-drifted database.
 *
 * Read-only with respect to the target database. Safe to run while the server
 * is up, and safe to run before the database exists.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const livePath = path.resolve(process.argv[2] || path.join(repoRoot, 'backend/database.db'));
const dbJsPath = path.join(repoRoot, 'backend/db.js');

const die = (msg) => { console.error(msg); process.exit(1); };

if (!fs.existsSync(livePath)) {
  console.log('  No live database at ' + livePath);
  console.log('  Nothing to compare yet — start the server once to create it.');
  process.exit(0);
}

// ---------------------------------------------------------------- scratch DB

// Build a scratch copy of db.js in a temp directory and let IT create the
// database. Nothing in the repo is modified.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lowex-schema-'));
fs.copyFileSync(dbJsPath, path.join(scratchDir, 'db.js'));
fs.symlinkSync(path.join(repoRoot, 'node_modules'),
               path.join(scratchDir, 'node_modules'), 'dir');

const scratchPath = path.join(scratchDir, 'database.db');

// DB_PATH POINTS THE SCRATCH COPY AT THE SCRATCH DATABASE, and this line is not
// optional. db.js used to hardcode its path; it now honours DB_PATH so that a
// check can run the real code against its own database (see
// scripts/check-preview-access.js). Without this, running check:schema with
// DB_PATH set in the environment would open THAT database, apply migrations to
// it, and compare it with itself — a check that always passes, against a file
// it was told not to touch.
process.env.DB_PATH = scratchPath;

// db.js logs its progress on load; keep this script's output readable.
const realLog = console.log;
console.log = () => {};
try {
  require(path.join(scratchDir, 'db.js'));
} finally {
  console.log = realLog;
}

const cleanup = () => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

// ---------------------------------------------------------------- load both

const Database = require(path.join(repoRoot, 'node_modules/better-sqlite3'));
const live = new Database(livePath, { readonly: true });
const scratch = new Database(scratchPath, { readonly: true });

// ---------------------------------------------------------------- helpers

// Collapse whitespace and space around punctuation so 'CHECK (x = 1)' and
// 'CHECK(x=1)' compare equal. Case is left alone: string literals appear
// inside constraints and must not be rewritten.
const normExpr = (s) => s
  .replace(/\s+/g, ' ')
  .replace(/\s*,\s*/g, ',')
  .replace(/\s*\(\s*/g, '(')
  .replace(/\s*\)\s*/g, ')')
  .trim();

// Extract every CHECK(...) expression, handling nesting.
const checkExprs = (sql) => {
  if (!sql) return [];
  const out = [];
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
    }
    out.push(normExpr(sql.slice(re.lastIndex, i - 1)));
  }
  return out.sort();
};

const tables = (db) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);

const columns = (db, t) => db.prepare('PRAGMA table_info(' + JSON.stringify(t) + ')').all()
  .map(c => [c.name, c.type, c.notnull, normExpr(String(c.dflt_value ?? '')), c.pk].join('|'));

const foreignKeys = (db, t) => db.prepare('PRAGMA foreign_key_list(' + JSON.stringify(t) + ')').all()
  .map(f => [f.from, f.table, f.to, f.on_update, f.on_delete].join('|')).sort();

const indexes = (db, t) => db.prepare('PRAGMA index_list(' + JSON.stringify(t) + ')').all()
  .map(ix => {
    const cols = db.prepare('PRAGMA index_info(' + JSON.stringify(ix.name) + ')').all()
      .map(c => c.name).join(',');
    return [ix.name, ix.unique, cols].join('|');
  }).sort();

const tableSql = (db, t) => db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?"
).get(t)?.sql;

// ---------------------------------------------------------------- compare

const liveTables = tables(live);
const scratchTables = tables(scratch);

const problems = [];
const onlyLive = liveTables.filter(t => !scratchTables.includes(t));
const onlyScratch = scratchTables.filter(t => !liveTables.includes(t));

for (const t of onlyLive)    problems.push(`table only in the database: ${t}`);
for (const t of onlyScratch) problems.push(`table only in db.js     : ${t}`);

const cmp = (table, label, a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const sa = new Set(a), sb = new Set(b);
    for (const x of a) if (!sb.has(x)) problems.push(`${table}: ${label} present in the database but not in db.js -> ${x}`);
    for (const x of b) if (!sa.has(x)) problems.push(`${table}: ${label} declared in db.js but missing from the database -> ${x}`);
  }
};

for (const t of scratchTables) {
  if (!liveTables.includes(t)) continue;
  cmp(t, 'column', columns(live, t), columns(scratch, t));
  cmp(t, 'foreign key', foreignKeys(live, t), foreignKeys(scratch, t));
  cmp(t, 'CHECK constraint', checkExprs(tableSql(live, t)), checkExprs(tableSql(scratch, t)));
  cmp(t, 'index', indexes(live, t), indexes(scratch, t));
}

// ---------------------------------------------------------------- report

console.log('  live    : ' + livePath);
console.log('  db.js   : ' + dbJsPath);
console.log('  tables compared: ' + scratchTables.length);
console.log('');

if (problems.length === 0) {
  console.log('  PASS — the database matches db.js');
  process.exit(0);
}

console.log('  FAIL — the database does not match db.js (' + problems.length + ' difference(s)):');
for (const p of problems) console.log('    - ' + p);
console.log('');
console.log('  Reminder: CREATE TABLE IF NOT EXISTS will not fix an existing table,');
console.log('  and migrations only ADD COLUMN. Repairing this needs a rebuild or a');
console.log('  drop-and-recreate — see backend/reset/reconcileAssetSchema.js for the');
console.log('  pattern used for the assets/invitations drift.');
process.exit(1);
