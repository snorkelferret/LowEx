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

const path = require('path');
const N = require(path.join(__dirname, '../backend/lib/assetNaming.js'));

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

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail === 0 ? '\n  PASS' : '\n  FAIL');

process.exit(fail === 0 ? 0 : 1);
