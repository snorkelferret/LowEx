// tests/lib/browser.js
//
// A HEADLESS BROWSER, FOR THE ONE CHECK THAT NEEDS ONE.
//
// ============================================================
// WHY THIS IS NOT PLAYWRIGHT
// ============================================================
//
// The suite has no test framework and no runtime dependency it does not need.
// Adding Playwright would bring a browser download, a versioned protocol
// client and a second way to wait for a page into a project whose whole check
// style is "a script that prints PASS".
//
// Chrome can be driven directly over the DevTools Protocol with what Node 22
// already has: child_process, fetch and a WebSocket. That is what this file is
// — a launcher, a small protocol client, and the four helpers the check uses.
//
// ============================================================
// IT IS OPT-IN FOR A REASON
// ============================================================
//
// This needs a browser that is not part of the repository, so it cannot run
// everywhere the rest of the suite runs. `npm run check:browser` says so
// plainly when Chrome is missing rather than pretending to pass.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const CANDIDATES = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome'
];

function findChrome() {
    const dirs = String(process.env.PATH || '').split(path.delimiter);

    for (const name of CANDIDATES) {
        for (const dir of dirs) {
            const full = path.join(dir, name);

            try {
                fs.accessSync(full, fs.constants.X_OK);
                return full;
            } catch {
                // try the next
            }
        }
    }

    return null;
}

// A port the OS says is free, released immediately. The race between closing
// this and binding it is small and the check is not run in parallel with
// itself; the alternative is a table of ports that go stale.
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForDebugger(port, timeout = 15000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return;
        } catch {
            // not up yet
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }

    throw new Error(`Chrome did not open its debugger on ${port}`);
}

/**
 * Launch headless Chrome with a throwaway profile.
 *
 * Returns { process, port, profileDir, close() }.
 */
async function launchBrowser({ chrome }) {
    const port = await freePort();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lowex-chrome-'));

    const child = spawn(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        'about:blank'
    ], { stdio: 'ignore' });

    await waitForDebugger(port);

    return {
        process: child,
        port,
        profileDir,
        async close() {
            try { child.kill('SIGKILL'); } catch { /* gone */ }

            // The profile holds a browser cache; leaving it behind is a slow
            // disk leak in /tmp and nothing else.
            try {
                fs.rmSync(profileDir, { recursive: true, force: true });
            } catch {
                // best effort
            }
        }
    };
}

class CDP {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.id = 0;
        this.pending = new Map();
    }

    open() {
        return new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = () => reject(new Error('Could not open the CDP socket'));
            this.ws.onmessage = event => {
                const message = JSON.parse(event.data);

                if (message.id && this.pending.has(message.id)) {
                    const { resolve, reject } = this.pending.get(message.id);
                    this.pending.delete(message.id);

                    if (message.error) reject(new Error(JSON.stringify(message.error)));
                    else resolve(message.result);
                }
            };
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));

        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });

        if (result.exceptionDetails) {
            throw new Error(
                result.exceptionDetails.exception?.description
                || result.exceptionDetails.text
                || 'evaluate failed'
            );
        }

        return result.result.value;
    }

    async waitFor(expression, timeout = 20000, label = expression) {
        const started = Date.now();

        while (Date.now() - started < timeout) {
            try {
                if (await this.evaluate(expression)) return;
            } catch {
                // the page may be navigating; ask again
            }

            await new Promise(resolve => setTimeout(resolve, 150));
        }

        throw new Error(`timed out waiting for ${label}`);
    }

    async screenshot(file) {
        const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
    }
}

/** Attach to the first page target and enable what the helpers use. */
async function attach(port) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    const page = targets.find(target => target.type === 'page');

    if (!page) throw new Error('Chrome has no page target');

    const cdp = new CDP(page.webSocketDebuggerUrl);

    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOM.enable');

    return cdp;
}

module.exports = {
    findChrome,
    freePort,
    launchBrowser,
    attach
};
