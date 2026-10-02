#!/usr/bin/env node
/**
 * Checks backend/lib/assetNaming.js.
 *
 * The folder-name parser is a regex over human-chosen names, and the whole
 * point of the near-match prompt is that parsing is fuzzy. That makes it worth
 * pinning down with cases rather than trusting a reading of the pattern.
 *
 *   node scripts/check-naming.js     # exit 0 = clean
 *
 * The cases marked with a source below came from real decisions, not
 * invention — see docs/uploadmodel01.
 */

const fs = require('fs');
const path = require('path');
const N = require(path.join(__dirname, '../shared/assetRules.mjs'));

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

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail === 0 ? '\n  PASS' : '\n  FAIL');

process.exit(fail === 0 ? 0 : 1);
