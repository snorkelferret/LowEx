// backend/db.js
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

// Establish connection to SQLite database
const dbPath = path.join(__dirname, 'database.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Safely add missing columns to existing tables without breaking data
const applySchemaPatches = () => {
  const columns = db.prepare("PRAGMA table_info(invitations)").all().map(c => c.name);

  // Add 28-day expiration (defaults to 28 days from creation time)
  if (!columns.includes('expires_at')) {
    db.exec(`ALTER TABLE invitations ADD COLUMN expires_at DATETIME DEFAULT (datetime('now', '+28 days'));`);
    // Backfill existing records to expire in 28 days if they were NULL
    db.exec(`UPDATE invitations SET expires_at = datetime('now', '+28 days') WHERE expires_at IS NULL;`);
  }

  // Add reissue_count tracking (max 6 cap via application logic)
  if (!columns.includes('reissue_count')) {
    db.exec(`ALTER TABLE invitations ADD COLUMN reissue_count INTEGER DEFAULT 0;`);
  }

  // Add last_reissued_at timestamp
  if (!columns.includes('last_reissued_at')) {
    db.exec(`ALTER TABLE invitations ADD COLUMN last_reissued_at DATETIME;`);
  }
};

// Initialize Database Schema
const initDb = () => {
  // Invitations Table (Updated with 28-day expiration & reissue limit)
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      assigned_role TEXT CHECK(assigned_role IN ('developer', 'admin', 'superuser')) NOT NULL,
      token TEXT UNIQUE NOT NULL,
      is_used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT (datetime('now', '+28 days')),
      reissue_count INTEGER DEFAULT 0 CHECK(reissue_count <= 6),
      last_reissued_at DATETIME
    );
  `);

  // Apply column additions if running against an existing database file
  applySchemaPatches();

  // Users Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      github_id TEXT UNIQUE,
      github_username TEXT,
      google_id TEXT UNIQUE,
      role TEXT CHECK(role IN ('user', 'developer', 'admin', 'superuser')) NOT NULL DEFAULT 'user',
      two_factor_secret TEXT,
      is_2fa_enabled INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (password_hash IS NOT NULL OR github_id IS NOT NULL OR google_id IS NOT NULL)
    );
  `);

  // Audit Logs Table
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

  // Sessions Table
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

  // API Keys Table
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

  // Seed Default Initial Superuser if database is fresh
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const salt = bcrypt.genSaltSync(12);
    const hashedPassword = bcrypt.hashSync('SuperPassword123!', salt);

    db.prepare(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES (?, ?, ?, 'superuser')
    `).run('admin', 'admin@lowexpectations.com', hashedPassword);

    console.log('🔑 Initial superuser created: username="admin", password="SuperPassword123!"');
  }

  console.log('⚡ SQLite Database & Auth Tables Ready.');
};

initDb();

module.exports = db;
