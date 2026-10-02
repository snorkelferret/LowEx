// shared/assetRules.mjs
//
// THE asset and file rules, in ONE place, used by both sides.
//
//   backend  require()s it   (Node 22 supports require() of an ES module)
//   frontend imports it      (vite resolves the sibling directory)
//
// WHY IT LIVES HERE AND NOT IN EITHER HALF. These rules are needed on both
// sides and they must agree: a backup file has to be dropped by the browser
// before it is transferred, AND by the server, which is what makes dropping it
// true. Two copies of that would drift, and the drift would be silent.
//
// ONE FUNCTION PER TASK. If a rule is needed in more than one place it belongs
// here rather than being written again; if it is needed in one place only, it
// does not.
//
// The previous arrangement had the backup patterns written twice, in
// backend/lib/assetNaming.js and frontend/src/developerWorkspace.js, with a
// test asserting the two agreed. A test that catches divergence is a poor
// substitute for not having two copies to diverge.

// ---------------------------------------------------------------------------
// Deriving an asset name and version from the folder a developer uploads
// ---------------------------------------------------------------------------
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
// Asset types — WHAT a file is
// ---------------------------------------------------------------------------
//
// THE ONE PLACE THE TYPE OF A FILE IS DECIDED. There is one function for this
// and it is assetTypeOf(); nothing anywhere else classifies a file, and nothing
// anywhere else keeps its own list of extensions.
//
// It replaced a form field that asked the developer to choose between content
// types and TOOLS. The tool is a property of the file, so the machine reads it
// rather than a human restating it — and a field a human fills in from memory
// is a field that is wrong at a predictable rate.
//
// THESE EXTENSION LISTS ARE ALSO THE SOURCE OF RESERVED_EXTENSIONS, which
// answers a different question about the same vocabulary — "is this name a file
// or a folder?". Writing the extensions out twice would guarantee the two
// drifted, so the reserved set is DERIVED from here. One list, two questions.
//
// ORDERED FOR GAME DEVELOPMENT FIRST — engines, then the tools that feed them,
// then the interchange and file formats around them. The order carries no
// behaviour; it is here so that the common case is at the top of the list for
// whoever has to read or extend it.
//
// WHICH EXTENSIONS ARE IN, AND WHY. Only formats a game studio plausibly meets.
// The set is drawn from what the engines and marketplaces actually accept —
// Epic's Fab asset requirements and Unity's import list are the two most
// concrete published sources — rather than from a generic "file extensions"
// dump, which would add hundreds of formats nobody in this pipeline will ever
// upload and make the list harder to trust.
//
// NOT INCLUDED, deliberately: tracker audio (.mod .xm .it .s3m), CAD (.dwg),
// and legacy web 3D (.wrl .x3d). All real, none common in production, and every
// extension added is one more name that stops being usable as an asset name.
//
// Extensions are written without the dot, lowercase.
const ASSET_TYPE_EXTENSIONS = {

    // ---- game engines ----
    Unreal:      ['uasset', 'umap', 'upk', 'uproject'],
    Unity:       ['unity', 'unitypackage', 'prefab', 'meta'],

    // ---- the tools assets are made in ----
    Blender:     ['blend'],
    Maya:        ['ma', 'mb'],
    '3ds Max':   ['max', '3ds'],
    'Cinema 4D': ['c4d'],
    Houdini:     ['hip', 'hipnc', 'hiplc', 'hda', 'bgeo', 'vdb'],
    ZBrush:      ['ztl', 'zpr', 'zbr'],
    Substance:   ['sbsar', 'spp', 'sbs'],
    Nuke:        ['nk'],
    Modo:        ['lxo'],
    LightWave:   ['lwo'],

    // ---- 3D interchange ----
    '3D model':  ['fbx', 'obj', 'abc', 'usd', 'usda', 'usdc', 'usdz',
                  'glb', 'gltf', 'dae', 'stl', 'ply', 'dxf'],

    // ---- textures and images ----
    Image:       ['png', 'jpg', 'jpeg', 'tga', 'exr', 'hdr', 'tif', 'tiff',
                  'psd', 'psb', 'dds', 'bmp', 'gif', 'svg', 'webp', 'ico',
                  // compressed formats the engines actually ship
                  'ktx', 'ktx2', 'astc', 'basis', 'pvr', 'crn'],

    Video:       ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'mpg', 'mpeg',
                  'm4v'],
    Audio:       ['wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff', 'opus', 'm4a'],
    Font:        ['ttf', 'otf', 'woff', 'woff2', 'fnt'],

    Document:    ['pdf', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'pptx',
                  'odt', 'ods', 'odp', 'csv', 'rtf'],
    Archive:     ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
    Code:        ['js', 'mjs', 'cjs', 'json', 'py', 'cpp', 'h', 'hpp', 'cs',
                  'ini', 'cfg', 'toml', 'yaml', 'yml', 'xml', 'sh', 'bat',
                  'ps1'],
    Other:       ['exe', 'dll', 'so', 'db', 'sqlite', 'log'],
};

