// shared/manifest.mjs
//
// A VERSION'S CONTENT IDENTITY — the manifest, canonicalised.
//
// ============================================================
// WHAT IT IS FOR, AND WHY IT IS HERE
// ============================================================
//
// docs/SPEC.md §4: the components of a version are its file set, and hashing
// that set produces one value that says WHICH CONTENT THIS IS. Three separate
// requirements need exactly that value:
//
//   * "did this upload change anything?"  — the rule in §4: identical paths and
//     hashes mean no new version, and the popup says so.
//   * a version's content identity — two versions holding the same files have
//     the same hash, which is true and expected (an insisted description change
//     makes a version without changing a byte). It identifies CONTENT, not the
//     version number, and must never be UNIQUE.
//   * "the version I tested is the version I submitted" — a test receipt can
//     name this value and nothing else can move under it.
//
// IT LIVES IN shared/ BECAUSE THE RULE MUST BE ONE RULE. The backend hashes it;
// a client that wants to ask "is this the same version?" needs the same
// canonical form. Two implementations would eventually disagree, and the
// disagreement would be silent — which is the failure this whole directory
// exists to prevent.
//
// ============================================================
// NO CRYPTO HERE, DELIBERATELY
// ============================================================
//
// This file produces the STRING that gets hashed, not the hash. Hashing needs
// `crypto`, which the browser reaches differently from Node — so the one line
// that differs between them lives in backend/lib/manifestHash.js, and the part
// that must never differ is here.
//
// ============================================================
// WHY JSON, WHEN THE SPEC SAYS "filename + SHA256 + size"
// ============================================================
//
// The spec's example is a concatenation, and a concatenation is ambiguous: a
// filename may contain any character, including whichever separator was chosen
// and including a newline. TWO DIFFERENT FILE SETS COULD PRODUCE THE SAME
// STRING, which for a content identity is the one property that must not fail.
//
// JSON escapes filenames and gives a deterministic form for an array of
// objects, so the same file set always produces the same bytes and cannot
// collide with a different one by construction. The fields are the spec's —
// path, SHA-256, size — in that order.

// ---------------------------------------------------------------------------
// The canonical path
// ---------------------------------------------------------------------------

/**
 * Where a component sits, as one string: `relative_path/filename`.
 *
 * DIVIDED BY FORWARD SLASHES AND NOTHING ELSE. Windows sends backslashes, and
 * a version uploaded from Windows and one uploaded from Linux must hash the
 * same if they hold the same tree — otherwise "the same file set" means two
 * different things depending on who uploaded it.
 *
 * The container folder is NOT stripped here. It is part of the version's
 * relative_path, it is what a download reproduces, and it is the same on both
 * sides of any comparison. Stripping it is the caller's decision, made once in
 * one place (backend/routes/game.js does it for archives).
 */
export function canonicalPath(relativePath, filename) {
    return [relativePath, filename]
        .filter(part => part !== null && part !== undefined && String(part) !== '')
        .map(part => String(part).replace(/\\/g, '/'))
        .join('/')
        .replace(/\/{2,}/g, '/')
        .replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------

/**
 * The components of a version, in canonical order.
 *
 * @param {Array} files  { relative_path, filename, sha256, size }
 * @returns {Array<{path, sha256, size}>}
 *
 * SORTED BY PATH, BYTE-WISE. Not `localeCompare` — that sorts differently under
 * different locales, and a value that depends on the machine's language is not
 * a content identity. `<` and `>` on two strings compare UTF-16 code units,
 * which is the same everywhere.
 *
 * THE SORT IS ALSO WHY DUPLICATE PATHS MATTER. Two components at one path would
 * make the order depend on the sort implementation's stability rather than on
 * the data; the schema forbids it (UNIQUE on version, relative_path, filename),
 * so this assumes what the database already guarantees.
 */
export function manifestEntries(files) {
    return (files || [])
        .map(file => ({
            path: canonicalPath(file.relative_path, file.filename),
            sha256: String(file.sha256 || '').toLowerCase(),
            size: Number(file.size ?? file.file_size ?? 0)
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The bytes that are hashed, as a string.
 *
 * The canonical form, and the only thing backend/lib/manifestHash.js feeds to
 * the hash function.
 */
export function manifestCanonical(files) {
    return JSON.stringify(manifestEntries(files));
}
