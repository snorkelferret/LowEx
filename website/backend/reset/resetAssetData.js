const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// resetAssetData.js is in backend/reset/
// The database and the upload store are BOTH one level up, in backend/.
// ('../../uploads/files' resolved to <repo>/uploads/files, which does not
// exist, so this script deleted every stored_files row and then reported
// "nothing to delete", orphaning the physical files it had just untracked.)
const dbPath = path.join(__dirname, '../database.db');
// The blob directory, from the module that owns the layout — see the
// comment above about the '../../' that made this script untrack every
// file and then report that there was nothing to delete.
const { BLOB_DIR: storageDir } = require('../lib/storagePaths');

const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

console.log('Database:', dbPath);
console.log('Storage:', storageDir);

const tables = [
    'asset_comments',
    'technical_check_results',
    'technical_check_runs',
    'creative_approvals',
    'asset_version_files',
    'workspace_version_files',
    'asset_recommended_versions',
    'asset_versions',
    'assets',
    'workspace_versions',
    'workspace_assets',
    'developer_workspaces',
    'stored_files'
];

const existingTables = new Set(
    db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
    `).all().map(row => row.name)
);

const deleteTestData = db.transaction(() => {
    console.log('Deleting asset/workspace test data...');

    for (const table of tables) {
        if (!existingTables.has(table)) {
            console.log(`  Skipping ${table} (table does not exist)`);
            continue;
        }

        console.log(`  Clearing ${table}`);
        db.prepare(`DELETE FROM "${table}"`).run();
    }
});

deleteTestData();


// -----------------------------------------------------------------------------
// Delete physical asset files.
// -----------------------------------------------------------------------------

if (fs.existsSync(storageDir)) {
    console.log('Deleting physical test files...');

    const entries = fs.readdirSync(storageDir, {
        withFileTypes: true
    });

    for (const entry of entries) {
        const fullPath = path.join(storageDir, entry.name);

        fs.rmSync(fullPath, {
            recursive: true,
            force: true
        });
    }

    console.log(`Deleted ${entries.length} item(s) from asset storage.`);
} else {
    console.log('Asset storage directory does not exist; nothing to delete.');
}

db.close();

console.log('');
console.log('Asset test-data reset complete.');
console.log('Users and authentication data were preserved.');