// A name ending in one of these is a file, not an asset or a directory. Kept as
// an explicit list rather than "contains a dot", which would wrongly reject
// legitimate names — `tree.v2` is not a file.
//
// DERIVED, NOT DECLARED. See above: the type map is the list.
const RESERVED_EXTENSIONS = new Set(
    Object.values(ASSET_TYPE_EXTENSIONS).flat()
);

// Extension -> type, built once. The reverse of the map above.
const TYPE_BY_EXTENSION = new Map(
    Object.entries(ASSET_TYPE_EXTENSIONS)
        .flatMap(([type, extensions]) => extensions.map(ext => [ext, type]))
);

// WHAT TYPE A FILE IS, or null if the extension is not one we recognise.
//
// null IS A REAL ANSWER, not a failure. An unrecognised extension means the
// system cannot classify the file — which the technical check reports, rather
// than the function guessing. Callers decide whether that is acceptable; this
// one does not decide it for them.
function assetTypeOf(filename) {
    const extension = extensionOf(filename);
    if (!extension) return null;

    return TYPE_BY_EXTENSION.get(extension) || null;
}

// ---------------------------------------------------------------------------
// Content signatures — whether the bytes ARE what the name claims
// ---------------------------------------------------------------------------
//
// The extension is a CLAIM. This is what turns it into something a reviewer can
// rely on, or says plainly that it cannot.
//
// IT LIVES HERE, beside the type map, because the two are views of the same
// vocabulary: an extension's type and an extension's signature have to agree,
// and kept apart they would drift.
//
// THE INCLUSION RULE, and it is strict: a format is listed ONLY if a file of
// that format ALWAYS starts with these bytes. Anything else is left out and
// reported as UNVERIFIABLE — which is not a failure, and not a pass. A tick
// that cannot fail is worse than no check, so this refuses to pretend.
//
// That is why the text formats are largely absent. .obj, .ma, .nk, .dae and
// .gltf are text and have no reliable opening bytes; a .obj is recognised by
// the shape of its lines, which is a parse, not a signature. Saying "cannot
// confirm" about them is the honest answer.
//
// Each condition is a hex string at a byte offset, and ALL must match. Offsets
// are needed more often than you would hope: MP4 says nothing at byte 0 and
// identifies itself at byte 4, and anything RIFF-based (WAV, WebP, AVI) keeps
// half its identity at byte 8.
const CONTENT_FORMATS = [
    // ---- images ----
    { format: 'PNG',      extensions: ['png'],      conditions: [{ offset: 0, hex: '89504E470D0A1A0A' }] },
    { format: 'JPEG',     extensions: ['jpg', 'jpeg'], conditions: [{ offset: 0, hex: 'FFD8FF' }] },
    { format: 'GIF',      extensions: ['gif'],      conditions: [{ offset: 0, hex: '47494638' }] },
    { format: 'BMP',      extensions: ['bmp'],      conditions: [{ offset: 0, hex: '424D' }] },
    { format: 'ICO',      extensions: ['ico'],      conditions: [{ offset: 0, hex: '00000100' }] },
    { format: 'TIFF',     extensions: ['tif', 'tiff'], conditions: [
        { offset: 0, hex: '49492A00' },   // little-endian
    ] },
    { format: 'TIFF (big-endian)', extensions: ['tif', 'tiff'], conditions: [
        { offset: 0, hex: '4D4D002A' },
    ] },
    { format: 'OpenEXR',  extensions: ['exr'],      conditions: [{ offset: 0, hex: '762F3101' }] },
    { format: 'DDS',      extensions: ['dds'],      conditions: [{ offset: 0, hex: '44445320' }] },
    { format: 'Photoshop', extensions: ['psd', 'psb'], conditions: [{ offset: 0, hex: '38425053' }] },
    { format: 'WebP',     extensions: ['webp'],     conditions: [
        { offset: 0, hex: '52494646' }, { offset: 8, hex: '57454250' },
    ] },
    { format: 'KTX',      extensions: ['ktx', 'ktx2'], conditions: [{ offset: 0, hex: 'AB4B5458' }] },
    { format: 'ASTC',     extensions: ['astc'],     conditions: [{ offset: 0, hex: '13ABA15C' }] },

    // ---- 3d ----
    { format: 'glTF binary', extensions: ['glb'],   conditions: [{ offset: 0, hex: '676C5446' }] },
    { format: 'Blender',  extensions: ['blend'],    conditions: [{ offset: 0, hex: '424C454E444552' }] },
    { format: 'FBX (binary)', extensions: ['fbx'],  conditions: [{ offset: 0, hex: '4B617964617261' }] },
    { format: 'Alembic',  extensions: ['abc'],      conditions: [{ offset: 0, hex: '4F67617761' }] },
    { format: 'USD binary', extensions: ['usdc'],   conditions: [{ offset: 0, hex: '5058522D55534443' }] },
    { format: 'USD ascii', extensions: ['usda'],    conditions: [{ offset: 0, hex: '2375736461' }] },
    { format: 'PLY',      extensions: ['ply'],      conditions: [{ offset: 0, hex: '706C79' }] },

    // ---- audio ----
    { format: 'WAV',      extensions: ['wav'],      conditions: [
        { offset: 0, hex: '52494646' }, { offset: 8, hex: '57415645' },
    ] },
    { format: 'AIFF',     extensions: ['aif', 'aiff'], conditions: [
        { offset: 0, hex: '464F524D' }, { offset: 8, hex: '41494646' },
    ] },
    { format: 'Ogg',      extensions: ['ogg', 'opus'], conditions: [{ offset: 0, hex: '4F676753' }] },
    { format: 'FLAC',     extensions: ['flac'],     conditions: [{ offset: 0, hex: '664C6143' }] },
    { format: 'MP3',      extensions: ['mp3'],      conditions: [{ offset: 0, hex: '494433' }] },

    // ---- video ----
    { format: 'ISO media', extensions: ['mp4', 'm4v', 'mov'], conditions: [
        { offset: 4, hex: '66747970' },
    ] },
    { format: 'Matroska', extensions: ['mkv', 'webm'], conditions: [{ offset: 0, hex: '1A45DFA3' }] },
    { format: 'AVI',      extensions: ['avi'],      conditions: [
        { offset: 0, hex: '52494646' }, { offset: 8, hex: '41564920' },
    ] },
    { format: 'ASF',      extensions: ['wmv'],      conditions: [{ offset: 0, hex: '3026B2758E66CF11' }] },

    // ---- fonts ----
    { format: 'TrueType', extensions: ['ttf'],      conditions: [{ offset: 0, hex: '00010000' }] },
    { format: 'OpenType', extensions: ['otf'],      conditions: [{ offset: 0, hex: '4F54544F' }] },
    { format: 'WOFF',     extensions: ['woff'],     conditions: [{ offset: 0, hex: '774F4646' }] },
    { format: 'WOFF2',    extensions: ['woff2'],    conditions: [{ offset: 0, hex: '774F4632' }] },

    // ---- archives and containers ----
    // One ZIP signature covers a lot: .docx, .xlsx, .pptx, .odt, .sbsar and
    // .unitypackage are all ZIP archives underneath.
    { format: 'ZIP',      extensions: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods',
                                       'odp', 'sbsar', 'unitypackage'], conditions: [
        { offset: 0, hex: '504B0304' },
    ] },
    { format: 'RAR',      extensions: ['rar'],      conditions: [{ offset: 0, hex: '526172211A07' }] },
    { format: '7-Zip',    extensions: ['7z'],       conditions: [{ offset: 0, hex: '377ABCAF271C' }] },
    { format: 'GZIP',     extensions: ['gz', 'tgz'], conditions: [{ offset: 0, hex: '1F8B' }] },
    { format: 'BZIP2',    extensions: ['bz2'],      conditions: [{ offset: 0, hex: '425A68' }] },
    { format: 'XZ',       extensions: ['xz'],       conditions: [{ offset: 0, hex: 'FD377A585A00' }] },
    { format: 'TAR',      extensions: ['tar'],      conditions: [{ offset: 257, hex: '7573746172' }] },

    // ---- documents ----
    { format: 'PDF',      extensions: ['pdf'],      conditions: [{ offset: 0, hex: '25504446' }] },
    { format: 'Unity asset', extensions: ['unity', 'prefab', 'meta'], conditions: [
        { offset: 0, hex: '2559414D4C' },
    ] },
];

