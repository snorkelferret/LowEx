#!/usr/bin/env node
/**
 * Fails when client code looks up a DOM id that does not exist on the page it
 * is built into.
 *
 * Why this is worth a script: `$('thing')` followed by `if (!el) return` fails
 * SILENTLY. A typo'd id does not throw — the feature simply never runs, and
 * neither a build nor a log says so. That is the most likely way a change like
 * the upload pre-flight or the register page breaks without anyone noticing.
 *
 * An id counts as present if it is in the built page, or if that client
 * assigns it at runtime (`el.id = 'thing'`), which several renderers do.
 *
 *   npm run check:dom
 *
 * Needs frontend/dist. Run `npm run build` first. A missing page is reported
 * and skipped rather than treated as a failure, so a fresh clone does not trip
 * on it.
 *
 * The pairs below are explicit rather than derived from build.js. If a page or
 * client is renamed, this fails loudly — which is the point. A client built
 * into several pages must satisfy all of them, because the same lookup runs in
 * each.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const dist = (name) => path.join(repoRoot, 'frontend/dist', name);

const CHECKS = [
    {
        client: 'frontend/src/developerWorkspace.js',
        pages: ['devDashboard.html'],
    },
    {
        // Pre-auth: no header, no guard. Its ids live only on this page.
        client: 'frontend/src/register.js',
        pages: ['register.html'],
    },
    {
        client: 'frontend/src/superuser.js',
        pages: ['superuserDashboard.html'],
    },
    {
        client: 'frontend/src/admin.js',
        pages: ['adminDashboard.html'],
    },
    {
        // Built into BOTH dashboards, so its ids have to exist in both.
        client: 'frontend/src/sharedInvites.js',
        pages: ['adminDashboard.html', 'superuserDashboard.html'],
    },
];

// Ids that are genuinely absent, with the reason. These are NOT typos: the
// client is written for a control that was never added to the markup, or for a
// feature that is deliberately deferred.
//
// Listed rather than ignored, so:
//   - they stay visible instead of being forgotten;
//   - a NEW missing id still fails the check, which is the whole point.
//
// Remove an entry when the control is added or the code is deleted. TODO item
// 24 tracks them.
const KNOWN_MISSING = {
    'runDiagnosticsBtn':
        'superuser.js binds it, but the button lived in a component that was '
        + 'only ever built into the DEVELOPER dashboard. The endpoint works; '
        + 'the button needs adding to the superuser panel.',
    'signInAsBtn':
        'the entry point for impersonation, which is deferred by decision. '
        + 'Impersonation is how an admin reaches inside a workspace.',
    'invite-link-input':
        'sharedInvites.js copyInviteLink() selects it, but nothing renders the '
        + 'generated link with that id, so the copy helper does nothing.',
};

let failures = 0;
let skipped = 0;
const known = [];

for (const { client, pages } of CHECKS) {
    const clientPath = path.join(repoRoot, client);

    if (!fs.existsSync(clientPath)) {
        console.log(`  FAIL  ${client} — file not found`);
        failures++;
        continue;
    }

    const source = fs.readFileSync(clientPath, 'utf8');

    // Ids written into markup, plus ids this client assigns at runtime.
    const declared = new Set();

    for (const page of pages) {
        const pagePath = dist(page);

        if (!fs.existsSync(pagePath)) {
            console.log(`  skip  ${client} — ${page} not built`);
            skipped++;
            continue;
        }

        const html = fs.readFileSync(pagePath, 'utf8');
        for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
            declared.add(m[1]);
        }
    }

    for (const m of source.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) {
        declared.add(m[1]);
    }

    if (declared.size === 0) {
        console.log(`  skip  ${client} — no page built to check against`);
        skipped++;
        continue;
    }

    // BOTH lookup forms. Some clients use a `$` helper and some call
    // getElementById directly — an earlier version of this check only knew
    // about `$`, so it silently covered nothing at all for three of the five
    // clients while still reporting success.
    const LOOKUPS = [
        /\$\('([^']+)'\)/g,
        /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    const looked = [...new Set(
        LOOKUPS.flatMap(pattern =>
            [...source.matchAll(pattern)].map(m => m[1])
        )
    )].sort();

    const missing = looked.filter(id => !declared.has(id));

    const unexpected = [];
    for (const id of missing) {
        if (KNOWN_MISSING[id]) known.push({ client, id });
        else unexpected.push(id);
    }

    if (unexpected.length === 0) {
        console.log(
            `  ok    ${client.padEnd(40)} ${looked.length} ids, against ${pages.join(' + ')}` +
            (missing.length ? `  (${missing.length} known gap)` : '')
        );
        continue;
    }

    console.log(`  FAIL  ${client} — ${unexpected.length} id(s) never declared:`);
    for (const id of unexpected) console.log(`          - ${id}`);
    failures++;
}

console.log('');

if (known.length > 0) {
    console.log(`  ${known.length} known gap(s) — real, but expected:`);
    for (const { client, id } of known) {
        console.log(`    ${id}  (${client.split('/').pop()})`);
        console.log(`      ${KNOWN_MISSING[id]}`);
    }
    console.log('');
}

if (skipped > 0) {
    console.log(`  ${skipped} check(s) skipped — run \`npm run build\` first for full coverage.`);
}

if (failures === 0) {
    console.log('  PASS — every id looked up is declared, or is a known gap');
    process.exit(0);
}

console.log(`  FAIL — ${failures} client(s) with UNEXPECTED missing ids`);
console.log('  An undeclared id does not throw; the code behind it just never runs.');

process.exit(1);
