#!/usr/bin/env node
// scripts/api-key.js
//
// ISSUE AND REVOKE THE KEYS PROGRAMS USE.
//
//   node scripts/api-key.js --create "unreal-editor-tool"
//   node scripts/api-key.js --list
//   node scripts/api-key.js --revoke <id>
//
// ============================================================
// WHY THIS IS A SCRIPT AND NOT A PAGE
// ============================================================
//
// A key is a long-lived secret for a program. Issuing one from the website
// would put the plaintext into a browser, a response body and possibly a
// screenshot; doing it at the console means it is printed once, to the person
// who is about to put it in a file, and nowhere else.
//
// The plaintext is NEVER stored and cannot be shown again. A lost key is
// revoked and replaced, which is the correct outcome: a key that can be looked
// up again is a key that can be copied again.
//
// ============================================================
// WHAT A KEY CAN DO
// ============================================================
//
// One thing: post a test receipt (backend/routes/integration.js). It is not a
// login, has no role, and cannot read or write anything else. The route also
// honours the `integration_tooling` setting, so a key issued today does nothing
// while the switch is off.

require('dotenv').config({ quiet: true });

const { createKey, listKeys, deleteKey } = require('../backend/lib/apiKeys');

const args = process.argv.slice(2);

function argument(flag) {
    const index = args.indexOf(flag);

    if (index === -1) return undefined;

    return args.slice(index + 1).find(a => !a.startsWith('--'));
}

if (args.includes('--help') || args.length === 0) {
    console.log(`
Usage:
  node scripts/api-key.js --create "<name>"   issue a key; printed once
  node scripts/api-key.js --list              keys by name and prefix
  node scripts/api-key.js --revoke <id>       delete a key immediately
`);
    process.exit(0);
}

if (args.includes('--create')) {
    const name = argument('--create');

    if (!name) {
        console.error('--create needs a name, so the key can be recognised in a list.');
        process.exit(1);
    }

    const { key, prefix } = createKey(name);

    console.log(`
Key issued for: ${name}
Prefix:         ${prefix}

    ${key}

This is the only time the key is shown. Put it in the tool's environment file
(0600), not in a command line and not in git. To replace it, revoke it and
issue another.
`);
    process.exit(0);
}

if (args.includes('--list')) {
    const keys = listKeys.all();

    if (keys.length === 0) {
        console.log('No keys issued.');
        process.exit(0);
    }

    for (const row of keys) {
        console.log(
            `${String(row.id).padStart(3)}  ${row.key_prefix}  ` +
            `${row.name}  created ${row.created_at}` +
            `${row.last_used ? `  last used ${row.last_used}` : '  never used'}`
        );
    }

    process.exit(0);
}

if (args.includes('--revoke')) {
    const id = Number(argument('--revoke'));

    if (!Number.isInteger(id) || id < 1) {
        console.error('--revoke needs an id from --list.');
        process.exit(1);
    }

    const result = deleteKey.run(id);

    console.log(result.changes ? `Revoked key ${id}.` : `No key with id ${id}.`);
    process.exit(result.changes ? 0 : 1);
}

console.error('Nothing to do. Run with --help for the options.');
process.exit(1);
