// backend/db.js


const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'database.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');


/*
 * ------------------------------------------------------------
 * Invitation schema patches
 * ------------------------------------------------------------
 */

const applySchemaPatches = () => {
  let columns = db
    .prepare("PRAGMA table_info(invitations)")
    .all()
    .map(c => c.name);

  /*
   * ----------------------------------------------------------
   * Rebuild: is_used -> status, and 'user' becomes invitable
   * ----------------------------------------------------------
   *
   * Two CHECK constraints changed: the role list gained 'user' (a tester is a
   * plain user), and the is_used flag became a three-state status. SQLite
   * cannot alter a CHECK, so this is a rebuild rather than ADD COLUMN.
   *
   * Safe to do at startup: invitations holds one row and nothing references
   * it. Transactional, so a failure leaves the old table intact rather than a
   * half-built one.
   */
  if (columns.includes('is_used')) {
    const rebuildInvitations = db.transaction(() => {
      db.exec(`
        CREATE TABLE invitations_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          assigned_role TEXT
            CHECK(assigned_role IN ('user','developer','admin','superuser'))
            NOT NULL,
          token TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','used','revoked')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME DEFAULT (datetime('now', '+28 days')),
          reissue_count INTEGER DEFAULT 0 CHECK(reissue_count <= 6),
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
          created_at,
          COALESCE(expires_at, datetime('now', '+28 days')),
          COALESCE(reissue_count, 0),
          last_reissued_at
        FROM invitations;
      `);

      db.exec('DROP TABLE invitations');
      db.exec('ALTER TABLE invitations_rebuilt RENAME TO invitations');
    });

    rebuildInvitations();

    columns = db
      .prepare("PRAGMA table_info(invitations)")
      .all()
      .map(c => c.name);

    console.log('🔁 invitations rebuilt: is_used -> status, user is now invitable');
  }

  if (!columns.includes('expires_at')) {
    db.exec(`
      ALTER TABLE invitations
      ADD COLUMN expires_at
      DATETIME DEFAULT (datetime('now', '+28 days'));
    `);

    db.exec(`
      UPDATE invitations
      SET expires_at = datetime('now', '+28 days')
      WHERE expires_at IS NULL;
    `);
  }

  if (!columns.includes('reissue_count')) {
    // The CHECK belongs here, not just in the CREATE TABLE above. Adding the
    // column without it means a database that took this migration path gets a
    // column that accepts any value, while db.js's declaration claims the
    // limit is enforced. SQLite accepts and enforces a CHECK on ADD COLUMN.
    db.exec(`
      ALTER TABLE invitations
      ADD COLUMN reissue_count INTEGER DEFAULT 0
        CHECK (reissue_count <= 6);
    `);
  }

  if (!columns.includes('last_reissued_at')) {
    db.exec(`
      ALTER TABLE invitations
      ADD COLUMN last_reissued_at DATETIME;
    `);
  }
};


/*
 * ------------------------------------------------------------
 * Asset repository schema
 * ------------------------------------------------------------
 */

const applyAssetRepositorySchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS developer_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      developer_id INTEGER NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (developer_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      asset_type TEXT,
      category TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (workspace_id)
        REFERENCES developer_workspaces(id)
        ON DELETE CASCADE,
      UNIQUE (workspace_id, name)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_asset_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      version_note TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (workspace_asset_id)
        REFERENCES workspace_assets(id)
        ON DELETE CASCADE,
      FOREIGN KEY (created_by)
        REFERENCES users(id),
      UNIQUE (workspace_asset_id, version_number)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      asset_type TEXT,
      category TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (name)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      version_note TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_id)
        REFERENCES assets(id),
      UNIQUE (asset_id, version_number),
      UNIQUE (id, asset_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_recommended_versions (
      asset_id INTEGER PRIMARY KEY,
      version_id INTEGER NOT NULL,
      FOREIGN KEY (
        asset_id,
        version_id
      )
      REFERENCES asset_versions (
        asset_id,
        id
      )
    );
  `);
  // NOTE: this table is unused and slated for removal. A single "recommended
  // version" pointer cannot express the intended model -- an asset can hold
  // several production versions at once, and production status is derived from
  // release membership, not from a pointer. Removed in the phase that
  // introduces `releases`. Kept for now so the schema change is reviewable on
  // its own.

  db.exec(`
    CREATE TABLE IF NOT EXISTS stored_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL UNIQUE,
      file_size INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_version_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_version_id INTEGER NOT NULL,
      stored_file_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_version_id)
        REFERENCES workspace_versions(id)
        ON DELETE CASCADE,
      FOREIGN KEY (stored_file_id)
        REFERENCES stored_files(id),
      UNIQUE (
        workspace_version_id,
        relative_path,
        filename
      )
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_version_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_version_id INTEGER NOT NULL,
      stored_file_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_version_id)
        REFERENCES asset_versions(id),
      FOREIGN KEY (stored_file_id)
        REFERENCES stored_files(id),
      UNIQUE (
        asset_version_id,
        relative_path,
        filename
      )
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_workspace_assets_workspace
      ON workspace_assets(workspace_id);

    CREATE INDEX IF NOT EXISTS
      idx_workspace_versions_asset
      ON workspace_versions(workspace_asset_id);


    CREATE INDEX IF NOT EXISTS
      idx_asset_versions_asset
      ON asset_versions(asset_id);

    CREATE INDEX IF NOT EXISTS
      idx_stored_files_sha256
      ON stored_files(sha256);

    CREATE INDEX IF NOT EXISTS
      idx_workspace_version_files_version
      ON workspace_version_files(workspace_version_id);

    CREATE INDEX IF NOT EXISTS
      idx_asset_version_files_version
      ON asset_version_files(asset_version_id);

    CREATE INDEX IF NOT EXISTS
      idx_asset_recommended_version
      ON asset_recommended_versions(version_id);
  `);

  console.log('📦 Asset Repository tables ready.');
};


/*
 * ------------------------------------------------------------
 * Asset workflow schema
 * ------------------------------------------------------------
 *
 * Important:
 *
 * workspace_assets represents the developer's continuing
 * sandbox asset.
 *
 * Acceptance / rejection / locking applies to individual
 * workspace_versions, NOT workspace_assets.
 *
 * A workspace asset can therefore continue to have new
 * versions after an earlier version has been accepted.
 * ------------------------------------------------------------
 */

const applyAssetWorkflowSchemaPatches = () => {

  /*
   * ----------------------------------------------------------
   * workspace_assets additions
   *
   * These identify the repository asset/version from which
   * the workspace asset was derived.
   * ----------------------------------------------------------
   */

  const workspaceAssetColumns = db
    .prepare("PRAGMA table_info(workspace_assets)")
    .all()
    .map(c => c.name);

  if (!workspaceAssetColumns.includes('repository_asset_id')) {
    db.exec(`
      ALTER TABLE workspace_assets
      ADD COLUMN repository_asset_id INTEGER;
    `);
  }

  if (!workspaceAssetColumns.includes('repository_base_version_id')) {
    db.exec(`
      ALTER TABLE workspace_assets
      ADD COLUMN repository_base_version_id INTEGER;
    `);
  }

  // Which part of the game this asset belongs to.
  //
  // FREE TEXT, NOT A CHECK. The list of categories lives in
  // shared/assetRules.mjs and is validated on write. Putting it in a CHECK here
  // would mean a table rebuild every time the list changes — which is what
  // happened to asset_type, twice.
  if (!workspaceAssetColumns.includes('category')) {
    db.exec(`
      ALTER TABLE workspace_assets
      ADD COLUMN category TEXT;
    `);
  }


  /*
   * ----------------------------------------------------------
   * assets additions (the repository side)
   *
   * The category is carried across when a workspace asset is
   * accepted, so it has to exist on both tables. Adding it on
   * only the sandbox side would mean the classification died
   * at exactly the boundary where it becomes useful — the
   * repository is where someone looks for "every Character".
   * ----------------------------------------------------------
   */

  const repositoryAssetColumns = db
    .prepare("PRAGMA table_info(assets)")
    .all()
    .map(c => c.name);

  if (!repositoryAssetColumns.includes('category')) {
    db.exec(`
      ALTER TABLE assets
      ADD COLUMN category TEXT;
    `);
  }


  /*
   * ----------------------------------------------------------
   * workspace_versions additions
   *
   * creative_locked:
   *   0 = editable
   *   1 = locked for Creative Approval / accepted version
   *
   * repository_version_id:
   *   Set when this workspace version has been accepted into
   *   the main repository.
   * ----------------------------------------------------------
   */

  const workspaceVersionColumns = db
    .prepare("PRAGMA table_info(workspace_versions)")
    .all()
    .map(c => c.name);

  if (!workspaceVersionColumns.includes('creative_locked')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN creative_locked INTEGER NOT NULL DEFAULT 0;
    `);
  }

  if (!workspaceVersionColumns.includes('locked_at')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN locked_at DATETIME;
    `);
  }

  if (!workspaceVersionColumns.includes('repository_version_id')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN repository_version_id INTEGER;
    `);
  }

  // Soft delete. A version cannot be hard-deleted once it has been checked or
  // reviewed — technical_check_runs and creative_approvals both reference it
  // with foreign keys that have no ON DELETE clause, deliberately: the history
  // of something submitted should not be erasable. Soft delete lets a developer
  // clear their workspace without destroying that history, and quota
  // accounting counts only live rows, so it does free space.
  if (!workspaceVersionColumns.includes('is_active')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
    `);
  }


  /*
   * ----------------------------------------------------------
   * Creative Approval
   *
   * Each approval relates to ONE specific workspace version.
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS creative_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      workspace_asset_id INTEGER NOT NULL,
      workspace_version_id INTEGER NOT NULL,

      requested_by INTEGER NOT NULL,

      status TEXT NOT NULL
        CHECK (
          status IN (
            'pending',
            'rejected',
            'approved',
            'cancelled'
          )
        ),

      request_comment TEXT,

      decided_by INTEGER,
      decision_comment TEXT,

      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_at DATETIME,

      repository_asset_id INTEGER,
      repository_version_id INTEGER,

      FOREIGN KEY (workspace_asset_id)
        REFERENCES workspace_assets(id),

      FOREIGN KEY (workspace_version_id)
        REFERENCES workspace_versions(id),

      FOREIGN KEY (requested_by)
        REFERENCES users(id),

      FOREIGN KEY (decided_by)
        REFERENCES users(id),

      FOREIGN KEY (repository_asset_id)
        REFERENCES assets(id),

      FOREIGN KEY (repository_version_id)
        REFERENCES asset_versions(id)
    );
  `);


  /*
   * Only one pending Creative Approval may exist for a
   * particular workspace version.
   */

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_one_pending_creative_approval_per_version
      ON creative_approvals(workspace_version_id)
      WHERE status = 'pending';
  `);


  /*
   * ----------------------------------------------------------
   * Technical validation runs
   *
   * These are private developer/system records.
   * They do NOT represent Creative Approval.
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS technical_check_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      workspace_asset_id INTEGER NOT NULL,
      workspace_version_id INTEGER NOT NULL,

      started_by INTEGER,

      status TEXT NOT NULL
        CHECK (
          status IN (
            'running',
            'passed',
            'failed',
            'cancelled',
            'error'
          )
        ),

      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,

      summary TEXT,

      FOREIGN KEY (workspace_asset_id)
        REFERENCES workspace_assets(id),

      FOREIGN KEY (workspace_version_id)
        REFERENCES workspace_versions(id),

      FOREIGN KEY (started_by)
        REFERENCES users(id)
    );
  `);


  /*
   * Individual technical checks belonging to a run.
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS technical_check_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      technical_check_run_id INTEGER NOT NULL,

      check_name TEXT NOT NULL,

      status TEXT NOT NULL
        CHECK (
          status IN (
            'passed',
            'failed',
            'warning',
            'skipped',
            'error'
          )
        ),

      message TEXT,
      details TEXT,

      started_at DATETIME,
      completed_at DATETIME,

      FOREIGN KEY (technical_check_run_id)
        REFERENCES technical_check_runs(id)
        ON DELETE CASCADE
    );
  `);


  /*
   * ----------------------------------------------------------
   * Comments
   *
   * Comments can belong to workspace versions, repository
   * versions, or Creative Approval requests.
   *
   * Private workspace comments remain private.
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      author_id INTEGER NOT NULL,

      workspace_asset_id INTEGER,
      workspace_version_id INTEGER,

      repository_asset_id INTEGER,
      repository_version_id INTEGER,

      creative_approval_id INTEGER,

      parent_comment_id INTEGER,

      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (
          visibility IN (
            'private',
            'approval',
            'repository'
          )
        ),

      comment_text TEXT NOT NULL,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (author_id)
        REFERENCES users(id),

      FOREIGN KEY (workspace_asset_id)
        REFERENCES workspace_assets(id),

      FOREIGN KEY (workspace_version_id)
        REFERENCES workspace_versions(id),

      FOREIGN KEY (repository_asset_id)
        REFERENCES assets(id),

      FOREIGN KEY (repository_version_id)
        REFERENCES asset_versions(id),

      FOREIGN KEY (creative_approval_id)
        REFERENCES creative_approvals(id),

      FOREIGN KEY (parent_comment_id)
        REFERENCES asset_comments(id)
    );
  `);


  /*
   * ----------------------------------------------------------
   * Workflow indexes
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_workspace_assets_repository
      ON workspace_assets(repository_asset_id);

    CREATE INDEX IF NOT EXISTS
      idx_workspace_versions_repository
      ON workspace_versions(repository_version_id);

    CREATE INDEX IF NOT EXISTS
      idx_creative_approvals_asset
      ON creative_approvals(workspace_asset_id);

    CREATE INDEX IF NOT EXISTS
      idx_creative_approvals_version
      ON creative_approvals(workspace_version_id);

    CREATE INDEX IF NOT EXISTS
      idx_creative_approvals_status
      ON creative_approvals(status);

    CREATE INDEX IF NOT EXISTS
      idx_technical_check_runs_version
      ON technical_check_runs(workspace_version_id);

    CREATE INDEX IF NOT EXISTS
      idx_technical_check_results_run
      ON technical_check_results(technical_check_run_id);

    CREATE INDEX IF NOT EXISTS
      idx_asset_comments_workspace_version
      ON asset_comments(workspace_version_id);

    CREATE INDEX IF NOT EXISTS
      idx_asset_comments_repository_version
      ON asset_comments(repository_version_id);
  `);

  console.log('🔄 Asset workflow tables and migrations ready.');
};


/*
 * ------------------------------------------------------------
 * Database initialisation
 * ------------------------------------------------------------
 */

