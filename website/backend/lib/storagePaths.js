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
// THE THREE DIRECTORIES, AND WHY THEY ARE NOT ONE
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
//   THUMB_DIR — DERIVED content, and NOT the store. Library thumbnails, named
//     by the SHA-256 of the blob they were made from, so they are deterministic
//     and deduplicate by construction. A THUMBNAIL IS NOT AN AUTHORED FILE: it
//     is produced FROM one, the way a build is produced from a project, which is
//     why it does not get a stored_files row and is not counted, collected or
//     verified as store content. It is a CACHE — deleting every file in here
//     costs regeneration, not data.
//
// They are deliberately separate for that last reason. A sweep that clears
// orphans in BLOB_DIR must not touch a half-written upload OR a thumbnail, and
// neither a half-written upload nor a thumbnail may be mistaken for a stored
// blob.

const path = require('path');

// backend/lib/ -> backend/uploads/
const UPLOADS_DIR = path.join(__dirname, '../uploads');

const BLOB_DIR = path.join(UPLOADS_DIR, 'files');
const TMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const THUMB_DIR = path.join(UPLOADS_DIR, 'thumbs');

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

// The kinds of thumbnail a library item may have. Duplicated from the CHECK on
// library_thumbnails.kind, deliberately and with the same reasoning as the key
// regex above: the value becomes part of a FILENAME, so it is validated where
// the filename is built rather than trusted because a column accepted it.
const THUMB_KINDS = new Set(['image', 'video_frame', 'model_preview']);

/**
 * The absolute path of a thumbnail, or null if the key is not a plain SHA-256 or
 * the kind is not one we make.
 *
 * THE KIND IS IN THE FILENAME, not only in the row. One blob can have more than
 * one thumbnail — a still and, later, a poster frame or a turntable — so keying
 * the file by the source hash ALONE would have the second kind silently overwrite
 * the first. `<sha>_<kind>.webp` cannot collide.
 *
 * Same contract as blobPath() and for the same reason: the key arrives from the
 * database and the path is built from it, so the validation and the join are one
 * call and no caller can build a path from an unvalidated string.
 */
function thumbPath(storageKey, kind) {
    if (!isStorageKey(storageKey)) return null;
    if (!THUMB_KINDS.has(String(kind))) return null;

    return path.join(THUMB_DIR, `${storageKey}_${kind}.webp`);
}

module.exports = {
    UPLOADS_DIR,
    BLOB_DIR,
    TMP_DIR,
    THUMB_DIR,
    THUMB_KINDS,
    isStorageKey,
    blobPath,
    thumbPath
};
