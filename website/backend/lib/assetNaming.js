// backend/lib/assetNaming.js
//
// Deriving an asset name and version from the folder a developer uploads.
//
// See docs/uploadmodel01 for the model. The short version:
//
//   * The developer's folder name carries the asset name and, usually, a
//     version marker. The name is NOT retyped in the UI.
//   * Separators vary: . - _ or a bare v.
//   * A name ending in a file extension is a FILE, never an asset or folder.
//     nuke_v10.nk is a file.
//   * The system GUIDES rather than BLOCKS: warn and offer options; reserve
//     blocking for names that are unambiguously wrong.

// ---------------------------------------------------------------------------
// Reserved file extensions
// ---------------------------------------------------------------------------
//
// A name ending in one of these is a file, not an asset or a directory. Kept
// deliberately as an explicit list rather than "contains a dot", which would
// wrongly reject legitimate names -- `tree.v2` is not a file.
//
// This list will need maintaining. That is the cost of the list approach, and
// it is cheaper than the false rejections the alternative produces.
const RESERVED_EXTENSIONS = new Set([
    // DCC / engine
    'blend', 'nk', 'ma', 'mb', 'fbx', 'obj', 'abc', 'usd', 'usda', 'usdc',
    'uasset', 'umap', 'upk', 'uproject', 'sbsar',
    // images
    'png', 'jpg', 'jpeg', 'tga', 'exr', 'tif', 'tiff', 'psd', 'hdr', 'dds',
    'bmp', 'gif', 'svg', 'webp', 'ico',
    // interchange / 3d
    'glb', 'gltf', 'dae', 'stl', 'ply',
    // documents
    'pdf', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'rtf',
    // archives
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
    // media
    'mp4', 'mov', 'avi', 'mkv', 'wav', 'mp3', 'ogg', 'flac',
    // code / config
    'js', 'mjs', 'cjs', 'json', 'py', 'cpp', 'h', 'hpp', 'cs', 'ini', 'cfg',
    'toml', 'yaml', 'yml', 'xml', 'sh', 'bat', 'ps1',
    // documents people actually upload
    'exe', 'dll', 'so', 'db', 'sqlite', 'log',
]);

// ---------------------------------------------------------------------------
// Version suffix
// ---------------------------------------------------------------------------
//
// Optional separators (\s . _ -), a literal v, then digits. A dotted version
// such as 1.02 is allowed.
//
// Case is PRESERVED in the capture, deliberately: it makes `asset_v04` and
// `ASSET_v04` parse as different names, so neither is silently merged nor
// silently split -- the near-match prompt fires instead.
//
// Verified to produce no false positives on Video2, V2, Vault, OakTree,
// texture.png or nuke_v10.nk.
const VERSION_SUFFIX = /^(?<name>.+?)(?<separator>[\s._-]*)v(?<version>\d+(?:[._-]\d+)*)$/i;

// Names closer than this (edit distance, on the normalised form) are treated as
// probably-the-same, and the developer is asked. Kept conservative on purpose:
// nagging on every unrelated upload is worse than missing a near match, because
// the developer can always choose "new asset".
const NEAR_MATCH_MAX_DISTANCE = 2;

function extensionOf(name) {
    const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return match ? match[1].toLowerCase() : null;
}

// Split a folder name into the asset name and the version the developer
// declared, if any.
//
//   Asset_v08, Asset.v08, Asset-v08, Assetv08, Asset v08  -> Asset / 08
//   tree_v1.02                                            -> tree / 1.02
//   bigAsset04                                            -> no match
function parseAssetName(rawName) {
    const raw = String(rawName || '').trim();
    const match = VERSION_SUFFIX.exec(raw);

    if (!match) {
        return { raw, name: raw, version: null, separator: null };
    }

    return {
        raw,
        name: match.groups.name,
        version: match.groups.version,
        separator: match.groups.separator,
    };
}

