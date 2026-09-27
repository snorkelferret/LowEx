//backend/routes/developerWorkspace.js
const express = require('express');
const router = express.Router();

const db = require('../db');
const {
    authenticateToken,
    requireRole
} = require('../middleware/auth');


const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');


// ============================================================
// Temporary upload storage
// ============================================================

const tempUploadDir = path.join(__dirname, '../uploads/tmp');

fs.mkdirSync(tempUploadDir, { recursive: true });



// ============================================================
// GET /api/developer/workspace/assets
// ============================================================
//
// Return the logged-in developer's private workspace assets.
//
// A developer can ONLY see their own workspace here.
// ============================================================

router.get(
    '/assets',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),
    async (req, res) => {
        try {
            const developerId = req.user?.userId ?? req.user?.id;

            if (!developerId) {
                return res.status(401).json({
                    error: 'Authenticated user ID not found'
                });
            }

            let workspace = db.prepare(`
                SELECT *
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);

            if (!workspace) {
                const result = db.prepare(`
                    INSERT INTO developer_workspaces (developer_id)
                    VALUES (?)
                `).run(developerId);

                workspace = db.prepare(`
                    SELECT *
                    FROM developer_workspaces
                    WHERE id = ?
                `).get(result.lastInsertRowid);
            }

            const assets = db.prepare(`
                SELECT
                    id,
                    name,
                    asset_type,
                    description,
                    created_at,
                    updated_at,
                    is_active
                FROM workspace_assets
                WHERE workspace_id = ?
                  AND is_active = 1
                ORDER BY name COLLATE NOCASE
            `).all(workspace.id);

            const getVersions = db.prepare(`
                SELECT
                    id,
                    version_number,
                    version_note,
                    created_by,
                    created_at
                FROM workspace_versions
                WHERE workspace_asset_id = ?
                ORDER BY version_number DESC
            `);

            const getFiles = db.prepare(`
                SELECT
                    wvf.id,
                    wvf.filename,
                    wvf.relative_path,
                    wvf.created_at,
                    sf.file_size,
                    sf.mime_type,
                    sf.sha256
                FROM workspace_version_files wvf
                JOIN stored_files sf
                    ON sf.id = wvf.stored_file_id
                WHERE wvf.workspace_version_id = ?
                ORDER BY
                    COALESCE(wvf.relative_path, '') COLLATE NOCASE,
                    wvf.filename COLLATE NOCASE
            `);

            for (const asset of assets) {
                asset.versions = getVersions.all(asset.id);

                for (const version of asset.versions) {
                    version.files = getFiles.all(version.id);
                }
            }

            console.log('Developer workspace:', workspace);
            console.log('Developer assets:', assets);

            return res.json({
                workspace,
                assets
            });

        } catch (err) {
            console.error('Failed to load developer workspace:', err);

            return res.status(500).json({
                error: 'Failed to load developer workspace'
            });
        }
    }
);

// ============================================================
// TEST FILE UPLOAD
// ============================================================
//
// This stage deliberately does NOT create:
//
//   workspace_assets
//   workspace_versions
//   workspace_version_files
//
// It only proves:
//
//   upload
//      ↓
//   SHA-256
//      ↓
//   already in stored_files?
//      /       \
//    yes        no
//     │          │
//     │      store physical file
//     │          │
//     └────┬─────┘
//          ↓
//      return result
//
// ============================================================



// ============================================================
// DEVELOPER ASSET UPLOAD
// ============================================================
//
// Upload one or more files into the developer's private
// workspace.
//
// The browser supplies the final logical filename and
// relative_path after the developer has reviewed/edited them.
//
// Physical files are deduplicated by SHA-256.
//
// Database records created:
//
//   workspace_assets
//          ↓
//   workspace_versions
//          ↓
//   workspace_version_files
//          ↓
//   stored_files
//
// The database changes are atomic.
// ============================================================

const assetUpload = multer({
    dest: tempUploadDir
});

router.post(
    '/upload',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    assetUpload.fields([
        { name: 'files', maxCount: 1000 }
    ]),

    async (req, res) => {

        const uploadedFiles = req.files?.files || [];

        if (uploadedFiles.length === 0) {
            return res.status(400).json({
                error: 'No files uploaded'
            });
        }

        const developerId = req.user?.userId;

        if (!developerId) {
            return res.status(401).json({
                error: 'Invalid authentication context'
            });
        }


        // --------------------------------------------------------
        // Temporary and newly-created physical files
        // --------------------------------------------------------

        const tempPaths = uploadedFiles.map(file => file.path);

        try {

            // ----------------------------------------------------
            // Metadata
            // ----------------------------------------------------

            const assetName =
                String(req.body.asset_name || '').trim();

            const assetType =
                String(req.body.asset_type || '').trim();

            const description =
                String(req.body.description || '').trim();

            const versionNote =
                String(
                    req.body.version_note ||
                    'Initial upload'
                ).trim();


            if (!assetName) {
                throw new Error('Asset name is required');
            }

            if (!versionNote) {
                throw new Error('Version note is required');
            }


            // ----------------------------------------------------
            // File paths supplied by the browser
            //
            // One entry for each uploaded file.
            //
            // Example:
            //
            // [
            //   "models/OakTree.blend",
            //   "textures/OakTree.png"
            // ]
            // ----------------------------------------------------

            let filePaths = [];

            if (req.body.file_paths) {

                try {
                    filePaths = JSON.parse(req.body.file_paths);
                } catch (err) {
                    throw new Error(
                        'Invalid file path information'
                    );
                }

                if (!Array.isArray(filePaths)) {
                    throw new Error(
                        'Invalid file path information'
                    );
                }
            }


            // ----------------------------------------------------
            // Filename overrides
            //
            // Optional JSON object:
            //
            // {
            //   "models/OakTree.blend": "OakTree_LOD.blend"
            // }
            // ----------------------------------------------------

            let filenameOverrides = {};

            if (req.body.filename_overrides) {

                try {
                    filenameOverrides =
                        JSON.parse(
                            req.body.filename_overrides
                        );
                } catch (err) {
                    throw new Error(
                        'Invalid filename override information'
                    );
                }

                if (
                    typeof filenameOverrides !== 'object' ||
                    Array.isArray(filenameOverrides) ||
                    filenameOverrides === null
                ) {
                    throw new Error(
                        'Invalid filename override information'
                    );
                }
            }


            // ----------------------------------------------------
            // Construct the final logical file information.
            //
            // The browser has already allowed the developer to
            // review/change these values.
            // ----------------------------------------------------

            const processedFiles = [];
            const logicalPaths = new Set();


            for (
                let i = 0;
                i < uploadedFiles.length;
                i++
            ) {

                const file = uploadedFiles[i];


                // ------------------------------------------------
                // Original relative path
                // ------------------------------------------------

                let logicalPath =
                    typeof filePaths[i] === 'string' &&
                    filePaths[i].trim()
                        ? filePaths[i].trim()
                        : file.originalname;


                logicalPath = logicalPath
                    .replace(/\\/g, '/')
                    .replace(/^\/+/, '');


                // ------------------------------------------------
                // Normalise and prevent directory traversal.
                // ------------------------------------------------

                logicalPath = path.posix.normalize(
                    logicalPath
                );

                while (
                    logicalPath.startsWith('../')
                ) {
                    logicalPath =
                        logicalPath.substring(3);
                }

                logicalPath =
                    logicalPath.replace(/^\/+/, '');


                if (
                    !logicalPath ||
                    logicalPath === '.'
                ) {
                    throw new Error(
                        `Invalid path for uploaded file: ${file.originalname}`
                    );
                }


                // ------------------------------------------------
                // Original filename
                // ------------------------------------------------

                const originalFilename =
                    path.posix.basename(logicalPath);


                if (!originalFilename) {
                    throw new Error(
                        `Invalid filename: ${logicalPath}`
                    );
                }


                // ------------------------------------------------
                // Relative directory
                // ------------------------------------------------

                let relativePath =
                    path.posix.dirname(logicalPath);

                if (relativePath === '.') {
                    relativePath = '';
                }


                // ------------------------------------------------
                // Optional filename override
                //
                // The key is the ORIGINAL logical path.
                // ------------------------------------------------

                const override =
                    filenameOverrides[logicalPath];


                let filename =
                    originalFilename;


                if (
                    typeof override === 'string' &&
                    override.trim()
                ) {

                    filename =
                        path.posix.basename(
                            override.trim()
                        );

                    if (!filename) {
                        throw new Error(
                            `Invalid filename override for ${logicalPath}`
                        );
                    }
                }


                // ------------------------------------------------
                // Final logical path.
                // ------------------------------------------------

                const finalLogicalPath =
                    relativePath
                        ? `${relativePath}/${filename}`
                        : filename;


                // ------------------------------------------------
                // Prevent two uploaded files from ending up at
                // exactly the same logical location.
                // ------------------------------------------------

                if (
                    logicalPaths.has(finalLogicalPath)
                ) {
                    throw new Error(
                        `Duplicate destination path: ${finalLogicalPath}`
                    );
                }

                logicalPaths.add(finalLogicalPath);


                processedFiles.push({
                    file,
                    filename,
                    relativePath
                });
            }


            // ----------------------------------------------------
            // Find the developer's workspace
            // ----------------------------------------------------

            let workspace = db.prepare(`
                SELECT
                    id
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);


            if (!workspace) {

                const result = db.prepare(`
                    INSERT INTO developer_workspaces (
                        developer_id
                    )
                    VALUES (?)
                `).run(developerId);

                workspace = {
                    id: result.lastInsertRowid
                };
            }


            // ----------------------------------------------------
            // Move new physical files and prepare their metadata.
            //
            // Existing identical files are reused.
            // ----------------------------------------------------

            // ----------------------------------------------------
            // Calculate SHA-256 for every uploaded file before
            // entering the database transaction.
            // ----------------------------------------------------

            async function calculateSha256(filePath) {
                return new Promise((resolve, reject) => {
                    const hash = crypto.createHash('sha256');
                    const stream = fs.createReadStream(filePath);

                    stream.on('error', reject);
                    stream.on('data', chunk => hash.update(chunk));
                    stream.on('end', () => {
                        resolve(hash.digest('hex'));
                    });
                });
            }


            for (const item of processedFiles) {
                item.sha256 =
                    await calculateSha256(item.file.path);
            }


            // ----------------------------------------------------
            // Permanent content storage directory.
            // ----------------------------------------------------

            const storageDir =
                path.join(
                    __dirname,
                    '../uploads/files'
                );

            fs.mkdirSync(
                storageDir,
                { recursive: true }
            );


            // ----------------------------------------------------
            // Everything below is one SQLite transaction.
            //
            // IMMEDIATE is important:
            //
            // Once this transaction starts, another writer cannot
            // enter its own write transaction until this one has
            // finished.
            //
            // The physical content-store operation therefore occurs
            // while the database write lock is held.
            // ----------------------------------------------------

            const createAssetVersion =
                db.transaction(() => {

                    // Physical files created by THIS transaction.
                    //
                    // If anything below fails, these are removed
                    // before the SQLite transaction is allowed to
                    // roll back and release its write lock.
                    const newlyStoredPaths = [];

                    try {

                        // --------------------------------------------
                        // Find existing workspace asset
                        // --------------------------------------------

                        let asset = db.prepare(`
                            SELECT
                                id,
                                name,
                                asset_type,
                                description,
                                created_at,
                                updated_at,
                                is_active
                            FROM workspace_assets
                            WHERE workspace_id = ?
                              AND name = ?
                        `).get(
                            workspace.id,
                            assetName
                        );


                        // --------------------------------------------
                        // Create asset if it doesn't exist.
                        // --------------------------------------------

                        if (!asset) {

                            const result = db.prepare(`
                                INSERT INTO workspace_assets (
                                    workspace_id,
                                    name,
                                    asset_type,
                                    description
                                )
                                VALUES (?, ?, ?, ?)
                            `).run(
                                workspace.id,
                                assetName,
                                assetType || null,
                                description || null
                            );


                            asset = db.prepare(`
                                SELECT
                                    id,
                                    name,
                                    asset_type,
                                    description,
                                    created_at,
                                    updated_at,
                                    is_active
                                FROM workspace_assets
                                WHERE id = ?
                            `).get(
                                result.lastInsertRowid
                            );

                        } else {

                            // ----------------------------------------
                            // Update supplied metadata.
                            // ----------------------------------------

                            db.prepare(`
                                UPDATE workspace_assets
                                SET
                                    asset_type =
                                        COALESCE(?, asset_type),

                                    description =
                                        COALESCE(?, description),

                                    updated_at =
                                        CURRENT_TIMESTAMP

                                WHERE id = ?
                            `).run(
                                assetType || null,
                                description || null,
                                asset.id
                            );


                            asset = db.prepare(`
                                SELECT
                                    id,
                                    name,
                                    asset_type,
                                    description,
                                    created_at,
                                    updated_at,
                                    is_active
                                FROM workspace_assets
                                WHERE id = ?
                            `).get(asset.id);
                        }


                        // --------------------------------------------
                        // Find next workspace version number.
                        // --------------------------------------------

                        const latestVersion =
                            db.prepare(`
                                SELECT
                                    MAX(version_number)
                                        AS version_number
                                FROM workspace_versions
                                WHERE workspace_asset_id = ?
                            `).get(asset.id);


                        const versionNumber =
                            (latestVersion?.version_number || 0) + 1;


                        // --------------------------------------------
                        // Create workspace version.
                        // --------------------------------------------

                        const versionResult =
                            db.prepare(`
                                INSERT INTO workspace_versions (
                                    workspace_asset_id,
                                    version_number,
                                    created_by,
                                    version_note
                                )
                                VALUES (?, ?, ?, ?)
                            `).run(
                                asset.id,
                                versionNumber,
                                developerId,
                                versionNote
                            );


                        const versionId =
                            versionResult.lastInsertRowid;


                        // --------------------------------------------
                        // Prepare stored_files statements.
                        // --------------------------------------------

                        const getStoredFile =
                            db.prepare(`
                                SELECT
                                    id,
                                    sha256,
                                    file_size,
                                    storage_key,
                                    mime_type,
                                    created_at
                                FROM stored_files
                                WHERE sha256 = ?
                            `);


                        const insertStoredFile =
                            db.prepare(`
                                INSERT INTO stored_files (
                                    sha256,
                                    file_size,
                                    storage_key,
                                    mime_type
                                )
                                VALUES (?, ?, ?, ?)
                            `);


                        const insertVersionFile =
                            db.prepare(`
                                INSERT INTO workspace_version_files (
                                    workspace_version_id,
                                    stored_file_id,
                                    filename,
                                    relative_path
                                )
                                VALUES (?, ?, ?, ?)
                            `);


                        // --------------------------------------------
                        // Process every uploaded file.
                        //
                        // The database write lock is already held.
                        // --------------------------------------------

                        for (const item of processedFiles) {

                            const file = item.file;
                            const sha256 = item.sha256;

                            let storedFile =
                                getStoredFile.get(sha256);


                            // ----------------------------------------
                            // Existing content.
                            // ----------------------------------------

                            if (storedFile) {

                                const storagePath =
                                    path.join(
                                        storageDir,
                                        storedFile.storage_key
                                    );


                                // The database says the file exists.
                                // If the physical file is missing, repair
                                // it from this upload.
                                if (!fs.existsSync(storagePath)) {

                                    fs.linkSync(
                                        file.path,
                                        storagePath
                                    );
                                }


                            } else {

                                // ------------------------------------
                                // New content.
                                // ------------------------------------

                                const storageKey = sha256;

                                const storagePath =
                                    path.join(
                                        storageDir,
                                        storageKey
                                    );


                                // Normally this path cannot already
                                // exist because the database transaction
                                // serialises all upload writers.
                                //
                                // If it does exist, it is an untracked
                                // physical file left by an earlier failed
                                // operation. Replace it with the verified
                                // temporary upload.
                                if (fs.existsSync(storagePath)) {

                                    fs.unlinkSync(storagePath);
                                }


                                // Create the canonical physical file.
                                //
                                // This is a hard link, not a file copy.
                                // It is therefore effectively an atomic
                                // creation of the content-store entry.
                                fs.linkSync(
                                    file.path,
                                    storagePath
                                );


                                newlyStoredPaths.push(
                                    storagePath
                                );


                                // Create its database identity.
                                insertStoredFile.run(
                                    sha256,
                                    file.size,
                                    storageKey,
                                    file.mimetype
                                );


                                storedFile =
                                    getStoredFile.get(sha256);
                            }


                            if (!storedFile) {
                                throw new Error(
                                    `Unable to create stored file record for ${sha256}`
                                );
                            }


                            // ----------------------------------------
                            // Connect the content to this workspace
                            // version.
                            // ----------------------------------------

                            insertVersionFile.run(
                                versionId,
                                storedFile.id,
                                item.filename,
                                item.relativePath || null
                            );
                        }


                        // --------------------------------------------
                        // Return the newly-created records.
                        // --------------------------------------------

                        const version =
                            db.prepare(`
                                SELECT
                                    id,
                                    workspace_asset_id,
                                    version_number,
                                    created_by,
                                    version_note,
                                    created_at
                                FROM workspace_versions
                                WHERE id = ?
                            `).get(versionId);


                        const files =
                            db.prepare(`
                                SELECT
                                    wvf.id,
                                    wvf.stored_file_id,
                                    wvf.filename,
                                    wvf.relative_path
                                FROM workspace_version_files wvf
                                WHERE wvf.workspace_version_id = ?
                                ORDER BY
                                    wvf.relative_path,
                                    wvf.filename
                            `).all(versionId);


                        return {
                            asset,
                            version,
                            files
                        };


                    } catch (err) {

                        // --------------------------------------------
                        // IMPORTANT:
                        //
                        // We are still inside the SQLite transaction
                        // here. No other upload transaction can have
                        // started using these content-store paths.
                        // --------------------------------------------

                        for (
                            const storagePath of
                            newlyStoredPaths
                        ) {

                            try {
                                fs.unlinkSync(storagePath);
                            } catch (cleanupError) {
                                console.error(
                                    'Failed to remove newly-created content file:',
                                    storagePath,
                                    cleanupError
                                );
                            }
                        }

                        throw err;
                    }
                });


            // ----------------------------------------------------
            // Start the transaction as an IMMEDIATE transaction.
            // ----------------------------------------------------

            const result =
                  createAssetVersion.immediate();

           for (const tempPath of tempPaths) {

                try {
                    await fs.promises.unlink(tempPath);
                } catch (err_) {
                    // Temporary file may already have been removed.
                    // This does not invalidate the successful upload.
                }
            }

            return res.status(201).json({
                status: 'created',
                ...result
            });


        } catch (err) {

            console.error(
                'Developer asset upload error:',
                err
            );


            // ----------------------------------------------------
            // Remove temporary files which were not moved.
            // ----------------------------------------------------

            for (const tempPath of tempPaths) {

                try {
                    await fs.promises.unlink(tempPath);
                } catch (err_) {
                    // Already deleted or moved.
                }
            }

            console.error(
                'Developer asset upload failed:',
                err.message
            );


            return res.status(400).json({
                error:
                    err.message ||
                    'Failed to process uploaded files'
            });
        }
    }
);





