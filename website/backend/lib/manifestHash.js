// backend/lib/manifestHash.js
//
// A VERSION'S CONTENT IDENTITY, as a hex SHA-256.
//
// ============================================================
// THE ONLY LINE THAT IS NODE-ONLY
// ============================================================
//
// The canonical form — the part that must be identical everywhere — lives in
// shared/manifest.mjs, with no crypto in it, because a browser reaches hashing
// differently from Node. This file is the difference: one `createHash` call
// around a string the browser could compute too.
//
// ============================================================
// WHAT THE VALUE MEANS, AND WHAT IT DOES NOT
// ============================================================
//
// IT IDENTIFIES THE CONTENT OF A VERSION: the same files at the same paths,
// with the same bytes, produce the same value — and any change to a path, a
// name, a byte or a file's presence produces a different one.
//
// IT IS NOT UNIQUE PER VERSION. An insisted description change creates a new
// version without changing a byte (docs/SPEC.md §4), so two versions may carry
// the same hash — and must be allowed to. Do not put a UNIQUE constraint on it
// and do not use it as a version identifier; the version number is that.
//
// WHERE IT IS USED:
//   * stored on workspace_versions and asset_versions when a version is
//     created, so a version carries its own identity;
//   * returned by the manifest endpoint and written into the archive manifest,
//     so a receiver can check what arrived;
//   * the comparison that decides whether an upload made a new version
//     (docs/SPEC.md §4) — not built yet, and this is the value it will use.

const { createHash } = require('crypto');

const { manifestCanonical } = require('../../shared/manifest.mjs');

/**
 * The manifest hash of a version's components.
 *
 * @param {Array} files  { relative_path, filename, sha256, size }
 * @returns {string} 64 lowercase hex characters
 */
function manifestHash(files) {
    return createHash('sha256')
        .update(manifestCanonical(files), 'utf8')
        .digest('hex');
}

module.exports = { manifestHash };
