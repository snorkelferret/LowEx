// backend/lib/storagePaths.js
//
// WHERE THE BYTES LIVE. One definition, because five copies of this string
// existed and they agreed only by coincidence.
//
// ============================================================
// WHY THIS IS NOT A TRIVIAL CONSTANT
// ============================================================
//
// '<something>/uploads/files' is a RELATIVE path joined onto __dirname, so what
// it means depends on how deep the file writing it sits. The five copies were
// in backend/routes/, backend/jobs/, backend/reset/ and backend/lib/ — all
// exactly two levels under backend/, so all five happened to resolve to the
// same directory and nothing looked wrong.
//
// IT HAS ALREADY BEEN WRONG ONCE. resetAssetData.js carries the scar: it used
// '../../uploads/files', which resolves to <repo>/uploads/files — a directory
// that does not exist. So it deleted every stored_files row, found no files to
// delete, reported "nothing to delete", and left the physical blobs on disk
// with nothing referencing them. A path that is right by luck is wrong the
// moment somebody moves the file that contains it.
//
// Requiring this module cannot be got wrong that way: an absolute path is
// resolved once, here, from THIS file's own location.
//
// ============================================================
// THE TWO DIRECTORIES, AND WHY THEY ARE NOT ONE
// ============================================================
//
//   BLOB_DIR — the permanent store. FLAT: one file per SHA-256, named for the
//     SHA, and storage_key === sha256 for every row in stored_files. Nothing is
//     ever organised into subdirectories here, which is what makes the layout
//     derivable from a hash and the whole store verifiable by re-hashing.
//
//   TMP_DIR — scratch space for uploads in flight. A file is written here
//     first, hashed by streaming it, and only then moved into BLOB_DIR (or
//     discarded). It is NOT part of the store: nothing in it is referenced by
//     any table, it is safe to empty at any time, and it must never be counted
//     as stored content.
//
// They are deliberately separate for that last reason. A sweep that clears
// orphans in BLOB_DIR must not touch a half-written upload, and an upload being
// hashed must not be mistaken for a stored blob.

const path = require('path');

// backend/lib/ -> backend/uploads/
const UPLOADS_DIR = path.join(__dirname, '../uploads');

const BLOB_DIR = path.join(UPLOADS_DIR, 'files');
const TMP_DIR = path.join(UPLOADS_DIR, 'tmp');

// ============================================================
// THE KEY FORMAT, AND WHY IT IS CHECKED HERE
// ============================================================
//
// storage_key IS the sha256, and the path is built from it — so the format of
// the column is what makes the path safe. This regex was written out twice
// (storeIntegrity.js and the download route) and the join was done in three
// places, only two of which checked first. That is the arrangement where the
// one that forgets is the one that matters, and the caller that matters most is
// the collector, which UNLINKS the result.
//
// So the check and the join are one call. A caller cannot build a blob path
// without the key having been validated, because blobPath() will not do it.
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isStorageKey(value) {
    return SHA256_HEX.test(String(value));
}

/**
 * The absolute path of a blob, or null if the key is not a plain SHA-256.
 *
 * NULL RATHER THAN A THROW. Every caller already has to handle "no such blob" —
 * a missing file is a state this system expects and reports — so a malformed
 * key arrives as the same kind of nothing rather than as an exception nobody
 * catches. What it must never do is return a path built from an unvalidated
 * string: '../../etc/passwd' is 15 bytes of perfectly ordinary text and joins
 * just fine.
 */
function blobPath(storageKey) {
    if (!isStorageKey(storageKey)) return null;

    return path.join(BLOB_DIR, String(storageKey));
}

module.exports = {
    UPLOADS_DIR,
    BLOB_DIR,
    TMP_DIR,
    isStorageKey,
    blobPath
};
