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

const upload = multer({
    dest: tempUploadDir
});





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
  (req, res) => {

    // This comes from the JWT created by your login system.
    const developerId = req.user?.userId;

    if (!developerId) {
      return res.status(401).json({
        error: 'Invalid authentication context'
      });
    }

    try {

      // --------------------------------------------------------
      // Find the developer's private workspace
      // --------------------------------------------------------

      let workspace = db.prepare(`
        SELECT
          id,
          developer_id,
          created_at,
          updated_at
        FROM developer_workspaces
        WHERE developer_id = ?
      `).get(developerId);


      // --------------------------------------------------------
      // A developer must have one and only one workspace.
      // Create it automatically if it doesn't exist.
      // --------------------------------------------------------

      if (!workspace) {

        const result = db.prepare(`
          INSERT INTO developer_workspaces (developer_id)
          VALUES (?)
        `).run(developerId);

        workspace = db.prepare(`
          SELECT
            id,
            developer_id,
            created_at,
            updated_at
          FROM developer_workspaces
          WHERE id = ?
        `).get(result.lastInsertRowid);
      }


      // --------------------------------------------------------
      // Get the assets belonging to this workspace
      // --------------------------------------------------------

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
	
	console.log('Developer workspace:', workspace);
	console.log('Developer assets:', assets);




	
      // --------------------------------------------------------
      // Return workspace + assets
      // --------------------------------------------------------

      res.json({
        workspace,
        assets
      });

    } catch (err) {

      console.error('Developer assets lookup error:', err);

      res.status(500).json({
        error: 'Failed to retrieve developer assets'
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
        const newlyStoredPaths = [];


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

            for (const item of processedFiles) {

                const file = item.file;


                const fileBuffer =
                    await fs.promises.readFile(
                        file.path
                    );


                const sha256 =
                    crypto
                        .createHash('sha256')
                        .update(fileBuffer)
                        .digest('hex');


                // ------------------------------------------------
                // Look for identical existing physical file.
                // ------------------------------------------------

                let storedFile = db.prepare(`
                    SELECT
                        id,
                        sha256,
                        file_size,
                        storage_key,
                        mime_type,
                        created_at
                    FROM stored_files
                    WHERE sha256 = ?
                `).get(sha256);


                if (!storedFile) {

                    const storageDir =
                        path.join(
                            __dirname,
                            '../uploads/files'
                        );


                    await fs.promises.mkdir(
                        storageDir,
                        { recursive: true }
                    );


                    const storageKey = sha256;

                    const storagePath =
                        path.join(
                            storageDir,
                            storageKey
                        );


                    await fs.promises.rename(
                        file.path,
                        storagePath
                    );


                    newlyStoredPaths.push(
                        storagePath
                    );


                    item.newStoredFile = {
                        sha256,
                        fileSize: file.size,
                        storageKey,
                        mimeType: file.mimetype
                    };

                } else {

                    // No longer needed because the existing
                    // physical file will be reused.

                    await fs.promises.unlink(
                        file.path
                    );
                }


                item.storedFile = storedFile;
            }


            // ----------------------------------------------------
            // Everything below is one SQLite transaction.
            // ----------------------------------------------------

            const createAssetVersion =
                db.transaction(() => {


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
                        //
                        // Empty description/type does not erase
                        // existing metadata.
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
                    // Find next version number.
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
                    // Store/retrieve stored_files records and
                    // connect them to the workspace version.
                    // --------------------------------------------

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


                    for (const item of processedFiles) {

                        let storedFile =
                            item.storedFile;


                        // ----------------------------------------
                        // New physical file needs a stored_files
                        // database record.
                        // ----------------------------------------

                        if (
                            !storedFile &&
                            item.newStoredFile
                        ) {

                            const newFile =
                                item.newStoredFile;


                            const result =
                                insertStoredFile.run(
                                    newFile.sha256,
                                    newFile.fileSize,
                                    newFile.storageKey,
                                    newFile.mimeType
                                );


                            storedFile =
                                getStoredFile.get(
                                    newFile.sha256
                                );
                        }


                        if (!storedFile) {
                            throw new Error(
                                'Unable to create stored file record'
                            );
                        }


                        // ----------------------------------------
                        // Connect it to this workspace version.
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
                });


            // ----------------------------------------------------
            // Commit the complete database operation.
            // ----------------------------------------------------

            const result =
                createAssetVersion();


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


            // ----------------------------------------------------
            // If the transaction failed, remove only physical
            // files that THIS request newly created.
            //
            // Existing deduplicated files are never touched.
            // ----------------------------------------------------

            for (const storagePath of newlyStoredPaths) {

                try {
                    await fs.promises.unlink(
                        storagePath
                    );
                } catch (err_) {
                    // Already removed.
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

module.exports = router;
