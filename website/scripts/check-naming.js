#!/usr/bin/env node
/**
 * Checks the SHARED rules in shared/.
 *
 * The folder-name parser is a regex over human-chosen names, and the whole
 * point of the near-match prompt is that parsing is fuzzy. That makes it worth
 * pinning down with cases rather than trusting a reading of the pattern.
 *
 *   node scripts/check-naming.js     # exit 0 = clean
 *
 * The cases marked with a source below came from real decisions, not
 * invention — see docs/uploadmodel01.
 *
 * IT OUTGREW ITS NAME. It started as the asset-naming check and is now also
 * where the category list and the feedback rules are pinned down, because
 * anything in shared/ is used by both sides and therefore worth testing once,
 * here. The script name is kept because renaming it would churn package.json
 * and every reference for no gain; `check:naming` is the shared-rules check.
 */

const fs = require('fs');
const path = require('path');
const N = require(path.join(__dirname, '../shared/assetRules.mjs'));
const F = require(path.join(__dirname, '../shared/feedbackRules.mjs'));

let pass = 0;
let fail = 0;

const check = (label, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(48)} ${detail}`);
};

// ---------------------------------------------------------------- parsing

console.log('  -- parsing --');

// The separator variants a developer might actually use.
const parseCases = [
    ['Asset_v08', 'Asset', '08'],
    ['Asset.v08', 'Asset', '08'],
    ['Asset-v08', 'Asset', '08'],
    ['Assetv08', 'Asset', '08'],
    ['Asset v08', 'Asset', '08'],
    ['Asset_V8', 'Asset', '8'],
    ['tree_v1.02', 'tree', '1.02'],
    ['bigAsset_v04', 'bigAsset', '04'],
    ['nuke_v10', 'nuke', '10'],
];

for (const [input, name, version] of parseCases) {
    const p = N.parseAssetName(input);
    check(`parse ${input}`, p.name === name && p.version === version, `${p.name}/${p.version}`);
}

// Names that must NOT be read as carrying a version. A false positive here
// would split an asset in two.
const noMatch = ['bigAsset04', 'Video2', 'V2', 'Vault', 'OakTree', 'texture.png', 'nuke_v10.nk'];

for (const input of noMatch) {
    const p = N.parseAssetName(input);
    check(`no version in ${input}`, p.version === null && p.name === input, `${p.name}/${p.version}`);
}

check(
    'case is preserved (asset_v04 vs ASSET_v04 must differ)',
    N.parseAssetName('asset_v04').name === 'asset' &&
    N.parseAssetName('ASSET_v04').name === 'ASSET'
);

// ---------------------------------------------------------- classification

console.log('\n  -- classification --');

for (const c of ['nuke_v10.nk', 'texture.png', 'model.blend', 'shot.ma', 'thing.uasset', 'doc.pdf', 'archive.zip']) {
    const r = N.classifyFolderName(c);
    check(`block ${c}`, r.verdict === 'block', r.verdict);
}

for (const c of ['tree.v2', 'Asset.v08', 'car.v1.02']) {
    const r = N.classifyFolderName(c);
    check(`warn ${c} (dotted separator)`, r.verdict === 'warn', r.verdict);
}

for (const c of ['Asset_v08', 'Asset-v08', 'Assetv08', 'OakTree', 'tree_v1', 'bigAsset04']) {
    const r = N.classifyFolderName(c);
    check(`accept ${c}`, r.verdict === 'ok', r.verdict);
}

check(
    'a dotted name that is not an extension is NOT blocked',
    N.classifyFolderName('scene.v2').verdict !== 'block'
);

check(
    'the block message explains why',
    /file extension/.test(N.classifyFolderName('x.png').reason)
);

// --------------------------------------------------------------- matching

console.log('\n  -- matching --');

const M = (existing, candidate) => N.matchAssetName(existing, candidate);

check('exact match', M(['OakTree', 'Rock'], 'OakTree').tier === 'exact');
check('near: case only', M(['OakTree'], 'oaktree').tier === 'near');
check('near: forgotten underscore', M(['Asset'], 'Assets').tier === 'near');
check('near: forgotten capital', M(['Asset'], 'asset').tier === 'near');
check('near: separator difference', M(['big-tree'], 'big_tree').tier === 'near');
check('different: unrelated name', M(['Asset'], 'SomethingElse').tier === 'different');
check('different: no existing assets', M([], 'Anything').tier === 'different');
check('near returns the existing name, so the UI can offer it', M(['Asset'], 'asset').match === 'Asset');
check(
    'exact wins when both would apply',
    M(['Asset', 'asset'], 'asset').tier === 'exact' && M(['Asset', 'asset'], 'asset').match === 'asset'
);
check(
    `the threshold is a named constant (${N.NEAR_MATCH_MAX_DISTANCE})`,
    typeof N.NEAR_MATCH_MAX_DISTANCE === 'number'
);
check('editDistance sanity', N.editDistance('asset', 'assets') === 1 && N.editDistance('abc', 'abc') === 0);

// ------------------------------------------------------ deriving the root

console.log('\n  -- upload root from file paths --');

const R = N.deriveUploadRoot;

check('a shared first segment is the root',
    R(['bigTree_v04/scripts/nuke.nk', 'bigTree_v04/models/tree.blend']) === 'bigTree_v04');
check('backslashes (a Windows upload) are handled',
    R(['bigTree_v04\\scripts\\nuke.nk', 'bigTree_v04\\models\\tree.blend']) === 'bigTree_v04');
check('a leading slash is ignored',
    R(['/bigTree_v04/a.nk', '/bigTree_v04/b.nk']) === 'bigTree_v04');
check('loose files at the top level have no root',
    R(['a.nk', 'b.nk']) === null);
check('a mix of directory and loose files has no root',
    R(['bigTree_v04/a.nk', 'b.nk']) === null);
check('two different roots have no single root',
    R(['bigTree_v04/a.nk', 'other/b.nk']) === null);
check('an empty list has no root', R([]) === null);
check('single nested file still yields its root',
    R(['bigTree_v04/only.nk']) === 'bigTree_v04');

// The derived root then goes through the parser, which is the whole chain.
check('the chain: paths -> root -> asset name',
    N.parseAssetName(R(['bigTree_v04/scripts/nuke.nk', 'bigTree_v04/x.blend'])).name === 'bigTree');

// ---------------------------------------------------------- backup files

console.log('\n  -- backup files --');

// The rule is in shared/assetRules.mjs and is used by BOTH sides: the browser
// drops backups before transferring them, and the server drops what arrives.
//
// It used to be written TWICE — once per side — with a test asserting the two
// copies agreed. A test that catches divergence is a poor substitute for not
// having two copies to diverge, so there is one now. What is worth testing is
// that it does its job.

const BACKUP = [
    'hereiam.txt~', 'shot.nk~', 'rig.ma~', '#autosave#', 'file.bak',
    'thing.orig', 'x.rej', 'a.swp', 'b.tmp', 'OakTree.blend1',
    'OakTree.blend2', 'OakTree.blend@', '._resource', '.DS_Store', 'Thumbs.db',
];

// These matter MORE than the matches above: discarding a real file because of
// its name would be worse than keeping a backup.
const KEEP = [
    'OakTree.blend', 'nuke_v10.nk', 'photo.png', 'tree.ma', 'notes.txt',
    'model.fbx', 'README', 'backup_notes.txt', 'tildes~inside.txt',
];

check(
    `drops all ${BACKUP.length} kinds of backup`,
    BACKUP.every(N.isBackupFile),
    BACKUP.filter(n => !N.isBackupFile(n)).join(', ')
);

check(
    `keeps all ${KEEP.length} real files`,
    KEEP.every(n => !N.isBackupFile(n)),
    KEEP.filter(N.isBackupFile).join(', ')
);

check('a path is judged on its filename, not its directory',
    N.isBackupFile('bigTree_v04/scripts/nuke.nk~') &&
    !N.isBackupFile('bigTree_v04/backup.nk'));

// ------------------------------------------------------- asset categories

console.log('\n  -- asset categories --');

// The list is a HINT, not a constraint. That distinction is the whole point of
// these tests: a value off the list must survive, because silently discarding
// what someone chose is worse than storing something untidy.

check('the list is short enough to be used',
    N.ASSET_CATEGORIES.length > 0 && N.ASSET_CATEGORIES.length <= 12,
    `${N.ASSET_CATEGORIES.length} categories`);

check('a known category keeps its canonical spelling',
    N.normaliseCategory('Character') === 'Character' &&
    N.normaliseCategory('Character') === N.normaliseCategory('Character'));

check('case and padding do not create a second category',
    N.normaliseCategory('  prop ') === 'Prop' &&
    N.normaliseCategory('FX') === N.normaliseCategory('fx'));

check('blank is null, not an empty category',
    N.normaliseCategory('') === null &&
    N.normaliseCategory('   ') === null &&
    N.normaliseCategory(undefined) === null);

// The one that separates a hint from a constraint.
check('a value off the list is KEPT, not discarded',
    N.normaliseCategory('SetDressing') === 'SetDressing',
    String(N.normaliseCategory('SetDressing')));

check('every listed category round-trips',
    N.ASSET_CATEGORIES.every(c => N.normaliseCategory(c) === c));

// ------------------------------------------------------- asset types

console.log('\n  -- asset types --');

// ONE function decides what a file is, and it is the only place with a list of
// extensions. RESERVED_EXTENSIONS is DERIVED from the same map, so these tests
// pin both halves of that: the types are right, and the two lists cannot drift
// because there is only one.

check('a known extension maps to its type',
    N.assetTypeOf('tree.blend') === 'Blender' &&
    N.assetTypeOf('shot.nk') === 'Nuke' &&
    N.assetTypeOf('sky.exr') === 'Image');

check('every declared extension maps BACK to its own type',
    Object.entries(N.ASSET_TYPE_EXTENSIONS).every(([type, exts]) =>
        exts.every(ext => N.assetTypeOf(`file.${ext}`) === type)));

check('RESERVED_EXTENSIONS is exactly the union of the type map',
    N.RESERVED_EXTENSIONS.size ===
        new Set(Object.values(N.ASSET_TYPE_EXTENSIONS).flat()).size &&
    [...N.RESERVED_EXTENSIONS].every(
        ext => Object.values(N.ASSET_TYPE_EXTENSIONS).flat().includes(ext)),
    `${N.RESERVED_EXTENSIONS.size} extensions`);

check('no extension appears in two types',
    (() => {
        const all = Object.values(N.ASSET_TYPE_EXTENSIONS).flat();
        return all.length === new Set(all).size;
    })());

check('case does not matter',
    N.assetTypeOf('SHOT.NK') === 'Nuke' &&
    N.assetTypeOf('Tree.Blend') === 'Blender');

// null is a real answer, not a failure — an unknown type is reported by the
// technical check rather than guessed at here.
check('an unknown extension is null, not a guess',
    N.assetTypeOf('thing.qqq') === null &&
    N.assetTypeOf('README') === null &&
    N.assetTypeOf('archive.tar.gz') === 'Archive',
    'the last one proves it reads the final extension');

check('a dotted NAME that is not an extension is still null',
    N.assetTypeOf('tree.v2') === null);

// The game-development formats, which is what the list is ordered and chosen
// for. These are the ones a studio actually meets; if one of these stops
// resolving, the list has been edited badly.
check('engine formats resolve',
    N.assetTypeOf('hero.uasset') === 'Unreal' &&
    N.assetTypeOf('level.umap') === 'Unreal' &&
    N.assetTypeOf('Player.prefab') === 'Unity' &&
    N.assetTypeOf('main.unity') === 'Unity' &&
    N.assetTypeOf('pack.unitypackage') === 'Unity');

check('the tools assets are made in resolve',
    N.assetTypeOf('rock.max') === '3ds Max' &&
    N.assetTypeOf('scene.c4d') === 'Cinema 4D' &&
    N.assetTypeOf('sim.hip') === 'Houdini' &&
    N.assetTypeOf('smoke.vdb') === 'Houdini' &&
    N.assetTypeOf('head.ztl') === 'ZBrush' &&
    N.assetTypeOf('skin.spp') === 'Substance' &&
    N.assetTypeOf('rig.ma') === 'Maya');

check('shipped texture formats resolve, not just the source ones',
    N.assetTypeOf('sky.ktx2') === 'Image' &&
    N.assetTypeOf('atlas.astc') === 'Image' &&
    N.assetTypeOf('ui.png') === 'Image',
    'ktx2/astc are what the engines actually ship');

// The exclusions are a decision, not an oversight — "most commonly used" was
// the instruction, and these are real formats that are not. Each one added is
// another name that stops being usable as an asset name.
check('commonly-unused formats are deliberately NOT in the list',
    N.assetTypeOf('song.xm') === null &&
    N.assetTypeOf('plan.dwg') === null &&
    N.assetTypeOf('scene.wrl') === null,
    'tracker audio, CAD, legacy web 3D');

check('the list stays a list a person can read',
    N.RESERVED_EXTENSIONS.size < 200,
    `${N.RESERVED_EXTENSIONS.size} extensions`);

// ------------------------------------------------------- feedback rules

console.log('\n  -- feedback rules --');

// The interesting property here is the OPPOSITE of the category list: the kind
// is a CLOSED set and must be rejected when it is not in it, while the category
// is a hint and must be kept. Two lists, two behaviours, and the difference is
// deliberate — a report filed under a kind nobody can filter on is a report
// nobody will find.

check('a known kind is accepted',
    F.FEEDBACK_KINDS.every(k => F.normaliseKind(k.value) === k.value));

check('an unknown kind is REJECTED, unlike a category',
    F.normaliseKind('nonsense') === null &&
    F.normaliseKind('') === null &&
    F.normaliseKind(undefined) === null,
    'there is an explicit "other" for anything that does not fit');

check('kind is matched case-insensitively',
    F.normaliseKind('BUG') === 'bug' && F.normaliseKind(' Idea ') === 'idea');

// The one that matters most: a report must not be refusable because the
// reporter was verbose, and must not be storable as nothing.
const long = 'x'.repeat(F.MAX_MESSAGE_LENGTH + 1);

check('a valid report passes',
    F.validateFeedback({ kind: 'bug', message: 'It broke.' }).ok);

check('an empty or too-short message is refused',
    !F.validateFeedback({ kind: 'bug', message: '  ' }).ok &&
    !F.validateFeedback({ kind: 'bug', message: 'ab' }).ok);

check('an over-long message is refused, not truncated',
    !F.validateFeedback({ kind: 'bug', message: long }).ok &&
    F.validateFeedback({ kind: 'bug', message: long }).errors.message
        .includes(String(F.MAX_MESSAGE_LENGTH)));

check('a bad kind and a bad message are both reported',
    Object.keys(F.validateFeedback({ kind: 'x', message: '' }).errors)
        .sort().join(',') === 'kind,message');

check('contact is optional and blank becomes null',
    F.validateFeedback({ kind: 'bug', message: 'It broke.' }).value.contact === null &&
    F.validateFeedback({ kind: 'bug', message: 'It broke.', contact: ' a@b.c ' })
        .value.contact === 'a@b.c');

check('the page URL is truncated, not refused',
    F.normalisePageUrl('/x'.repeat(1000)).length === F.MAX_PAGE_URL_LENGTH);

check('validateFeedback returns nothing the client could use to claim identity',
    !('user_id' in F.validateFeedback({ kind: 'bug', message: 'hi' }).value) &&
    !('created_at' in F.validateFeedback({ kind: 'bug', message: 'hi' }).value));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail === 0 ? '\n  PASS' : '\n  FAIL');

process.exit(fail === 0 ? 0 : 1);