// The three validation tiers.
//
//   block  the suffix is a known file extension -- this is a file
//   warn   a dotted version separator, which looks like an extension
//   ok     anything else
// `code` is the machine-readable half of the verdict. The client decides which
// UI to show from it rather than matching on the prose, so rewording a message
// cannot break the interface.
function classifyFolderName(rawName) {
    const raw = String(rawName || '').trim();

    if (!raw) {
        return { verdict: 'block', code: 'empty', reason: 'The name is empty.' };
    }

    const parsed = parseAssetName(raw);
    const ext = extensionOf(raw);

    if (ext && RESERVED_EXTENSIONS.has(ext)) {
        return {
            verdict: 'block',
            code: 'reserved_extension',
            parsed,
            reason:
                `"${raw}" ends in .${ext}, which is a file extension. This is ` +
                `a file, not an asset or folder name.`
        };
    }

    if (parsed.separator === '.') {
        return {
            verdict: 'warn',
            code: 'dotted_separator',
            parsed,
            reason:
                `"${raw}" separates the version with ".", which reads like a ` +
                `file extension. Consider using "_" or "-" instead, for ` +
                `example "${parsed.name}_v${parsed.version}".`
        };
    }

    return { verdict: 'ok', code: 'ok', parsed };
}

// ---------------------------------------------------------------------------
// Matching a parsed name against the developer's existing assets
// ---------------------------------------------------------------------------

// Strip case, separators and whitespace so that differences of formatting do
// not read as different assets.
function normaliseForComparison(name) {
    return String(name || '').toLowerCase().replace(/[\s._-]+/g, '');
}

// Levenshtein distance, two rows. Used only on normalised names, which are
// short, so the cost is irrelevant here.
function editDistance(a, b) {
    if (a === b) return 0;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];

        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }

        previous = current;
    }

    return previous[b.length];
}

// Three tiers:
//
//   exact      the parsed name equals an existing asset name
//   near       it differs only by case / separators / whitespace, or is within
//              NEAR_MATCH_MAX_DISTANCE of one -- a forgotten capital or
//              underscore is exactly when a developer does NOT mean to create a
//              new asset, so we ask rather than decide
//   different  genuinely new
function matchAssetName(existingNames, candidateName) {
    const names = Array.isArray(existingNames) ? existingNames : [];
    const candidate = String(candidateName || '');

    const exact = names.find(n => n === candidate);

    if (exact) {
        return { tier: 'exact', match: exact };
    }

    const key = normaliseForComparison(candidate);

    const byKey = names.filter(n => normaliseForComparison(n) === key);

    if (byKey.length > 0) {
        return { tier: 'near', match: byKey[0], candidates: byKey };
    }

    let best = null;
    let bestDistance = Infinity;

    for (const name of names) {
        const distance = editDistance(key, normaliseForComparison(name));

        if (distance < bestDistance) {
            bestDistance = distance;
            best = name;
        }
    }

    if (best !== null && bestDistance <= NEAR_MATCH_MAX_DISTANCE) {
        return { tier: 'near', match: best, distance: bestDistance };
    }

    return { tier: 'different' };
}

// ---------------------------------------------------------------------------
// Deriving the uploaded root from the file paths
// ---------------------------------------------------------------------------
//
// A directory upload arrives as paths sharing a first segment:
//
//     bigTree_v04/scripts/nuke.nk
//     bigTree_v04/models/tree.blend
//     -> bigTree_v04
//
// Deriving it here rather than trusting a separate field means the name cannot
// disagree with the content it describes. The client may still send an explicit
// name, but this is the fallback and the cross-check.
//
// Returns null when there is no single root: loose files at the top level, or a
// mix of a directory and loose files. The caller decides what to do about that
// — there is no name to derive, so the upload cannot infer one.
function deriveUploadRoot(filePaths) {
    const paths = (Array.isArray(filePaths) ? filePaths : [])
        .map(p => String(p).replace(/\\/g, '/').replace(/^\/+/, ''))
        .filter(p => p.length > 0);

    if (paths.length === 0) return null;

    const roots = new Set();

    for (const p of paths) {
        const segments = p.split('/');

        // A file with no directory component sits at the top level, which means
        // there is no single folder to take a name from.
        if (segments.length < 2) return null;

        roots.add(segments[0]);
    }

    return roots.size === 1 ? [...roots][0] : null;
}

module.exports = {
    RESERVED_EXTENSIONS,
    NEAR_MATCH_MAX_DISTANCE,
    extensionOf,
    parseAssetName,
    classifyFolderName,
    normaliseForComparison,
    editDistance,
    matchAssetName,
    deriveUploadRoot,
};
