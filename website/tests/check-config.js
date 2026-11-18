#!/usr/bin/env node
/**
 * Checks that NO PORT, HOSTNAME OR DOMAIN IS HARDWIRED OUTSIDE
 * shared/config.mjs.
 *
 *   node tests/check-config.js       # exit 0 = clean
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * The portal's addresses were spread over four files with five defaults for
 * three values, and they agreed by coincidence. On 2026-10-29 the backend moved
 * to IPv4 loopback and the development proxy kept pointing at "localhost" —
 * which resolves to ::1 on this machine — and nothing connected. One file would
 * have made the mismatch visible before it was a bug.
 *
 * It cannot be made visible by reading, either: a second default looks exactly
 * like the first one, and the file that holds it is usually the file somebody
 * is about to edit.
 *
 * ============================================================
 * WHAT IT CHECKS
 * ============================================================
 *
 *   a port        5000, 5173, 5174 — the development ports
 *   an address    localhost, 127.0.0.1, lowexpectations.zone
 *
 * anywhere in the application's source OR THE DEPLOYMENT CONFIG, EXCEPT
 * shared/config.mjs, which is where the defaults are supposed to be.
 *
 * THE DEPLOYMENT FILES ARE SCANNED TOO — the trigger script, the systemd units
 * and the nginx template. A hardwired address there is the same mistake as one
 * in a route: it is the value somebody has to find and edit when the portal
 * moves. The nginx file is a TEMPLATE (PUBLIC_HOST, CERT_DIR, UPSTREAM,
 * substituted by install.sh) and the trigger requires its two addresses from
 * its environment file rather than defaulting them.
 *
 * COMMENT LINES ARE SKIPPED. The code explains these values in prose — "the
 * socket is on 127.0.0.1:5000" — and forbidding that would make the code less
 * clear to satisfy a checker. A line that starts with //, * or /* is prose.
 *
 * scripts/ IS NOT SCANNED, DELIBERATELY. A test must know what it expects
 * independently of the code it is testing; check:bind asserting "127.0.0.1"
 * is the check doing its job, and importing the default from the config would
 * make it agree with whatever the default became — which is the failure it
 * exists to catch.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DIRECTORIES = ['backend', 'frontend/src', 'shared', '../deploy'];
const FILES = ['vite.config.mjs', 'build.js'];

// The one place they are allowed.
const EXEMPT = new Set(['shared/config.mjs']);

const PATTERNS = [
    { what: 'a port', pattern: /\b(5000|5173|5174)\b/ },
    { what: 'an address', pattern: /(localhost|127\.0\.0\.1|lowexpectations\.zone)/i }
];

function walk(dir, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            walk(full, found);
        } else if (/\.(js|mjs|sh|conf|template|service|timer)$/.test(entry.name)) {
            found.push(full);
        }
    }

    return found;
}

const isCommentLine = line => {
    const trimmed = line.trim();

    // JS, C-style, and SHELL/NGINX/SYSTEMD — the deployment files explain these
    // values in prose too, and '#' is their comment marker.
    return trimmed.startsWith('//')
        || trimmed.startsWith('*')
        || trimmed.startsWith('/*')
        || trimmed.startsWith('#');
};

function main() {
    const files = [];

    for (const dir of DIRECTORIES) walk(path.join(ROOT, dir), files);

    for (const file of FILES) {
        const full = path.join(ROOT, file);
        if (fs.existsSync(full)) files.push(full);
    }

    const problems = [];

    for (const file of files) {
        const relative = path.relative(ROOT, file).split(path.sep).join('/');

        if (EXEMPT.has(relative)) continue;

        const lines = fs.readFileSync(file, 'utf8').split('\n');

        lines.forEach((line, index) => {
            if (isCommentLine(line)) return;

            for (const { what, pattern } of PATTERNS) {
                if (pattern.test(line)) {
                    problems.push({
                        where: `${relative}:${index + 1}`,
                        what,
                        line: line.trim()
                    });
                    break;
                }
            }
        });
    }

    console.log(`  files scanned : ${files.length - EXEMPT.size}`);
    console.log(`  the one place : shared/config.mjs`);

    if (problems.length === 0) {
        console.log('\n  PASS — every port and address is defined in shared/config.mjs\n');
        process.exit(0);
    }

    console.log('');

    for (const problem of problems) {
        console.log(`  FAIL : ${problem.where} — ${problem.what}`);
        console.log(`         ${problem.line}`);
    }

    console.log(`\n  FAILED — ${problems.length} hardwired value(s). Move them to shared/config.mjs.\n`);
    process.exit(1);
}

main();