// Extension -> the formats that extension is allowed to be. An extension with
// no entry here is UNVERIFIABLE, which is a real answer and not an error.
const FORMATS_BY_EXTENSION = (() => {
    const map = new Map();

    for (const entry of CONTENT_FORMATS) {
        for (const extension of entry.extensions) {
            if (!map.has(extension)) map.set(extension, []);
            map.get(extension).push(entry);
        }
    }

    return map;
})();

// CONTENT THAT IS REFUSED WHATEVER IT IS CALLED.
//
// A separate list from the format signatures, because it answers a different
// question. A .png that is really a JPEG is a mislabelled asset; a .png that is
// really a Windows executable is something else entirely, and the two should
// not arrive as the same finding.
//
// Checked BEFORE the extension is consulted, so naming it .nk does not help.
// Note what is NOT here: anything identified by "#!" or by a text prefix. Shell
// and Python scripts share those markers with legitimate files in this
// pipeline — a Nuke script and a Maya script are text too — so a rule built on
// them would fail real assets. Running uploaded code is prevented by nothing
// ever executing a stored file (item 35), not by this list.
const BLOCKED_CONTENT = [
    { format: 'Windows executable', conditions: [{ offset: 0, hex: '4D5A' }] },
    { format: 'Linux executable',   conditions: [{ offset: 0, hex: '7F454C46' }] },
    { format: 'macOS executable',   conditions: [{ offset: 0, hex: 'FEEDFACE' }] },
    { format: 'macOS executable',   conditions: [{ offset: 0, hex: 'FEEDFACF' }] },
    { format: 'macOS executable',   conditions: [{ offset: 0, hex: 'CFFAEDFE' }] },
    { format: 'Java class or universal binary', conditions: [{ offset: 0, hex: 'CAFEBABE' }] },
];

