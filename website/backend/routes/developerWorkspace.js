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
// TEST UPLOAD ENDPOINT
// ============================================================
//
// This deliberately does NOT create:
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
//   stored_files lookup
//      ↓
//   reuse existing file OR store new physical file
//
// ============================================================

router.post(
    '/upload',
    authenticateToken,
    requireRole('developer', 'admin', 'superuser'),
    upload.single('file'),
    async (req, res) => {

        if (!req.file) {
            return res.status(400).json({
                error: 'No file uploaded'
            });
        }

        const tempPath = req.file.path;

        try {

            // ----------------------------------------------------
            // Calculate SHA-256
            // ----------------------------------------------------

            const hash = crypto.createHash('sha256');

            const fileBuffer = await fs.promises.readFile(tempPath);

            hash.update(fileBuffer);

            const sha256 = hash.digest('hex');


            // ----------------------------------------------------
            // Check whether this physical file already exists
            // ----------------------------------------------------

            const existingFile = db.prepare(`
                SELECT
                    id,
                    sha256,
                    original_filename,
                    mime_type,
                    size_bytes,
                    storage_path,
                    created_at
                FROM stored_files
                WHERE sha256 = ?
            `).get(sha256);


            // ----------------------------------------------------
            // File already exists
            // ----------------------------------------------------

            if (existingFile) {

                await fs.promises.unlink(tempPath);

                return res.json({
                    status: 'existing',
                    file: existingFile
                });
            }


            // ----------------------------------------------------
            // New physical file
            // ----------------------------------------------------

            const storageDir = path.join(__dirname, '../uploads/files');

            await fs.promises.mkdir(storageDir, {
                recursive: true
            });


            // Use the SHA-256 as the physical filename.
            //
            // This guarantees that identical content maps to
            // the same physical filename.
            //

            const storageFilename = sha256;

            const storagePath = path.join(
                storageDir,
                storageFilename
            );


            await fs.promises.rename(
                tempPath,
                storagePath
            );


            // ----------------------------------------------------
            // Record the physical file in stored_files
            // ----------------------------------------------------

            const result = db.prepare(`
                INSERT INTO stored_files (
                    sha256,
                    original_filename,
                    mime_type,
                    size_bytes,
                    storage_path
                )
                VALUES (?, ?, ?, ?, ?)
            `).run(
                sha256,
                req.file.originalname,
                req.file.mimetype,
                req.file.size,
                storagePath
            );


            // ----------------------------------------------------
            // Return result
            // ----------------------------------------------------

            const storedFile = db.prepare(`
                SELECT
                    id,
                    sha256,
                    original_filename,
                    mime_type,
                    size_bytes,
                    storage_path,
                    created_at
                FROM stored_files
                WHERE id = ?
            `).get(result.lastInsertRowid);


            return res.json({
                status: 'new',
                file: storedFile
            });

        } catch (err) {

            console.error('Developer asset upload error:', err);


            // ----------------------------------------------------
            // Clean up temporary file if it still exists
            // ----------------------------------------------------

            try {
                await fs.promises.unlink(tempPath);
            } catch (_) {
                // File may already have been moved/deleted.
            }


            return res.status(500).json({
                error: 'Failed to process uploaded file'
            });
        }
    }
);





module.exports = router;