// ============================================================
// TECHNICAL VALIDATION
// ============================================================
//
// Runs automated technical checks against ONE workspace
// version.
//
// Technical validation is private to the developer.
//
// It does NOT:
//   - lock the version
//   - request Creative Approval
//   - publish anything
//
// The developer may run it repeatedly.
// ============================================================

router.post(
    '/assets/:assetId/versions/:versionId/technical-check',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {

        const developerId =
            req.user?.userId ?? req.user?.id;

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        const assetId =
            Number(req.params.assetId);

        const versionId =
            Number(req.params.versionId);

        if (
            !Number.isInteger(assetId) ||
            !Number.isInteger(versionId)
        ) {
            return res.status(400).json({
                error: 'Invalid asset or version ID'
            });
        }

        try {

            // ----------------------------------------------------
            // Find the developer's workspace
            // ----------------------------------------------------

            const workspace = db.prepare(`
                SELECT id
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);

            if (!workspace) {
                return res.status(404).json({
                    error: 'Developer workspace not found'
                });
            }


            // ----------------------------------------------------
            // Find the requested version and make sure it belongs
            // to this developer's workspace.
            // ----------------------------------------------------

            const version = db.prepare(`
                SELECT
                    wv.id,
                    wv.workspace_asset_id,
                    wv.version_number,
                    wv.version_note,
                    wv.created_by,
                    wv.created_at,
                    wv.creative_locked,
                    wa.name AS asset_name,
                    wa.workspace_id
                FROM workspace_versions wv
                JOIN workspace_assets wa
                    ON wa.id = wv.workspace_asset_id
                WHERE wv.id = ?
                  AND wv.workspace_asset_id = ?
                  AND wa.id = ?
                  AND wa.workspace_id = ?
                  AND wa.is_active = 1
            `).get(
                versionId,
                assetId,
                assetId,
                workspace.id
            );

            if (!version) {
                return res.status(404).json({
                    error: 'Workspace version not found'
                });
            }


            // ----------------------------------------------------
            // A locked version is immutable.
            //
            // There is no reason to run a new technical check
            // against an immutable accepted version.
            // ----------------------------------------------------

            if (version.creative_locked) {
                return res.status(409).json({
                    error:
                        'This workspace version is locked and cannot be validated again.'
                });
            }


            // ----------------------------------------------------
            // Create technical check run.
            // ----------------------------------------------------

            const runResult = db.prepare(`
                INSERT INTO technical_check_runs (
                    workspace_asset_id,
                    workspace_version_id,
                    started_by,
                    status
                )
                VALUES (?, ?, ?, 'running')
            `).run(
                assetId,
                versionId,
                developerId
            );

            const runId =
                runResult.lastInsertRowid;


            // ----------------------------------------------------
            // Technical checks
            //
            // These are deliberately basic for the first
            // implementation. The validation framework can be
            // expanded later with asset-specific validators.
            // ----------------------------------------------------

            const files = db.prepare(`
                SELECT
                    wvf.id,
                    wvf.filename,
                    wvf.relative_path,
                    wvf.stored_file_id,
                    sf.sha256,
                    sf.file_size,
                    sf.storage_key,
                    sf.mime_type
                FROM workspace_version_files wvf
                JOIN stored_files sf
                    ON sf.id = wvf.stored_file_id
                WHERE wvf.workspace_version_id = ?
                ORDER BY
                    COALESCE(wvf.relative_path, ''),
                    wvf.filename
            `).all(versionId);


            const results = [];


            // ----------------------------------------------------
            // Check: version contains files
            // ----------------------------------------------------

            if (files.length === 0) {

                results.push({
                    name: 'files_present',
                    status: 'failed',
                    message:
                        'The workspace version contains no files.'
                });

            } else {

                results.push({
                    name: 'files_present',
                    status: 'passed',
                    message:
                        `${files.length} file(s) found.`
                });
            }


            // ----------------------------------------------------
            // Check each stored file.
            // ----------------------------------------------------

            for (const file of files) {

                const storagePath =
                    path.join(
                        __dirname,
                        '../uploads/files',
                        file.storage_key
                    );


                let exists = false;

                try {

                    const stat =
                        await fs.promises.stat(
                            storagePath
                        );

                    exists =
                        stat.isFile() &&
                        stat.size === file.file_size;

                } catch (err) {

                    exists = false;
                }


                results.push({
                    name:
                        `stored_file:${file.id}`,

                    status:
                        exists
                            ? 'passed'
                            : 'failed',

                    message:
                        exists
                            ? `Physical file exists and size matches: ${file.filename}`
                            : `Physical file is missing or its size does not match: ${file.filename}`
                });
            }


            // ----------------------------------------------------
            // Check logical paths.
            // ----------------------------------------------------

            const logicalPaths =
                new Set();

            let duplicatePaths = false;


            for (const file of files) {

                const logicalPath =
                    file.relative_path
                        ? `${file.relative_path}/${file.filename}`
                        : file.filename;


                if (logicalPaths.has(logicalPath)) {
                    duplicatePaths = true;
                    break;
                }

                logicalPaths.add(logicalPath);
            }


            results.push({
                name: 'logical_paths_unique',

                status:
                    duplicatePaths
                        ? 'failed'
                        : 'passed',

                message:
                    duplicatePaths
                        ? 'Duplicate logical file paths detected.'
                        : 'All logical file paths are unique.'
            });


            // ----------------------------------------------------
            // Determine overall result.
            // ----------------------------------------------------

            const failed =
                results.some(
                    result =>
                        result.status === 'failed'
                );

            const finalStatus =
                failed
                    ? 'failed'
                    : 'passed';


            // ----------------------------------------------------
            // Store individual results.
            // ----------------------------------------------------

            const insertResult =
                db.prepare(`
                    INSERT INTO technical_check_results (
                        technical_check_run_id,
                        check_name,
                        status,
                        message
                    )
                    VALUES (?, ?, ?, ?)
                `);


            const storeResults =
                db.transaction(() => {

                    for (const result of results) {

                        insertResult.run(
                            runId,
                            result.name,
                            result.status,
                            result.message
                        );
                    }


                    db.prepare(`
                        UPDATE technical_check_runs
                        SET
                            status = ?,
                            completed_at = CURRENT_TIMESTAMP,
                            summary = ?
                        WHERE id = ?
                    `).run(
                        finalStatus,

                        failed
                            ? 'Technical validation failed.'
                            : 'Technical validation passed.',

                        runId
                    );
                });


            storeResults();


            const completedRun =
                db.prepare(`
                    SELECT
                        id,
                        workspace_asset_id,
                        workspace_version_id,
                        started_by,
                        status,
                        started_at,
                        completed_at,
                        summary
                    FROM technical_check_runs
                    WHERE id = ?
                `).get(runId);


            const checkResults =
                db.prepare(`
                    SELECT
                        id,
                        check_name,
                        status,
                        message,
                        details,
                        started_at,
                        completed_at
                    FROM technical_check_results
                    WHERE technical_check_run_id = ?
                    ORDER BY id
                `).all(runId);


            return res.json({
                status: finalStatus,
                run: completedRun,
                results: checkResults
            });


        } catch (err) {

            console.error(
                'Technical validation failed:',
                err
            );


            return res.status(500).json({
                error:
                    'Technical validation failed'
            });
        }
    }
);


// ============================================================
// REQUEST CREATIVE APPROVAL
// ============================================================
//
// The developer explicitly submits ONE workspace version.
//
// Requirements:
//
//   - version belongs to this developer
//   - version is not already locked
//   - technical validation has passed
//   - no existing pending approval
//
// The specific version is then locked.
//
// The workspace asset itself remains completely editable.
// ============================================================

router.post(
    '/assets/:assetId/versions/:versionId/creative-approval',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),

    async (req, res) => {

        const developerId =
            req.user?.userId ?? req.user?.id;

        if (!developerId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        const assetId =
            Number(req.params.assetId);

        const versionId =
            Number(req.params.versionId);

        if (
            !Number.isInteger(assetId) ||
            !Number.isInteger(versionId)
        ) {
            return res.status(400).json({
                error: 'Invalid asset or version ID'
            });
        }


        const requestComment =
            String(
                req.body?.request_comment || ''
            ).trim();


        try {

            const workspace = db.prepare(`
                SELECT id
                FROM developer_workspaces
                WHERE developer_id = ?
            `).get(developerId);

            if (!workspace) {
                return res.status(404).json({
                    error: 'Developer workspace not found'
                });
            }


            const version = db.prepare(`
                SELECT
                    wv.id,
                    wv.workspace_asset_id,
                    wv.version_number,
                    wv.creative_locked,
                    wa.name AS asset_name
                FROM workspace_versions wv
                JOIN workspace_assets wa
                    ON wa.id = wv.workspace_asset_id
                WHERE wv.id = ?
                  AND wv.workspace_asset_id = ?
                  AND wa.workspace_id = ?
                  AND wa.is_active = 1
            `).get(
                versionId,
                assetId,
                workspace.id
            );


            if (!version) {
                return res.status(404).json({
                    error: 'Workspace version not found'
                });
            }


            if (version.creative_locked) {
                return res.status(409).json({
                    error:
                        'This workspace version is already locked.'
                });
            }


            // ----------------------------------------------------
            // Require a successful technical validation for this
            // exact version.
            // ----------------------------------------------------

            const technicalPass =
                db.prepare(`
                    SELECT id
                    FROM technical_check_runs
                    WHERE workspace_version_id = ?
                      AND status = 'passed'
                    ORDER BY completed_at DESC, id DESC
                    LIMIT 1
                `).get(versionId);


            if (!technicalPass) {
                return res.status(409).json({
                    error:
                        'This version must pass Technical Validation before Creative Approval can be requested.'
                });
            }


            // ----------------------------------------------------
            // Make sure another approval is not already pending.
            // ----------------------------------------------------

            const pendingApproval =
                db.prepare(`
                    SELECT id
                    FROM creative_approvals
                    WHERE workspace_version_id = ?
                      AND status = 'pending'
                    LIMIT 1
                `).get(versionId);


            if (pendingApproval) {
                return res.status(409).json({
                    error:
                        'Creative Approval has already been requested for this version.'
                });
            }


            // ----------------------------------------------------
            // Lock this specific version and create approval
            // request atomically.
            // ----------------------------------------------------

            const submit =
                db.transaction(() => {

                    db.prepare(`
                        UPDATE workspace_versions
                        SET
                            creative_locked = 1,
                            locked_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(versionId);


                    const result =
                        db.prepare(`
                            INSERT INTO creative_approvals (
                                workspace_asset_id,
                                workspace_version_id,
                                requested_by,
                                status,
                                request_comment
                            )
                            VALUES (?, ?, ?, 'pending', ?)
                        `).run(
                            assetId,
                            versionId,
                            developerId,
                            requestComment || null
                        );


                    return result.lastInsertRowid;
                });


            const approval =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(submit);


            return res.status(201).json({
                status: 'pending',
                approval
            });


        } catch (err) {

            console.error(
                'Creative Approval request failed:',
                err
            );


            return res.status(500).json({
                error:
                    'Failed to request Creative Approval'
            });
        }
    }
);


