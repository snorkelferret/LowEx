#!/usr/bin/env node
/**
 * Fails when backend-facing client code looks up a DOM id that does not exist.
 *
 * Why this is worth a script: `$('thing')` followed by `if (!el) return` fails
 * SILENTLY. A typo'd id does not throw — the feature simply never runs, and
 * nothing in a build or a log says so. That is the most likely way a change
 * like the upload pre-flight breaks without anyone noticing.
 *
 * An id counts as present if it is in the built HTML, or if the client assigns
 * it at runtime (`el.id = 'thing'`), which several renderers do.
 *
 *   npm run check:dom
 *
 * Needs frontend/dist. Run `npm run build` first; a missing dist is reported
 * and skipped rather than treated as a failure, so a fresh clone does not trip
 * on it.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const distPage = path.join(repoRoot, 'frontend/dist/devDashboard.html');
const clientFile = path.join(repoRoot, 'frontend/src/developerWorkspace.js');

if (!fs.existsSync(distPage)) {
    console.log('  No built page at ' + distPage);
    console.log('  Run `npm run build` first. Nothing to check.');
    process.exit(0);
}

const html = fs.readFileSync(distPage, 'utf8');
const client = fs.readFileSync(clientFile, 'utf8');

// Ids written into the markup.
const declared = new Set(
    [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
);

// Ids the client assigns at runtime. Several renderers create their elements
// and set the id afterwards, so a lookup for one of those is correct even
// though it never appears in the static page.
for (const m of client.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) {
    declared.add(m[1]);
}

// Every literal id passed to $('...').
const looked = [...new Set([...client.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))].sort();

const missing = looked.filter(id => !declared.has(id));

console.log('  page   : ' + path.relative(repoRoot, distPage));
console.log('  client : ' + path.relative(repoRoot, clientFile));
console.log('');
console.log(`  ids looked up : ${looked.length}`);
console.log(`  ids declared  : ${declared.size} (markup + runtime)`);
console.log('');

if (missing.length === 0) {
    console.log('  PASS — every id looked up is declared somewhere');
    process.exit(0);
}

console.log(`  FAIL — ${missing.length} id(s) looked up but never declared:`);
for (const id of missing) {
    console.log('    - ' + id);
}
console.log('');
console.log('  An undeclared id does not throw; the code behind it just never runs.');

process.exit(1);
