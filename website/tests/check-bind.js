#!/usr/bin/env node
/**
 * Checks WHERE THE SERVER LISTENS — loopback, not every interface.
 *
 *   node tests/check-bind.js         # exit 0 = clean
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * `app.listen(PORT)` with no address binds EVERY INTERFACE, and it did for
 * months while `.env` carried `HOST=localhost` — a value that looked like it
 * stopped that and did nothing (TODO 44). The failure is invisible: the portal
 * works perfectly, on every address the machine has, including the ones facing
 * the network, over plain HTTP, around the proxy and its TLS.
 *
 * It is one argument on one line, so nothing else in the suite would notice it
 * going missing. This starts the real server and looks.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   1. the server starts at all, which no other check in the suite does
 *   2. it answers on 127.0.0.1 — loopback is reachable to the machine
 *   3. its own startup line says it bound 127.0.0.1, so the DEFAULT is the
 *      loopback address and not something that merely happens to work here
 *   4. IF THE MACHINE HAS A NON-LOOPBACK IPv4 ADDRESS, that address refuses the
 *      connection — which is the property that matters, tested directly rather
 *      than inferred
 *
 * Point 4 is skipped on a machine with no other address, and says so. Point 3
 * is the backstop that still catches a wildcard bind in that case.
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * The REAL backend, spawned as a child process with a throwaway database and
 * throwaway directories (DB_PATH, STORE_DIR, TMP_DIR, THUMB_DIR), on a port the
 * operating system chooses. BIND is REMOVED from the child's environment on
 * purpose: the default is what is being tested.
 *
 * It does not test BIND=0.0.0.0 as a negative control, because that would mean
 * briefly running a server on every interface — the exact thing this check is
 * about.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const { Reporter, copySchema, Database } = require('./lib/check-harness');

const ROOT = path.join(__dirname, '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once('error', reject);

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function nonLoopbackAddresses() {
    const found = [];

    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) {
                found.push(address.address);
            }
        }
    }

    return found;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const report = new Reporter();

    if (!process.env.JWT_SECRET) {
        console.error('\n  FAIL — JWT_SECRET is not set; the server refuses to start without it\n');
        process.exit(1);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lowex-bind-'));
    const dbPath = path.join(tmp, 'database.db');
    const dirs = {
        blobs: path.join(tmp, 'files'),
        temp: path.join(tmp, 'tmp'),
        thumbs: path.join(tmp, 'thumbs')
    };

    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    copySchema(db);
    db.close();

    const port = await freePort();

    const env = {
        ...process.env,
        DB_PATH: dbPath,
        STORE_DIR: dirs.blobs,
        TMP_DIR: dirs.temp,
        THUMB_DIR: dirs.thumbs,
        PORT: String(port),
        PUBLIC_URL: `http://localhost:${port}`
    };

    // THE DEFAULT IS WHAT IS UNDER TEST.
    delete env.BIND;

    const child = spawn(process.execPath, [path.join(ROOT, 'backend/server.js')], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    const cleanup = async () => {
        child.kill('SIGTERM');
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
            setTimeout(resolve, 3000);
        });
        fs.rmSync(tmp, { recursive: true, force: true });
    };

    // -----------------------------------------------------------------
    // Wait for the socket to answer, whatever it answers with — any HTTP
    // response means the server is listening, and the content is not what
    // this check is about.
    // -----------------------------------------------------------------

    let answered = false;

    for (let attempt = 0; attempt < 60 && !answered; attempt++) {
        try {
            await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
            answered = true;
        } catch {
            await sleep(250);
        }
    }

    report.check('the server starts and answers on loopback', answered,
        `nothing answered on 127.0.0.1:${port}\n           output: ${output.slice(-400)}`);

    report.check('it says it bound the loopback address',
        /Server running on 127\.0\.0\.1:/.test(output),
        `the startup line was: ${(output.match(/Server running on .*/) || ['(none)'])[0]}`);

    // -----------------------------------------------------------------
    // The property, tested directly when this machine has another address.
    // -----------------------------------------------------------------

    const others = nonLoopbackAddresses();

    if (others.length === 0) {
        console.log('  note   : no non-loopback IPv4 address on this machine — the direct test is skipped');
    } else {
        for (const address of others) {
            let reached = false;

            try {
                await fetch(`http://${address}:${port}/`, { signal: AbortSignal.timeout(1500) });
                reached = true;
            } catch {
                // Refused, unreachable or timed out — all mean "not served".
            }

            report.check(`the server is not reachable on ${address}`, !reached,
                `${address}:${port} answered — the server is bound to more than loopback`);
        }
    }

    // -----------------------------------------------------------------

    await cleanup();

    report.finish('the server listens on loopback only, and says so');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