// ============================================================
// REJECT CREATIVE APPROVAL
// ============================================================
//
// Director/admin/superuser rejects the specific submitted
// workspace version.
//
// That version becomes editable again.
//
// Other versions of the same workspace asset are unaffected.
// ============================================================

router.post(
    '/creative-approvals/:approvalId/reject',
    authenticateToken,
    requireRole('admin', 'superuser'),

    async (req, res) => {

        const approvalId =
            Number(req.params.approvalId);

        const decidedBy =
            req.user?.userId ?? req.user?.id;

        if (!decidedBy) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        if (!Number.isInteger(approvalId)) {
            return res.status(400).json({
                error: 'Invalid approval ID'
            });
        }


        const decisionComment =
            String(
                req.body?.decision_comment || ''
            ).trim();


        try {

            const approval =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(approvalId);


            if (!approval) {
                return res.status(404).json({
                    error: 'Creative Approval not found'
                });
            }


            if (approval.status !== 'pending') {
                return res.status(409).json({
                    error:
                        `Creative Approval is already ${approval.status}.`
                });
            }


            const reject =
                db.transaction(() => {

                    db.prepare(`
                        UPDATE creative_approvals
                        SET
                            status = 'rejected',
                            decided_by = ?,
                            decision_comment = ?,
                            decided_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        decidedBy,
                        decisionComment || null,
                        approvalId
                    );


                    db.prepare(`
                        UPDATE workspace_versions
                        SET
                            creative_locked = 0,
                            locked_at = NULL
                        WHERE id = ?
                    `).run(
                        approval.workspace_version_id
                    );
                });


            reject();


            const updated =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(approvalId);


            return res.json({
                status: 'rejected',
                approval: updated
            });


        } catch (err) {

            console.error(
                'Creative Approval rejection failed:',
                err
            );


            return res.status(500).json({
                error:
                    'Failed to reject Creative Approval'
            });
        }
    }
);


// ============================================================
// APPROVE CREATIVE APPROVAL
// ============================================================
//
// Director/admin/superuser approves ONE specific workspace
// version.
//
// This creates an immutable repository version.
//
// The workspace version remains locked.
//
// IMPORTANT:
// If the workspace asset is not already associated with a
// repository asset, this creates a NEW repository asset.
//
// If a repository asset already exists with the same name but
// there is no explicit association, approval is rejected rather
// than accidentally attaching the work to the wrong asset.
//
// Collision handling will be added separately.
// ============================================================

router.post(
    '/creative-approvals/:approvalId/approve',
    authenticateToken,
    requireRole('admin', 'superuser'),

    async (req, res) => {

        const approvalId =
            Number(req.params.approvalId);

        const decidedBy =
            req.user?.userId ?? req.user?.id;

        if (!decidedBy) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        if (!Number.isInteger(approvalId)) {
            return res.status(400).json({
                error: 'Invalid approval ID'
            });
        }


        const decisionComment =
            String(
                req.body?.decision_comment || ''
            ).trim();


        try {

            const approval =
                db.prepare(`
                    SELECT
                        ca.*,

                        wa.name AS workspace_asset_name,
                        wa.asset_type AS workspace_asset_type,
                        wa.description AS workspace_asset_description,

                        wv.version_number,
                        wv.version_note,
                        wv.creative_locked,
                        wv.repository_version_id

                    FROM creative_approvals ca

                    JOIN workspace_assets wa
                        ON wa.id = ca.workspace_asset_id

                    JOIN workspace_versions wv
                        ON wv.id = ca.workspace_version_id

                    WHERE ca.id = ?
                `).get(approvalId);


            if (!approval) {
                return res.status(404).json({
                    error: 'Creative Approval not found'
                });
            }


            if (approval.status !== 'pending') {
                return res.status(409).json({
                    error:
                        `Creative Approval is already ${approval.status}.`
                });
            }


            if (!approval.creative_locked) {
                return res.status(409).json({
                    error:
                        'The submitted workspace version is not locked.'
                });
            }


            const result =
                db.transaction(() => {

                    let repositoryAsset = null;


                    // ------------------------------------------------
                    // If this workspace asset was explicitly derived
                    // from an existing repository asset, use it.
                    // ------------------------------------------------

                    const workspaceAsset =
                        db.prepare(`
                            SELECT
                                repository_asset_id
                            FROM workspace_assets
                            WHERE id = ?
                        `).get(
                            approval.workspace_asset_id
                        );


                    if (
                        workspaceAsset?.repository_asset_id
                    ) {

                        repositoryAsset =
                            db.prepare(`
                                SELECT *
                                FROM assets
                                WHERE id = ?
                                  AND is_active = 1
                            `).get(
                                workspaceAsset.repository_asset_id
                            );


                        if (!repositoryAsset) {
                            throw new Error(
                                'The repository asset associated with this workspace asset no longer exists.'
                            );
                        }

                    } else {

                        // --------------------------------------------
                        // This is a new repository asset.
                        //
                        // Do NOT silently attach it to an existing
                        // asset merely because the names match.
                        // --------------------------------------------

                        const sameName =
                            db.prepare(`
                                SELECT id
                                FROM assets
                                WHERE name = ?
                            `).get(
                                approval.workspace_asset_name
                            );


                        if (sameName) {
                            throw new Error(
                                'A repository asset with this name already exists, but this workspace asset is not associated with it.'
                            );
                        }


                        const assetResult =
                            db.prepare(`
                                INSERT INTO assets (
                                    name,
                                    asset_type,
                                    owner_id,
                                    description
                                )
                                VALUES (?, ?, ?, ?)
                            `).run(
                                approval.workspace_asset_name,
                                approval.workspace_asset_type || null,
                                decidedBy,
                                approval.workspace_asset_description || null
                            );


                        repositoryAsset =
                            db.prepare(`
                                SELECT *
                                FROM assets
                                WHERE id = ?
                            `).get(
                                assetResult.lastInsertRowid
                            );


                        // --------------------------------------------
                        // Record the permanent ancestry.
                        // --------------------------------------------

                        db.prepare(`
                            UPDATE workspace_assets
                            SET
                                repository_asset_id = ?
                            WHERE id = ?
                        `).run(
                            repositoryAsset.id,
                            approval.workspace_asset_id
                        );
                    }


                    // ------------------------------------------------
                    // Find next repository version.
                    // ------------------------------------------------

                    const latestRepositoryVersion =
                        db.prepare(`
                            SELECT
                                MAX(version_number)
                                    AS version_number
                            FROM asset_versions
                            WHERE asset_id = ?
                        `).get(
                            repositoryAsset.id
                        );


                    const repositoryVersionNumber =
                        (
                            latestRepositoryVersion?.version_number ||
                            0
                        ) + 1;


                    // ------------------------------------------------
                    // Create immutable repository version.
                    // ------------------------------------------------

                    const repositoryVersionResult =
                        db.prepare(`
                            INSERT INTO asset_versions (
                                asset_id,
                                version_number,
                                created_by,
                                version_note
                            )
                            VALUES (?, ?, ?, ?)
                        `).run(
                            repositoryAsset.id,
                            repositoryVersionNumber,
                            decidedBy,
                            approval.version_note
                        );


                    const repositoryVersionId =
                        repositoryVersionResult.lastInsertRowid;


                    // ------------------------------------------------
                    // Copy the logical file references.
                    //
                    // The physical stored_files records are NOT
                    // copied. They are shared by content hash.
                    // ------------------------------------------------

                    db.prepare(`
                        INSERT INTO asset_version_files (
                            asset_version_id,
                            stored_file_id,
                            filename,
                            relative_path
                        )
                        SELECT
                            ?,
                            stored_file_id,
                            filename,
                            relative_path
                        FROM workspace_version_files
                        WHERE workspace_version_id = ?
                    `).run(
                        repositoryVersionId,
                        approval.workspace_version_id
                    );


                    // ------------------------------------------------
                    // Link the workspace version permanently to the
                    // repository version.
                    // ------------------------------------------------

                    db.prepare(`
                        UPDATE workspace_versions
                        SET
                            repository_version_id = ?,
                            creative_locked = 1,
                            locked_at = COALESCE(
                                locked_at,
                                CURRENT_TIMESTAMP
                            )
                        WHERE id = ?
                    `).run(
                        repositoryVersionId,
                        approval.workspace_version_id
                    );


                    // ------------------------------------------------
                    // Complete Creative Approval.
                    // ------------------------------------------------

                    db.prepare(`
                        UPDATE creative_approvals
                        SET
                            status = 'approved',
                            decided_by = ?,
                            decision_comment = ?,
                            decided_at = CURRENT_TIMESTAMP,
                            repository_asset_id = ?,
                            repository_version_id = ?
                        WHERE id = ?
                    `).run(
                        decidedBy,
                        decisionComment || null,
                        repositoryAsset.id,
                        repositoryVersionId,
                        approvalId
                    );


                    return {
                        repositoryAsset,
                        repositoryVersionId,
                        repositoryVersionNumber
                    };
                })();


            const updatedApproval =
                db.prepare(`
                    SELECT *
                    FROM creative_approvals
                    WHERE id = ?
                `).get(approvalId);


            return res.json({
                status: 'approved',

                approval:
                    updatedApproval,

                repository: {
                    asset:
                        result.repositoryAsset,

                    version_id:
                        result.repositoryVersionId,

                    version_number:
                        result.repositoryVersionNumber
                }
            });


        } catch (err) {

            console.error(
                'Creative Approval approval failed:',
                err
            );


            return res.status(409).json({
                error:
                    err.message ||
                    'Failed to approve Creative Approval'
            });
        }
    }
);







module.exports = router;