// How many bytes to read. 512 covers every condition above, including TAR's at
// offset 257. Nothing here parses a whole file.
const SIGNATURE_HEAD_BYTES = 512;

function conditionsMatch(head, conditions) {
    return conditions.every(({ offset, hex }) => {
        const wanted = Buffer.from(hex, 'hex');
        if (offset + wanted.length > head.length) return false;

        return head.subarray(offset, offset + wanted.length).equals(wanted);
    });
}

/**
 * Is this file what its name says it is?
 *
 * @param extension  lowercase, no dot — from extensionOf()
 * @param head       the first SIGNATURE_HEAD_BYTES of the content
 *
 * @returns { outcome, format?, expected?, actual? } where outcome is one of:
 *
 *   'blocked'       refused content, whatever the name. Checked first, so a
 *                   rename cannot get past it.
 *   'confirmed'     the bytes match a signature this extension may have.
 *   'contradicted'  the bytes match something else — the name is wrong, or the
 *                   file is not what it claims.
 *   'unverifiable'  nothing reliable to check against. NOT a pass.
 */
function checkFileContent(extension, head) {
    const bytes = Buffer.isBuffer(head) ? head : Buffer.from(head || []);

    for (const blocked of BLOCKED_CONTENT) {
        if (conditionsMatch(bytes, blocked.conditions)) {
            return { outcome: 'blocked', actual: blocked.format };
        }
    }

    const allowed = FORMATS_BY_EXTENSION.get(extension);

    if (!allowed) {
        return { outcome: 'unverifiable' };
    }

    for (const format of allowed) {
        if (conditionsMatch(bytes, format.conditions)) {
            return { outcome: 'confirmed', format: format.format };
        }
    }

    // The name has a signature and the content does not match it. Say what it
    // DOES look like, when it looks like something — that is the sentence a
    // reviewer needs.
    const looksLike = CONTENT_FORMATS.find(f => conditionsMatch(bytes, f.conditions));

    return {
        outcome: 'contradicted',
        expected: allowed.map(f => f.format).join(' or '),
        actual: looksLike ? looksLike.format : null,
    };
}

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
// Backup files
// ---------------------------------------------------------------------------
//
// Editor and application backups are not assets. They are leftovers that
// happen to sit beside the real file, and they are not always small: Blender's
// .blend1 is a full copy of the .blend it backs up, so uploading them can
// double the size of a large asset for no benefit at all.
//
// Seen in practice: a folder containing `hereiam.txt~` alongside the real file.
//
// These are FILTERED, not rejected. One stray backup must not fail a whole
// folder upload — that would be a hostile way to react to something the
// developer did not do deliberately.
const BACKUP_PATTERNS = [
    /~$/,              // hereiam.txt~   Emacs, gedit; also Nuke and Maya autosaves
    /^#.*#$/,          // #file#         Emacs autosave
    /\.bak$/i,         // file.bak
    /\.orig$/i,        // merge leftovers
    /\.rej$/i,
    /\.swp$/i,         // vim
    /\.swo$/i,
    /\.tmp$/i,
    /\.blend\d+$/i,    // Blender numbered backups: file.blend1, file.blend2
    /\.blend@$/i,      // Blender's "quit without saving" file
    /^\._/,            // macOS resource forks
    /^\.DS_Store$/i,
    /^Thumbs\.db$/i,
];