const initDb = () => {

  /*
   * ----------------------------------------------------------
   * Invitations
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      email TEXT UNIQUE NOT NULL,

      -- 'user' is the tester: a login with no extra privileges. It is
      -- invitable because that is how a tester is created — being a tester
      -- needs no role of its own, since the tester features (download,
      -- comment, report) are available to anyone logged in.
      assigned_role TEXT
        CHECK(
          assigned_role IN (
            'user',
            'developer',
            'admin',
            'superuser'
          )
        )
        NOT NULL,

      token TEXT UNIQUE NOT NULL,

      -- Replaces the old is_used flag. Three states rather than two, so a
      -- revoked invitation is distinguishable from a used one — and expiry is
      -- NOT a state: it is derived from expires_at at read time, so no
      -- scheduled job is needed to move invitations between states.
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'used', 'revoked')),

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      expires_at DATETIME
        DEFAULT (datetime('now', '+28 days')),

      reissue_count INTEGER DEFAULT 0
        CHECK(reissue_count <= 6),

      last_reissued_at DATETIME
    );
  `);

  applySchemaPatches();


  /*
   * ----------------------------------------------------------
   * Users
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      username TEXT UNIQUE NOT NULL,

      email TEXT UNIQUE NOT NULL,

      password_hash TEXT,

      github_id TEXT UNIQUE,

      github_username TEXT,

      google_id TEXT UNIQUE,

      role TEXT
        CHECK(
          role IN (
            'user',
            'developer',
            'admin',
            'superuser'
          )
        )
        NOT NULL
        DEFAULT 'user',

      two_factor_secret TEXT,

      is_2fa_enabled INTEGER DEFAULT 0,

      is_active INTEGER DEFAULT 1,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      CHECK (
        password_hash IS NOT NULL
        OR github_id IS NOT NULL
        OR google_id IS NOT NULL
      )
    );
  `);


  /*
   * ----------------------------------------------------------
   * Audit logs
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      actor_id INTEGER,

      action TEXT NOT NULL,

      target TEXT,

      details TEXT,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);


  /*
   * ----------------------------------------------------------
   * Sessions
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER NOT NULL,

      token TEXT NOT NULL,

      ip_address TEXT,

      user_agent TEXT,

      is_impersonated INTEGER DEFAULT 0,

      impersonated_by INTEGER,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      expires_at DATETIME NOT NULL
    );
  `);


  /*
   * ----------------------------------------------------------
   * API keys
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      name TEXT NOT NULL,

      key_prefix TEXT NOT NULL,

      key_hash TEXT NOT NULL,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      last_used DATETIME
    );
  `);


  /*
   * ----------------------------------------------------------
   * Asset repository
   *
   * Must happen after users because the asset tables have
   * foreign keys to users.
   * ----------------------------------------------------------
   */

  applyAssetRepositorySchema();


  /*
   * ----------------------------------------------------------
   * Asset workflow
   *
   * Must happen after the repository tables exist because
   * these tables/columns refer to them.
   * ----------------------------------------------------------
   */

  applyAssetWorkflowSchemaPatches();


  /*
   * ----------------------------------------------------------
   * Initial superuser
   * ----------------------------------------------------------
   */

  const userCount = db
    .prepare('SELECT COUNT(*) as count FROM users')
    .get()
    .count;

  if (userCount === 0) {
    const salt = bcrypt.genSaltSync(12);

    const hashedPassword = bcrypt.hashSync(
      'SuperPassword123!',
      salt
    );

    db.prepare(`
      INSERT INTO users (
        username,
        email,
        password_hash,
        role
      )
      VALUES (?, ?, ?, 'superuser')
    `).run(
      'admin',
      'admin@lowexpectations.com',
      hashedPassword
    );

    console.log(
      '🔑 Initial superuser created: username="admin", password="SuperPassword123!"'
    );
  }

  console.log(
    '⚡ SQLite Database & Auth Tables Ready.'
  );
};


initDb();

module.exports = db;
