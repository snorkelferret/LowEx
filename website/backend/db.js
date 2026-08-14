// backend/db.js

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

// ============================================================
// DATABASE CONNECTION
// ============================================================

const dbPath = path.join(__dirname, 'database.db');

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');


// ============================================================
// EXISTING DATABASE SCHEMA PATCHES
// ============================================================

const applySchemaPatches = () => {

  const columns = db
    .prepare("PRAGMA table_info(invitations)")
    .all()
    .map(c => c.name);


  // Add 28-day expiration

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


  // Add reissue_count tracking

  if (!columns.includes('reissue_count')) {

    db.exec(`
      ALTER TABLE invitations
      ADD COLUMN reissue_count INTEGER DEFAULT 0;
    `);
  }


  // Add last_reissued_at timestamp

  if (!columns.includes('last_reissued_at')) {

    db.exec(`
      ALTER TABLE invitations
      ADD COLUMN last_reissued_at DATETIME;
    `);
  }
};


// ============================================================
// ASSET REPOSITORY SCHEMA
// ============================================================
//
// The asset system has two distinct areas:
//
// PRIVATE DEVELOPER WORKSPACE
//
//   Developer's own working area.
//   Other developers cannot see it.
//
// MAIN ASSET REPOSITORY
//
//   Everything here is published/public to developers.
//   Published versions cannot be changed by developers.
//
// Physical files are stored separately and identified by
// SHA-256 so identical files do not have to be stored twice.
//
// ============================================================

const applyAssetRepositorySchema = () => {

  // ==========================================================
  // DEVELOPER WORKSPACES
  // ==========================================================

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


  // ==========================================================
  // PRIVATE WORKSPACE ASSETS
  // ==========================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_assets (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      workspace_id INTEGER NOT NULL,

      name TEXT NOT NULL,

      asset_type TEXT,

      description TEXT,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      is_active INTEGER NOT NULL DEFAULT 1,

      FOREIGN KEY (workspace_id)
        REFERENCES developer_workspaces(id)
        ON DELETE CASCADE,

      UNIQUE (
        workspace_id,
        name
      )
    );
  `);


  // ==========================================================
  // PRIVATE WORKSPACE VERSIONS
  // ==========================================================
  //
  // Every upload/change creates a new version.
  //
  // These versions remain private to the developer's
  // workspace until the developer publishes one.
  //
  // ==========================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_versions (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      workspace_asset_id INTEGER NOT NULL,

      version_number INTEGER NOT NULL,

      created_by INTEGER NOT NULL,

      version_note TEXT NOT NULL,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (workspace_asset_id)
        REFERENCES workspace_assets(id)
        ON DELETE CASCADE,

      FOREIGN KEY (created_by)
        REFERENCES users(id),

      UNIQUE (
        workspace_asset_id,
        version_number
      )
    );
  `);


  // ==========================================================
  // MAIN ASSET REPOSITORY
  // ==========================================================
  //
  // This represents the logical identity of an asset.
  //
  // Example:
  //
  //     oak_tree
  //
  // may have:
  //
  //     v1
  //     v2
  //     v3
  //
  // The asset can have zero or one recommended version.
  //
  // ==========================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      name TEXT NOT NULL,

      asset_type TEXT,

      owner_id INTEGER NOT NULL,

      description TEXT,

      recommended_version_id INTEGER,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      is_active INTEGER NOT NULL DEFAULT 1,

      FOREIGN KEY (owner_id)
        REFERENCES users(id),

      UNIQUE (name)
    );
  `);


  // ==========================================================
  // PUBLISHED ASSET VERSIONS
  // ==========================================================
  //
  // Once published, a version is immutable.
  //
  // Every published version has:
  //
  //     asset
  //     version number
  //     creator
  //     creation date
  //     version note
  //
  // ==========================================================

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

      FOREIGN KEY (created_by)
        REFERENCES users(id),

      UNIQUE (
        asset_id,
        version_number
      ),

      UNIQUE (
        id,
        asset_id
      )
    );
  `);


  // ==========================================================
  // RECOMMENDED VERSION RELATIONSHIP
  // ==========================================================
  //
  // This is deliberately a composite foreign key.
  //
  // It prevents:
  //
  //     Asset A
  //
  // from accidentally pointing at:
  //
  //     Asset B version 3
  //
  // as its recommended version.
  //
  // ==========================================================

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


  // ==========================================================
  // PHYSICAL FILE STORE
  // ==========================================================
  //
  // One row represents one unique set of bytes.
  //
  // SHA-256 is calculated from the actual uploaded file.
  //
  // Example:
  //
  // oak.png
  //
  // and
  //
  // oak_texture.png
  //
  // containing identical bytes will reference the same
  // stored_files row.
  //
  // ==========================================================

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


  // ==========================================================
  // FILES IN PRIVATE WORKSPACE VERSIONS
  // ==========================================================

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


  // ==========================================================
  // FILES IN PUBLISHED ASSET VERSIONS
  // ==========================================================

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


  // ==========================================================
  // INDEXES
  // ==========================================================

  db.exec(`
    CREATE INDEX IF NOT EXISTS
      idx_workspace_assets_workspace
      ON workspace_assets(workspace_id);

    CREATE INDEX IF NOT EXISTS
      idx_workspace_versions_asset
      ON workspace_versions(workspace_asset_id);

    CREATE INDEX IF NOT EXISTS
      idx_assets_owner
      ON assets(owner_id);

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


// ============================================================
// INITIALISE DATABASE
// ============================================================

const initDb = () => {

  // ==========================================================
  // INVITATIONS
  // ==========================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS invitations (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      email TEXT UNIQUE NOT NULL,

      assigned_role TEXT
        CHECK(
          assigned_role IN (
            'developer',
            'admin',
            'superuser'
          )
        )
        NOT NULL,

      token TEXT UNIQUE NOT NULL,

      is_used INTEGER DEFAULT 0,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      expires_at DATETIME
        DEFAULT (datetime('now', '+28 days')),

      reissue_count INTEGER DEFAULT 0
        CHECK(reissue_count <= 6),

      last_reissued_at DATETIME
    );
  `);


  applySchemaPatches();


  // ==========================================================
  // USERS
  // ==========================================================

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


  // ==========================================================
  // AUDIT LOGS
  // ==========================================================

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


  // ==========================================================
  // SESSIONS
  // ==========================================================

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


  // ==========================================================
  // API KEYS
  // ==========================================================

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


  // ==========================================================
  // ASSET REPOSITORY
  // ==========================================================

  applyAssetRepositorySchema();


  // ==========================================================
  // INITIAL SUPERUSER
  // ==========================================================

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


// ============================================================
// START DATABASE
// ============================================================

initDb();


// ============================================================
// EXPORT
// ============================================================

module.exports = db;
