// frontend/src/downloadPlan.mjs
//
// WHAT A DOWNLOAD WOULD DO — decided before anything is fetched, written, or
// even asked for.
//
// ============================================================
// WHY THIS IS ITS OWN FILE, AGAIN
// ============================================================
//
// Same reason as libraryFilter.mjs: this is the part that looks obvious and is
// not, and the part whose failure is SILENT. Get it wrong in the direction of
// "already have it" and a developer's file is never written and nothing says so.
// Get it wrong the other way and a hundred megabytes cross the wire for nothing.
//
// SO IT IS PURE, AND THEREFORE TESTABLE BY CALLING IT. No browser, no picker,
// no network — a manifest and a list of what is on disk in, a plan out.
//
// ============================================================
// AND WHY .mjs, ALONE AMONG THE FRONTEND'S FILES
// ============================================================
//
// package.json says "type": "commonjs", so a .js file containing `export` is
// CommonJS to node. The other frontend modules are only ever loaded by vite,
// which does not care. This one has no imports, so NODE CAN LOAD IT — which is
// what makes the tests below possible at all.
//
// ============================================================
// THE COMPARISON IS BY HASH, AND THE SIZE IS ONLY A FILTER
// ============================================================
//
// A file whose SIZE differs is definitely not the one we want, and no hashing is
// needed to know that. A file whose size MATCHES might still differ, and the only
// way to know is to hash it.
//
// SO SIZE IS CHECKED FIRST AND THE HASH DECIDES. Which matters because hashing a
// large tree is slow — a developer's project can be gigabytes — and the great
// majority of files in it are usually unchanged.
//
// THE CALLER HASHES, because hashing needs to read the file and only the caller
// can do that. This takes the hashes as it finds them, and treats a file whose
// hash is unknown as one whose size agreed and nothing more.

/**
 * @typedef {Object} ManifestFile
 * @property {string} path       where the file goes, relative to the target
 * @property {string} sha256     its content, which is what decides everything
 * @property {number} size       bytes
 */

/**
 * @typedef {Object} LocalFile
 * @property {number} size            bytes on disk
 * @property {string|null} sha256     if the caller hashed it, and null if not
 */

// ---------------------------------------------------------------------------

/**
 * Names the archive carries that a developer may want to change.
 *
 * THE LEADING SEGMENT IS THE FOLDER THE FILES WERE UPLOADED IN. Item 54 calls it
 * transport and says it is never retained; the code retains it (item 81), so a
 * download writes `TestUpload/...` and this is where a developer says "call it
 * something else". Only the FIRST segment moves — the rest is the tree, and the
 * tree is load-bearing.
 */
export function rootFolderOf(paths) {
    const firsts = new Set();

    for (const p of paths) {
        const segments = String(p).split('/').filter(Boolean);
        if (segments.length > 1) firsts.add(segments[0]);
    }

    // Only when EVERY path shares one root is there a root to rename. A version
    // whose files sit at the top level has none.
    return firsts.size === 1 ? [...firsts][0] : null;
}

/**
 * The same path, under a different root folder.
 *
 * Returns the path unchanged when there is nothing to rename, or when the path
 * is not under the old root — so this cannot silently move a file that was never
 * in that folder.
 */
export function withRoot(path, from, to) {
    if (!from || !to || from === to) return path;

    const segments = String(path).split('/').filter(Boolean);

    if (segments.length < 2 || segments[0] !== from) return path;

    return [to, ...segments.slice(1)].join('/');
}

// ---------------------------------------------------------------------------

/**
 * What to fetch, what to leave alone, and what would be replaced.
 *
 * @param {ManifestFile[]} manifest   what the version contains
 * @param {Map<string, LocalFile>} local  what is on disk, keyed by path
 * @param {Object} opts
 * @param {string} opts.fromRoot      the root the manifest's paths carry
 * @param {string} opts.toRoot        the root to write under, if renamed
 *
 * @returns {{
 *   write: Array,      files to fetch, with their final paths
 *   keep: Array,       files already present and identical
 *   replace: Array,    files present but DIFFERENT — writing them destroys something
 *   totalBytes: number,
 *   writeBytes: number
 * }}
 */
export function planDownload(manifest, local, { fromRoot = null, toRoot = null } = {}) {
    const write = [];
    const keep = [];
    const replace = [];

    for (const file of manifest) {
        const target = withRoot(file.path, fromRoot, toRoot);
        const here = local.get(target);

        // NOT THERE — the ordinary case, and the reason most of a first download
        // is work rather than checking.
        if (!here) {
            write.push({ ...file, target, reason: 'missing' });
            continue;
        }

        // A DIFFERENT SIZE IS A DIFFERENT FILE, and no hashing is needed to know
        // it. It is a REPLACEMENT rather than a write, because there is already
        // something at that path — and the caller decides whether to proceed.
        if (here.size !== file.size) {
            replace.push({ ...file, target, reason: 'size differs' });
            continue;
        }

        // THE SIZE AGREES AND THE HASH IS UNKNOWN. Hashed or not, it is treated
        // as present: the alternative is re-downloading every file the caller
        // chose not to hash, which for an unhashed tree is all of them.
        if (here.sha256 === null || here.sha256 === undefined) {
            keep.push({ ...file, target, verified: false });
            continue;
        }

        // THE HASH AGREES, SO THE FILE IS THE FILE. This is the whole point of
        // content addressing: two files with the same SHA are the same file, and
        // there is nothing to fetch.
        if (here.sha256 === file.sha256) {
            keep.push({ ...file, target, verified: true });
            continue;
        }

        // SAME SIZE, DIFFERENT CONTENT — the case a size check alone would miss
        // and quietly call "already there".
        replace.push({ ...file, target, reason: 'contents differ' });
    }

    const totalBytes = manifest.reduce((sum, f) => sum + (f.size || 0), 0);
    const writeBytes = [...write, ...replace].reduce((sum, f) => sum + (f.size || 0), 0);

    return { write, keep, replace, totalBytes, writeBytes };
}