function isBackupFile(name) {
    const base = String(name || '').replace(/\\/g, '/').split('/').pop();

    if (!base) return false;

    return BACKUP_PATTERNS.some(pattern => pattern.test(base));
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

// ---------------------------------------------------------------------------
// Content category
// ---------------------------------------------------------------------------
//
// Which part of the game the asset belongs to. This is the one question about an
// asset that ONLY A HUMAN CAN ANSWER, which is why it is asked — unlike the old
// "asset type" field, which asked the developer to restate what the file
// extension already said (Maya, Blender, Nuke are tools, and the file type
// verifier reads them off the file).
//
// DELIBERATELY NOT A CHECK CONSTRAINT. The old asset_type column was a CHECK,
// and the CHECK could not be altered, so changing the list meant a full 12-step
// table rebuild — twice. This list will grow. Keeping it here means adding a
// category is a one-line edit with no migration, and the column stays free text.
//
// The list is the industry's usual content-domain split — what a studio would
// put on the top of an asset browser. It is deliberately flat and short: a
// taxonomy nobody uses is worse than no taxonomy, because it produces wrong
// answers with confidence.
const ASSET_CATEGORIES = [
    'Character',
    'Environment',
    'Prop',
    'Vehicle',
    'Weapon',
    'FX',
    'Audio',
    'UI',
    'Other',
];

// The list above is a HINT, not a constraint.
//
// So this guides rather than enforces, in both directions:
//
//   * a value that matches the list is stored under its canonical spelling, so
//     a client sending "prop" does not create a second category that reads
//     identically in a list;
//   * a value that does NOT match is kept as-is rather than thrown away.
//
// That second half is deliberate and is the difference between a hint and a
// constraint. Silently discarding a name someone chose is worse than storing an
// untidy one — they would set it, see it vanish, and have no way to tell why.
// An asset is allowed to carry a category nobody else uses, and is allowed to
// carry none at all.
//
// Empty and whitespace-only become null, which is the one value meaning
// "not categorised yet".
function normaliseCategory(value) {
    const wanted = String(value ?? '').trim();
    if (!wanted) return null;

    const known = ASSET_CATEGORIES.find(
        c => c.toLowerCase() === wanted.toLowerCase()
    );

    return known || wanted;
}

export {
    RESERVED_EXTENSIONS,
    ASSET_TYPE_EXTENSIONS,
    assetTypeOf,
    CONTENT_FORMATS,
    BLOCKED_CONTENT,
    SIGNATURE_HEAD_BYTES,
    checkFileContent,
    NEAR_MATCH_MAX_DISTANCE,
    BACKUP_PATTERNS,
    ASSET_CATEGORIES,
    normaliseCategory,
    extensionOf,
    parseAssetName,
    classifyFolderName,
    normaliseForComparison,
    editDistance,
    matchAssetName,
    deriveUploadRoot,
    isBackupFile,
};
