// backend/db.js


const Database = require('better-sqlite3');
const path = require('path');

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
            CHECK(assigned_role IN ('user','developer','prod','admin'))
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

  // WHO ISSUED IT.
  //
  // The table recorded the address, the role and the dates, and nothing about
  // who created the invitation — so "where did this invitation come from?" had
  // no answer in the data, only in the audit log, which did not record
  // invitation creation either. That is the wrong gap for the one table whose
  // whole purpose is letting somebody in.
  //
  // NO ON DELETE, matching this file's convention for references to rows that
  // carry history. Accounts are deactivated here, never deleted, so this
  // cannot be left dangling.
  //
  // EXISTING ROWS ARE NULL, AND THAT IS THE TRUTH rather than a gap to
  // backfill: the invitations created before this column existed were not
  // recorded anywhere, and inventing an issuer for them would be worse than
  // admitting it is unknown.
  if (!columns.includes('created_by')) {
    db.exec(`
      ALTER TABLE invitations
      ADD COLUMN created_by INTEGER REFERENCES users(id);
    `);
  }

  // Where an invitation was issued. Existing rows are 'web', which is the
  // truth: every invitation that exists today was created from the admin page,
  // because the console path did not exist until it did.
  //
  // NOT NULL with a DEFAULT, unlike users.created_via. That column's whole
  // mechanism is its lack of a default — an insert that forgets it is
  // detectable. Here the distinction is between two legitimate origins, and an
  // invitation that somehow arrived without one is a web invitation with a
  // missing field rather than a signal worth raising.
  if (!columns.includes('source')) {
    db.exec(`
      ALTER TABLE invitations
      ADD COLUMN source TEXT NOT NULL DEFAULT 'web';
    `);
  }

  /*
   * assigned_role loses 'superuser' and gains 'prod'.
   *
   * SAME CONSTRAINT AS users.role, SAME PROBLEM: no ALTER for a CHECK, so it is
   * create-copy-drop-rename. This one is far simpler than the users rebuild —
   * invitations holds one row, and NOTHING REFERENCES THIS TABLE, so there are
   * no foreign keys to stand down and no children to follow the rename. It
   * references users (created_by) and that is the direction that does not
   * matter here.
   *
   * Runs here, at the END of the patches, rather than beside the declaration,
   * because the copy has to list every column and the later migrations are what
   * create created_by and source.
   */
  const invitesDdl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invitations'")
    .get()?.sql || '';

  const inviteRoles = invitesDdl.replace(/\s+/g, ' ').match(/assigned_role IN \(([^)]*)\)/);
  const assigned = inviteRoles
    ? inviteRoles[1].split(',').map(v => v.trim().replace(/^'|'$/g, ''))
    : [];

  if (!(assigned.length === 4
        && ['user', 'developer', 'prod', 'admin'].every(r => assigned.includes(r)))) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE invitations_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          assigned_role TEXT
            CHECK(assigned_role IN ('user','developer','prod','admin'))
            NOT NULL,
          token TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','used','revoked')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME DEFAULT (datetime('now', '+28 days')),
          reissue_count INTEGER DEFAULT 0 CHECK(reissue_count <= 6),
          last_reissued_at DATETIME,
          created_by INTEGER REFERENCES users(id),
          source TEXT NOT NULL DEFAULT 'web'
        );
      `);

      db.exec(`
        INSERT INTO invitations_rebuilt
          (id, email, assigned_role, token, status, created_at, expires_at,
           reissue_count, last_reissued_at, created_by, source)
        SELECT
           id, email, assigned_role, token, status, created_at, expires_at,
           reissue_count, last_reissued_at, created_by, source
        FROM invitations;
      `);

      db.exec('DROP TABLE invitations;');
      db.exec('ALTER TABLE invitations_rebuilt RENAME TO invitations;');
    })();

    console.log('🔁 invitations rebuilt: role list is now user, developer, prod, admin');
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
      deleted_at DATETIME,
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
      deleted_at DATETIME,
      files_purged_at DATETIME,
      purged_file_manifest TEXT,
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

  /*
   * ----------------------------------------------------------
   * stored_files — THE PHYSICAL CONTENT, AND THE ONLY COPY OF IT
   *
   * THERE IS ONE AND ONLY ONE COPY OF ANY SHA-256 IN THE
   * ENTIRE PROJECT, and UNIQUE (sha256) below is what makes
   * that true rather than merely intended. Every reference
   * anywhere — a developer's workspace, the game store, a
   * release — points at a row in this table. None of them
   * owns the bytes, and none of them gets a second copy.
   *
   * So "uploading the same file again" is a no-op on disk. It
   * adds a REFERENCE, not a file, and costs nothing: if the
   * SHA is already here, the existing row is reused and no
   * bytes are written. This is why quota is accounted per
   * workspace rather than per stored file, and why the same
   * content in two places is one file with two referrers.
   *
   * Consequence worth knowing before writing anything that
   * counts these: summing per-user or per-workspace figures
   * will never equal the disk, because one file can be
   * referenced many times and a file referenced by nobody is
   * still occupying bytes. Ask df for the disk.
   * ----------------------------------------------------------
   */

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

  /*
   * ----------------------------------------------------------
   * The Library — THE THIRD SPACE
   *
   * Source material, not game assets. An image is a COMPONENT
   * in a library; an asset is a unit of game content that a
   * developer assembles, which may USE components. Neither is
   * a stage of the other. See TODO 57 and 58.
   *
   * WHICH MAKES THIS THE THIRD REFERENCER OF stored_files —
   * after workspace_version_files and asset_version_files —
   * and that is not a detail. backend/jobs/daily.js decides
   * a blob is GARBAGE when neither of the other two mentions
   * it, so a third table it does not know about means every
   * library blob becomes collectable once it ages past the
   * grace window. THE COLLECTOR LEARNS ABOUT THIS TABLE IN
   * THE SAME CHANGE, and if it ever gains a fourth referencer
   * the same two places must be found again:
   *
   *   backend/jobs/daily.js       the NOT EXISTS pair
   *   backend/lib/workspaceUsage.js   the quota NOT IN
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- The blob. UNIQUE, which is the one-copy rule made
      -- structural rather than checked: the same content
      -- cannot produce two items, so "it is already in the
      -- library" is true by construction and cannot be
      -- forgotten by a route.
      stored_file_id INTEGER NOT NULL,

      -- What a human calls it, and what it was called when it
      -- arrived. The original is kept because a display name
      -- is editable and the filename is evidence.
      display_name TEXT NOT NULL,
      original_name TEXT,
      note TEXT,

      -- THE LIGHT GATE. A library item is not approved into
      -- anything, so it is not refused for being mislabelled
      -- — a JPEG named .png is still a picture. It IS refused
      -- for being blocked content or empty; see routes/library.js.
      content_state TEXT NOT NULL DEFAULT 'unverified'
        CHECK (
          content_state IN (
            'confirmed',
            'contradicted',
            'unverifiable'
          )
        ),

      added_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      -- Soft delete, so removing something from the library
      -- frees its blob for collection without destroying the
      -- record that it was there.
      is_active INTEGER NOT NULL DEFAULT 1,
      deleted_at DATETIME,

      FOREIGN KEY (stored_file_id)
        REFERENCES stored_files(id),

      UNIQUE (stored_file_id)
    );
  `);

  /*
   * Thumbnails are DERIVED, so they are NOT stored_files rows.
   *
   * stored_files holds authored content — one copy of every
   * byte the studio made. A thumbnail is produced FROM that
   * content, the way a build is produced from a project, and
   * item 69 of the TODO draws that line. So they live in their
   * own directory as a CACHE, named by the source blob's
   * SHA-256 — deterministic, deduplicated by construction, and
   * disposable: deleting one costs a regeneration, not a file.
   *
   * A TABLE RATHER THAN A COLUMN, because `kind` is the point:
   * a video poster frame or a 3D turntable becomes a ROW, not
   * a migration. Only `image` is generated today.
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_thumbnails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_item_id INTEGER NOT NULL,

      kind TEXT NOT NULL
        CHECK (
          kind IN (
            'image',
            'video_frame',
            'model_preview'
          )
        ),

      -- A SHA-256, and the filename inside THUMB_DIR.
      storage_key TEXT NOT NULL,

      width INTEGER,
      height INTEGER,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (library_item_id)
        REFERENCES library_items(id)
        ON DELETE CASCADE,

      UNIQUE (library_item_id, kind)
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

    -- The library is listed newest-first, and its blob link is
    -- looked up by the collector's NOT EXISTS and by the quota
    -- exclusion. Both want an index.
    CREATE INDEX IF NOT EXISTS
      idx_library_items_stored_file
      ON library_items(stored_file_id);

    CREATE INDEX IF NOT EXISTS
      idx_library_items_created
      ON library_items(created_at);

    CREATE INDEX IF NOT EXISTS
      idx_library_thumbnails_item
      ON library_thumbnails(library_item_id);
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

  // WHEN it was deleted, which nothing recorded before.
  //
  // is_active = 0 says a thing is gone; it never said how long it had been
  // gone, so a retention window had nothing to measure from. This is the column
  // the wastebin counts its 14 days with, and the reason it could not be built
  // before now.
  if (!workspaceAssetColumns.includes('deleted_at')) {
    db.exec(`
      ALTER TABLE workspace_assets
      ADD COLUMN deleted_at DATETIME;
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

  // Soft delete. The ROW cannot be removed once the version has been checked or
  // reviewed — technical_check_runs and creative_approvals reference it with
  // foreign keys that have no ON DELETE clause — and that turns out not to
  // matter, because the row is worth keeping and the FILES are not.
  //
  // An earlier note here said the constraint was deliberate because "the
  // history of something submitted should not be erasable". That reasoning was
  // wrong for a staging area: a failed check is a record OF AN ATTEMPT, and
  // when the attempt goes it has nothing left to describe. What the developer
  // wants gone is the CONTENT, which is what these two columns are for.
  if (!workspaceVersionColumns.includes('is_active')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
    `);
  }

  // WHEN it was deleted — see the note on workspace_assets.deleted_at above.
  if (!workspaceVersionColumns.includes('deleted_at')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN deleted_at DATETIME;
    `);
  }

  // WHEN its files were actually removed, and WHAT they were.
  //
  // These two are physical delete. Removing the file rows is what frees the
  // content — they hold the only reference to the blob — and the manifest is
  // the record kept in their place, so the version still says what it was made
  // of after the files are gone.
  //
  // The manifest holds NAMES, PATHS, SIZES and HASHES only. If it ever starts
  // holding content, the point has been undone.
  if (!workspaceVersionColumns.includes('files_purged_at')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN files_purged_at DATETIME;
    `);
  }

  if (!workspaceVersionColumns.includes('purged_file_manifest')) {
    db.exec(`
      ALTER TABLE workspace_versions
      ADD COLUMN purged_file_manifest TEXT;
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
            'prod',
            'admin'
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

      last_reissued_at DATETIME,

      -- Who issued it. NULL only for invitations that predate the column —
      -- see the migration in applySchemaPatches.
      created_by INTEGER REFERENCES users(id),

      -- WHERE THE INVITATION WAS ISSUED: 'web' or 'console'.
      --
      -- The web interface can only invite developers and testers. Admin and
      -- privileged invitations can ONLY be created on the studio machine, by
      -- scripts/accounts.js, because backend/lib/roles.js refuses
      -- those roles to every web request.
      --
      -- RECORDED RATHER THAN INFERRED. The role alone would tell you the same
      -- thing today, and that inference would silently become wrong the day
      -- the role rule changes. It also decides what an account records as its
      -- origin when the invitation is redeemed — see server.js.
      source TEXT NOT NULL DEFAULT 'web'
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

      -- FOUR ROLES. 'superuser' was removed on 2026-10-06 — it had no
      -- accounts, no routes and no page, and the one property it provided (a
      -- peer cannot act on a peer) already holds at admin level.
      --
      -- 'prod' IS NOT A SENIORITY. It is a CRAFT role: somebody who decides
      -- whether work is good enough for the game, who comments, and who
      -- organises categories and boards. It has NO workspace, NO admin powers,
      -- and cannot deactivate or invite anyone. Everything it may do comes from
      -- named capabilities rather than from a rung — see TODO 51 and 52, and
      -- the map in backend/lib/roles.js.
      role TEXT
        CHECK(
          role IN (
            'user',
            'developer',
            'prod',
            'admin'
          )
        )
        NOT NULL
        DEFAULT 'user',

      two_factor_secret TEXT,

      is_2fa_enabled INTEGER DEFAULT 0,

      is_active INTEGER DEFAULT 1,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      -- HOW THIS ACCOUNT CAME TO EXIST.
      --
      -- One of: 'bootstrap' (made by db.js when the database was empty),
      -- 'invitation' (somebody redeemed an invitation), 'google' (first
      -- sign-in through Google), or 'manual' (made by hand, outside the
      -- application).
      --
      -- NO DEFAULT, AND THAT IS THE WHOLE MECHANISM. Every path in the
      -- application sets it explicitly, so a row inserted by something that
      -- does not know about this column — an ad-hoc command, a script somebody
      -- wrote in a hurry — lands as NULL. NULL therefore means "nothing that
      -- runs in this application created this account", which is the question
      -- worth asking about a login nobody expected.
      --
      -- A DEFAULT would defeat it completely: every insert would look
      -- explained.
      created_via TEXT,

      CHECK (
        password_hash IS NOT NULL
        OR github_id IS NOT NULL
        OR google_id IS NOT NULL
      )
    );
  `);

  /*
   * ----------------------------------------------------------
   * Migrations that are not tied to one table
   *
   * Kept in the same guarded style as applySchemaPatches: read the columns,
   * add what is missing, run again safely on every start.
   * ----------------------------------------------------------
   */

  const userColumns = db
    .prepare("PRAGMA table_info(users)")
    .all()
    .map(c => c.name);

  /*
   * created_via — how each account came to exist.
   *
   * See the column declaration for why it has no default. This adds it, and
   * then deals with the rows that were already here.
   *
   * THE BACKFILL IS A JUDGEMENT, RECORDED RATHER THAN ASSUMED. The three
   * accounts that existed when this column was added (admin, val)
   * were all made by hand: db.js's own seed inserts 'admin' with the address
   * admin@lowexpectations.com, and the live row has
   * admin@lowexpectations.zone, so the seed did not create it. They are
   * therefore marked 'manual', which is what they are.
   *
   * The alternative was to leave them NULL and let the new check report them
   * for ever. That is how a check that always has something in it becomes a
   * check nobody reads — and the point of this one is to be believed on the
   * day it speaks. Marking them is the honest record; leaving them would have
   * been the honest state and a useless alarm.
   *
   * If a row here is NOT actually what it says, the check cannot tell — but
   * nothing can, and this at least says somebody looked.
   */
  if (!userColumns.includes('created_via')) {
    db.exec('ALTER TABLE users ADD COLUMN created_via TEXT;');

    db.exec(`
      UPDATE users
      SET created_via = 'manual'
      WHERE created_via IS NULL;
    `);

    console.log(
      '🔎 users.created_via added; existing accounts recorded as created by hand'
    );
  }

  /*
   * ----------------------------------------------------------
   * users.role — A TABLE REBUILD, AND IT HAS TO BE
   * ----------------------------------------------------------
   *
   * SQLite cannot ALTER a CHECK constraint, so widening the role list means
   * create-copy-drop-rename. That is the same procedure this file already uses
   * for invitations, and on `users` it needs more care: NINE foreign keys point
   * at this table, so dropping it with foreign_keys ON would either fail or
   * cascade.
   *
   * THE FOREIGN KEYS ARE TURNED OFF OUTSIDE THE TRANSACTION, which is not
   * decoration — PRAGMA foreign_keys is a no-op inside one, so setting it within
   * the transaction would silently leave enforcement on and the DROP would
   * fail. They are turned back on afterwards and followed by a
   * foreign_key_check, because "we put it back" is not the same as "nothing
   * dangled".
   *
   * The children reference this table BY NAME, so they follow the rename: after
   * DROP and RENAME, `users` exists again and every key that pointed at it
   * points at the new one.
   *
   * WHY DETECT IT FROM THE DDL. There is no pragma for CHECK constraints —
   * table_info lists columns and nothing else — so the only place the role list
   * is visible is the CREATE statement itself.
   *
   * THE GUARD COMPARES THE WHOLE LIST, not the presence of one value. An
   * earlier version of this checked only whether 'prod' was allowed, which
   * would have been satisfied by a table that had gained prod and still carried
   * a role that was being removed. Comparing the list means the table is
   * rebuilt whenever it disagrees with the declaration above, in either
   * direction, and the next role change needs no new migration written.
   */
  const ROLES = ['user', 'developer', 'prod', 'admin'];

  const usersDdl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get()?.sql || '';

  const declared = usersDdl.replace(/\s+/g, ' ').match(/role IN \(([^)]*)\)/);
  const actual = declared
    ? declared[1].split(',').map(v => v.trim().replace(/^'|'$/g, ''))
    : [];

  const sameRoles =
    actual.length === ROLES.length && ROLES.every(r => actual.includes(r));

  if (!sameRoles) {
    db.pragma('foreign_keys = OFF');

    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE users_rebuilt (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            github_id TEXT UNIQUE,
            github_username TEXT,
            google_id TEXT UNIQUE,
            role TEXT
              CHECK(role IN ('user','developer','prod','admin'))
              NOT NULL
              DEFAULT 'user',
            two_factor_secret TEXT,
            is_2fa_enabled INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_via TEXT,
            CHECK (
              password_hash IS NOT NULL
              OR github_id IS NOT NULL
              OR google_id IS NOT NULL
            )
          );
        `);

        db.exec(`
          INSERT INTO users_rebuilt
            (id, username, email, password_hash, github_id, github_username,
             google_id, role, two_factor_secret, is_2fa_enabled, is_active,
             created_at, created_via)
          SELECT
             id, username, email, password_hash, github_id, github_username,
             google_id, role, two_factor_secret, is_2fa_enabled, is_active,
             created_at, created_via
          FROM users;
        `);

        db.exec('DROP TABLE users;');
        db.exec('ALTER TABLE users_rebuilt RENAME TO users;');
      })();
    } finally {
      // Restored whether the rebuild succeeded or threw, so a failure does not
      // leave the connection with enforcement off for the rest of its life.
      db.pragma('foreign_keys = ON');
    }

    const dangling = db.pragma('foreign_key_check');

    console.log(
      dangling.length === 0
        ? `🔁 users rebuilt: roles are now ${ROLES.join(', ')} — no dangling references`
        : `⚠️  users rebuilt but ${dangling.length} dangling reference(s) — DO NOT ignore this`
    );
  }



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
   * Application settings — values an administrator changes
   *
   * NO SURROGATE id, WHICH IS A DELIBERATE DEPARTURE from every
   * other table here. The key IS the identity: nothing
   * references a setting by number, so an autoincrementing
   * column would be an extra thing to keep unique and nothing
   * more.
   *
   * A MISSING ROW IS NOT AN ERROR. It means "not overridden",
   * and the code default applies — the registry in
   * backend/lib/settings.js holds it. A fresh database therefore
   * needs no seeding, and the page can show an administrator
   * what the value would fall back to before they change it.
   *
   * updated_by has no ON DELETE, matching this file's
   * convention for references to rows that carry history.
   * Users are never deleted here, only deactivated.
   *
   * THE VALUES ARE TEXT. Every one of them is a whole number
   * today, but the column is the generic one so that a setting
   * which is not a number does not need a schema change — the
   * type is declared once, per key, in the registry, which is
   * also where the bounds live.
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,

      value TEXT NOT NULL,

      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      updated_by INTEGER REFERENCES users(id)
    );
  `);


  /*
   * ----------------------------------------------------------
   * Feedback — bug reports and suggestions
   *
   * WHO AND WHEN ARE NOT COLUMNS THE CLIENT CAN SET. actor_id
   * comes from the session token and created_at from the
   * server clock; the route reads neither from the request
   * body. A report that cannot be trusted about who sent it,
   * or when, is not worth collecting.
   *
   * user_id is NULLABLE ON PURPOSE. Someone who cannot sign in
   * is the most likely person to want to report something, and
   * they have no session by definition. A NULL there is not
   * missing data — it says the report came from outside, which
   * is usually the fault being reported.
   *
   * username and role are SNAPSHOTS taken at the time. The
   * actor_id is the link and survives a rename; these are so
   * the report still reads correctly years later, when the
   * account may have been renamed, deactivated or removed.
   * ----------------------------------------------------------
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER,
      username TEXT,
      role TEXT,
      contact_email TEXT,

      kind TEXT NOT NULL,
      message TEXT NOT NULL,

      page_url TEXT,

      status TEXT NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      resolved_by INTEGER,
      resolved_at DATETIME,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // The list an admin reads is "open ones, newest first", so the index matches
  // that order rather than the table's.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_feedback_status
      ON feedback(status, created_at DESC);
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
   * NO ACCOUNTS ARE CREATED HERE. DELIBERATELY.
   * ----------------------------------------------------------
   *
   * This used to seed a superuser called "admin" with a known, published
   * password whenever the users table was empty, and print that password to
   * the console.
   *
   * Two things were wrong with it and only one of them was the password being
   * weak. The literal was IN THE REPOSITORY, on the most privileged account in
   * the system — and it was PRINTED, where anybody watching the terminal, or
   * reading a captured log, could read it.
   *
   * The deeper problem is that it existed at all: a database that gives itself
   * a known credential the moment it is created is the weakest thing in the
   * system, and it was there only so a fresh install had a way in.
   *
   * SO A FRESH DATABASE NOW HAS NO ACCOUNTS AND NO WAY IN, and that is the
   * intended property rather than an oversight:
   *
   *     node scripts/accounts.js
   *
   * Admin accounts are created on the studio machine, by somebody with shell
   * access to it, and never through the web interface. The fact that it needs a
   * shell IS the control. See scripts/accounts.js and TODO 43.
   *
   * If you are looking at a database with no accounts and wondering why you
   * cannot sign in: that is why, and the command above is the way back in.
   */

  console.log(
    '⚡ SQLite Database & Auth Tables Ready.'
  );
};


initDb();

module.exports = db;
