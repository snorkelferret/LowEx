// backend/lib/ingestFiles.js
//
// GETTING A FILE INTO THE CONTENT-ADDRESSED STORE.
//
// ============================================================
// WHY THIS IS A LIBRARY AND NOT TWO COPIES OF THE SAME CODE
// ============================================================
//
// There are now two places a file can be uploaded from — a developer's workspace
// and the library — and there must be ONE set of steps that puts bytes in the
// store. The TODO already states the rule, while discussing archives: "UNZIP IS
// A FEEDER, NOT A SECOND UPLOAD PATH … A second path is how two upload pipelines
// end up disagreeing about what is acceptable."
//
// That disagreement is not hypothetical and it is not a style question. The
// steps below are where the one-copy rule is ENFORCED — a lookup by SHA before
// anything is written — and a second implementation that forgot the lookup would
// store a duplicate, or one that forgot the validation would build a path from
// an unvalidated string. The whole design rests on there being exactly one of
// this, so there is exactly one of this.
//
// ============================================================
// WHAT A CALLER MUST ALREADY HAVE DONE
// ============================================================
//
// The bytes must already be on disk in TMP_DIR — multer puts them there. The
// hash is computed here by streaming, so a caller does not need to have hashed
// the file itself, and cannot disagree with this module about what a file is.
//
// THE CALLER OWNS THE TRANSACTION. storeOne() writes rows; it does not open or
// commit anything. Both callers run inside one, and both need the same thing
// from it: the list of blobs THIS operation created, so a rollback can remove
// them. That is what the return value is for.

const fs = require('fs');
const crypto = require('crypto');

const db = require('../db');
const { blobPath } = require('./storagePaths');

// ============================================================
// THE HASH
// ============================================================

/**
 * The SHA-256 of a file, streamed, as lowercase hex.
 *
 * Streamed rather than read into memory because uploads are files a person
 * chose, and a 4K texture is not a string. The value returned is what the file
 * IS: it becomes the stored_files row's identity, the storage_key, and the
 * filename on disk, all three the same string.
 */
function sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

// ============================================================
// THE STORE WRITE
// ============================================================

const getStoredFile = db.prepare(`
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

const insertStoredFile = db.prepare(`
    INSERT INTO stored_files (
        sha256,
        file_size,
        storage_key,
        mime_type
    )
    VALUES (?, ?, ?, ?)
`);

/**
 * Put one file's bytes in the store, or find that they are already there.
 *
 * Returns { storedFile, createdBlobPath }. createdBlobPath is non-null ONLY when
 * this call created a new blob, and is what a caller's rollback should remove.
 *
 * ------------------------------------------------------------------
 * THE EXISTING-CONTENT BRANCH WRITES NO BYTES, ALMOST
 * ------------------------------------------------------------------
 *
 * When the SHA is already known, the row is reused and nothing is inserted —
 * that is the one-copy rule, and it is why re-submitting known content adds a
 * REFERENCE and no storage. The one write it can make is a REPAIR: if the
 * database says a blob exists and the file is not on disk, the upload is used to
 * put it back.
 *
 * A REPAIR IS DELIBERATELY NOT REPORTED AS CREATED. It restored a file that was
 * supposed to be there, so rolling it back would undo a correct thing and leave
 * the store in the state the repair was fixing. That is why the return value
 * distinguishes the two rather than reporting every path it touched.
 */
function storeOne({ sha256, tempPath, size, mimeType }) {
    let storedFile = getStoredFile.get(sha256);
    let createdBlobPath = null;

    if (storedFile) {

        // blobPath() refuses a key that is not a plain SHA-256, so a null here
        // means the ROW is corrupt rather than the caller. Throwing rolls the
        // caller's transaction back, which is the right outcome for a store that
        // cannot be trusted.
        const storagePath = blobPath(storedFile.storage_key);

        if (!storagePath) {
            throw new Error(
                `stored_files #${storedFile.id} has a malformed storage_key`
            );
        }

        if (!fs.existsSync(storagePath)) {
            fs.linkSync(tempPath, storagePath);
        }

        return { storedFile, createdBlobPath };

    }

    // ------------------------------------------------------------------
    // New content.
    // ------------------------------------------------------------------

    const storageKey = sha256;

    // storageKey is the hash this module just computed from the bytes, so it is
    // always a valid key; blobPath still builds it, so there is one way to make
    // a store path.
    const storagePath = blobPath(storageKey);

    if (!storagePath) {
        throw new Error(
            `refusing to store content under a malformed key: ${storageKey}`
        );
    }

    // Normally this cannot already exist, because the caller's transaction
    // serialises all upload writers. If it does, it is an untracked physical
    // file left by an earlier failed operation, and it is replaced with the
    // verified temporary upload.
    if (fs.existsSync(storagePath)) {
        fs.unlinkSync(storagePath);
    }

    // A HARD LINK, NOT A COPY. It is therefore effectively an atomic creation of
    // the content-store entry, and the temporary file stays on disk afterwards —
    // which is why every caller must still clean TMP_DIR up itself.
    fs.linkSync(tempPath, storagePath);

    createdBlobPath = storagePath;

    insertStoredFile.run(
        sha256,
        size,
        storageKey,
        mimeType
    );

    storedFile = getStoredFile.get(sha256);

    if (!storedFile) {
        throw new Error(
            `Unable to create stored file record for ${sha256}`
        );
    }

    return { storedFile, createdBlobPath };
}

module.exports = { sha256OfFile, storeOne };
