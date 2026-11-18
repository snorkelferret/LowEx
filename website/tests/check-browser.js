#!/usr/bin/env node
/**
 * Checks the DESTINATION FLOW IN A BROWSER.
 *
 *   npm run build && npm run check:browser      # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE IS SEPARATE, AND OPT-IN
 * ============================================================
 *
 * Every other check asks the server a question over HTTP. This one asks the
 * BROWSER to do something and then asks what happened: does the dialog open,
 * does the game option exist, does the refusal reach the person, does the
 * dialog close after a submission that finished while it was still opening.
 *
 * That needs a browser, which is not part of the repository, and the built
 * pages, which are not either. So it is NOT in `npm run check`. It says what
 * is missing and fails rather than skipping: a check that reports PASS without
 * running is worse than one that is not there.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   developer  the workspace renders with a seeded, unlocked version
 *              Submit opens the destination dialog
 *              the game option is enabled because there is an exchange file
 *              the streams Perforce told the portal are offered
 *              a game submit is refused, IN THE DIALOG, for want of a receipt
 *              after a receipt exists the dialog preselects the game version
 *              and shows where it was tested
 *              submitting closes the dialog even when the click beats the
 *              opening transition
 *              the version then reads as under review
 *
 *   production the queue shows the destination and the receipt
 *              retargeting to an untested stream is refused in the page
 *              retargeting to the library, and back, is allowed
 *              approving works, and the store row names both people
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * The REAL backend is spawned with a throwaway database and directories, the
 * same way check-bind does it, and the BUILT pages are served from
 * frontend/dist. Headless Chrome is driven over the DevTools Protocol with
 * tests/lib/browser.js — no test framework, no Playwright.
 *
 * The version is SEEDED rather than uploaded: check:upload owns the upload
 * route, and a directory input is exactly what a remote-controlled browser
 * cannot fill (Chrome refuses files on a webkitdirectory input).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { Reporter, copySchema, Database } = require('./lib/check-harness');
const { findChrome, freePort, launchBrowser, attach } = require('./lib/browser');
const { manifestHash } = require('../backend/lib/manifestHash');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'frontend/dist');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const shaOf = label => require('crypto')
    .createHash('sha256')
    .update(`check-browser:${label}`)
    .digest('hex');

function requirePrerequisites(report) {
    const chrome = findChrome();

    if (!chrome) {
        console.error(
            '\n  FAIL — no Chrome or Chromium on PATH.\n' +
            '         This check drives a real browser and is opt-in for that reason.\n'
        );
        process.exit(1);
    }

    if (!fs.existsSync(path.join(DIST, 'devDashboard.html'))
        || !fs.existsSync(path.join(DIST, 'prodDashboard.html'))) {
        console.error(
            '\n  FAIL — the built pages are missing.\n' +
            '         Run `npm run build` first; this check serves frontend/dist.\n'
        );
        process.exit(1);
    }

    if (!process.env.JWT_SECRET) {
        console.error('\n  FAIL — JWT_SECRET is not set\n');
        process.exit(1);
    }

    return chrome;
}

async function main() {
    const report = new Reporter();
    const chrome = requirePrerequisites(report);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lowex-browser-check-'));
    const dbPath = path.join(tmp, 'database.db');
    const dirs = {
        blobs: path.join(tmp, 'files'),
        temp: path.join(tmp, 'tmp'),
        thumbs: path.join(tmp, 'thumbs')
    };

    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

    // -----------------------------------------------------------------
    // The world
    // -----------------------------------------------------------------

    const FBX = shaOf('tree-fbx');
    const PNG = shaOf('bark-png');

    const FBX_BYTES = Buffer.concat([
        Buffer.from('Kaydara FBX Binary  \x00\x1a\x00', 'binary'),
        Buffer.alloc(4096)
    ]);
    const PNG_BYTES = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
    );

    fs.writeFileSync(path.join(dirs.blobs, FBX), FBX_BYTES);
    fs.writeFileSync(path.join(dirs.blobs, PNG), PNG_BYTES);

    const MANIFEST = manifestHash([
        { relative_path: 'BrowserTree_v01/models', filename: 'tree.fbx', sha256: FBX, size: FBX_BYTES.length },
        { relative_path: 'BrowserTree_v01/textures', filename: 'bark.png', sha256: PNG, size: PNG_BYTES.length }
    ]);

    const KEY = `lxk_${'d'.repeat(40)}`;
    const KEY_HASH = require('crypto').createHash('sha256').update(KEY).digest('hex');

    const db = new Database(dbPath);
    copySchema(db);

    db.exec(`
        INSERT INTO users (id, username, email, password_hash, role, is_active)
        VALUES
            (1, 'val',  'val@check.invalid',  'x', 'developer', 1),
            (2, 'prod', 'prod@check.invalid', 'x', 'prod',      1);

        INSERT INTO developer_workspaces (id, developer_id) VALUES (1, 1);

        INSERT INTO workspace_assets
            (id, workspace_id, name, asset_type, category, description)
        VALUES (1, 1, 'BrowserTree', 'Model', 'Environment', 'a tree');

        INSERT INTO stored_files (id, sha256, storage_key, file_size)
        VALUES
            (1, '${FBX}', '${FBX}', ${FBX_BYTES.length}),
            (2, '${PNG}', '${PNG}', ${PNG_BYTES.length});

        INSERT INTO workspace_versions
            (id, workspace_asset_id, version_number, created_by, version_note, manifest_hash)
        VALUES (1, 1, 1, 1, 'ready for review', '${MANIFEST}');

        INSERT INTO workspace_version_files
            (workspace_version_id, stored_file_id, filename, relative_path)
        VALUES
            (1, 1, 'tree.fbx', 'BrowserTree_v01/models'),
            (1, 2, 'bark.png', 'BrowserTree_v01/textures');

        INSERT INTO technical_check_runs
            (workspace_asset_id, workspace_version_id, status, manifest_hash, completed_at)
        VALUES (1, 1, 'passed', '${MANIFEST}', CURRENT_TIMESTAMP);

        INSERT INTO perforce_changes
            (changelist, username, client, stream, description, submitted_at, files)
        VALUES
            (7, 'val', 'val-main', '//LowExpectations/main', 'a commit', '2026-11-18 10:00:00', '[]'),
            (8, 'val', 'val-exp',  '//LowExpectations/exp',  'another',  '2026-11-18 10:05:00', '[]');

        INSERT INTO api_keys (name, key_prefix, key_hash)
        VALUES ('browser-check', '${KEY.slice(0, 12)}', '${KEY_HASH}');

        INSERT INTO app_settings (key, value)
        VALUES ('integration_tooling', '1');
    `);

    db.close();

    // -----------------------------------------------------------------
    // The server
    // -----------------------------------------------------------------

    const port = await freePort();

    const server = spawn(process.execPath, [path.join(ROOT, 'backend/server.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            DB_PATH: dbPath,
            STORE_DIR: dirs.blobs,
            TMP_DIR: dirs.temp,
            THUMB_DIR: dirs.thumbs,
            PORT: String(port),
            PUBLIC_URL: `http://localhost:${port}`,
            CLIENT_URL: `http://localhost:${port}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let serverOutput = '';
    server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
    server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

    const base = `http://localhost:${port}`;

    let browser = null;
    let cdp = null;

    const cleanup = async () => {
        try { cdp?.ws.close(); } catch { /* gone */ }
        if (browser) await browser.close();
        server.kill('SIGTERM');
        await new Promise(resolve => {
            if (server.exitCode !== null) return resolve();
            server.once('exit', resolve);
            setTimeout(resolve, 3000);
        });
        fs.rmSync(tmp, { recursive: true, force: true });
    };

    try {
        // Ready when any HTTP answer comes back. The pages are static; the
        // API is what the page calls next.
        let up = false;

        for (let attempt = 0; attempt < 60 && !up; attempt++) {
            try {
                await fetch(`${base}/shopfront.html`, { signal: AbortSignal.timeout(1000) });
                up = true;
            } catch {
                await sleep(250);
            }
        }

        report.check('the portal starts and serves the built pages', up,
            `nothing answered on ${base}\n           ${serverOutput.slice(-400)}`);

        // -----------------------------------------------------------------
        // The browser
        // -----------------------------------------------------------------

        browser = await launchBrowser({ chrome });
        cdp = await attach(browser.port);

        const jwt = require('jsonwebtoken');

        const signIn = async (user) => {
            const token = jwt.sign(
                { sub: user.id, username: user.username, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: '1h' }
            );

            await cdp.send('Network.setCookie', {
                name: 'token', value: token, url: `${base}/`,
                httpOnly: true, sameSite: 'Lax'
            });

            await cdp.send('Page.navigate', { url: `${base}/shopfront.html` });
            await cdp.waitFor(`document.readyState === 'complete'`, 15000, 'sign-in page');

            await cdp.evaluate(
                `localStorage.setItem('user_info', ${JSON.stringify(JSON.stringify(user))})`
            );
        };

        await signIn({ id: 1, username: 'val', role: 'developer' });

        await cdp.send('Page.navigate', { url: `${base}/devDashboard.html` });
        await cdp.waitFor(`document.body.innerText.includes('BrowserTree')`, 20000,
            'the developer workspace');

        // -----------------------------------------------------------------
        // The dialog
        // -----------------------------------------------------------------

        const clicked = await cdp.evaluate(`(() => {
            const item = [...document.querySelectorAll('.accordion-item')]
                .find(el => el.innerText.includes('BrowserTree'));
            if (!item) return 'no asset card';
            const button = [...item.querySelectorAll('button')]
                .find(b => b.textContent.trim() === 'Submit for approval');
            if (!button) return 'no submit button';
            button.click();
            return 'clicked';
        })()`);

        report.check('the seeded version offers Submit', clicked === 'clicked',
            clicked);

        await cdp.waitFor(
            `document.getElementById('destinationModal')?.classList.contains('show')`,
            30000, 'the destination dialog'
        );

        const dialog = await cdp.evaluate(`({
            gameDisabled: document.getElementById('destinationGame').disabled,
            streams: [...document.getElementById('destinationStream').options].map(o => o.value),
            receipt: document.getElementById('destinationReceipt').textContent.trim()
        })`);

        report.check('the game option is enabled — the version has an exchange file',
            dialog.gameDisabled === false,
            `gameDisabled: ${dialog.gameDisabled}`);

        report.check('the streams Perforce named are offered',
            dialog.streams.includes('//LowExpectations/main')
            && dialog.streams.includes('//LowExpectations/exp'),
            `streams: ${JSON.stringify(dialog.streams)}`);

        report.check('and it says there is no receipt yet',
            /No test receipt/.test(dialog.receipt),
            `receipt: ${dialog.receipt}`);

        // A GAME SUBMIT WITHOUT EVIDENCE IS REFUSED IN THE DIALOG.
        await cdp.evaluate(`(() => {
            const game = document.getElementById('destinationGame');
            game.checked = true;
            game.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('destinationStream').value = '//LowExpectations/main';
            document.getElementById('destinationSubmit').click();
        })()`);

        await cdp.waitFor(
            `!document.getElementById('destinationAlert').classList.contains('d-none')`,
            15000, 'the refusal'
        );

        const refusal = await cdp.evaluate(
            `document.getElementById('destinationAlert').textContent.trim()`
        );

        report.check('a game submit without a receipt is refused, in the dialog',
            /No passing test in \/\/LowExpectations\/main/.test(refusal),
            `alert: ${refusal}`);

        // -----------------------------------------------------------------
        // A receipt, as the editor tool posts it
        // -----------------------------------------------------------------

        const receipt = await fetch(`${base}/api/integration/receipts`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                workspace_version_id: 1,
                changelist: 7,
                stream: '//LowExpectations/task-val-1',
                parent_stream: '//LowExpectations/main',
                levels: ['/Game/Levels/LE_Forest_01'],
                exchange_filename: 'tree.fbx',
                exchange_sha256: FBX,
                result: 'passed',
                p4_user: 'val',
                editor_build: 'browser check'
            })
        });

        report.check('the tool can post a receipt', receipt.status === 201,
            `expected 201, got ${receipt.status} — ${(await receipt.text()).slice(0, 200)}`);

        // Reload so the version carries its receipt, then submit for real.
        await cdp.send('Page.navigate', { url: `${base}/devDashboard.html` });
        await cdp.waitFor(`document.body.innerText.includes('BrowserTree')`, 20000,
            'the workspace again');

        await cdp.evaluate(`(() => {
            const item = [...document.querySelectorAll('.accordion-item')]
                .find(el => el.innerText.includes('BrowserTree'));
            [...item.querySelectorAll('button')]
                .find(b => b.textContent.trim() === 'Submit for approval').click();
        })()`);

        await cdp.waitFor(
            `document.getElementById('destinationModal')?.classList.contains('show')`,
            30000, 'the dialog again'
        );

        const preselected = await cdp.evaluate(`({
            gameChecked: document.getElementById('destinationGame').checked,
            stream: document.getElementById('destinationStream').value,
            receipt: document.getElementById('destinationReceipt').textContent.trim()
        })`);

        report.check('a passing receipt preselects its game version',
            preselected.gameChecked === true
            && preselected.stream === '//LowExpectations/main',
            `state: ${JSON.stringify(preselected)}`);

        report.check('and says where it was tested',
            /changelist 7/.test(preselected.receipt)
            && /LE_Forest_01/.test(preselected.receipt),
            `receipt: ${preselected.receipt}`);

        // CLICK IMMEDIATELY — inside the opening transition. This is the case
        // that once left the dialog open over a completed submission.
        await cdp.evaluate(`document.getElementById('destinationSubmit').click()`);

        await cdp.waitFor(
            `!document.getElementById('destinationModal').classList.contains('show')`,
            20000, 'the dialog to close'
        );

        report.check('submitting closes the dialog, even inside the opening transition',
            await cdp.evaluate(
                `!document.getElementById('destinationModal').classList.contains('show')`
            ));

        await cdp.waitFor(
            `document.body.textContent.includes('Under review')`,
            15000, 'the version to read as under review'
        );

        report.check('and the version reads as under review', true);

        // -----------------------------------------------------------------
        // Production
        // -----------------------------------------------------------------

        await signIn({ id: 2, username: 'prod', role: 'prod' });

        await cdp.send('Page.navigate', { url: `${base}/prodDashboard.html` });
        await cdp.waitFor(`document.getElementById('prodQueue')?.innerText.includes('BrowserTree')`,
            20000, 'the production queue');

        const queue = await cdp.evaluate(
            `document.getElementById('prodQueue').innerText.replace(/\\s+/g, ' ')`
        );

        report.check('the queue shows the destination', /Game: \/\/LowExpectations\/main/.test(queue),
            queue.slice(0, 300));

        report.check('and the receipt, with where it was tested',
            /Tested in \/\/LowExpectations\/main at CL 7/.test(queue),
            queue.slice(0, 300));

        const retarget = async (stream) => {
            await cdp.evaluate(`(() => {
                const select = document.querySelector('#prodQueue select');
                select.value = ${JSON.stringify(stream)};
                select.closest('td').querySelector('button[data-destination]').click();
            })()`);

            await sleep(800);

            return cdp.evaluate(`document.getElementById('prodAlert')?.innerText.trim()`);
        };

        const refused = await retarget('//LowExpectations/exp');

        report.check('production cannot retarget to an untested game version',
            /No passing test in \/\/LowExpectations\/exp/.test(refused),
            `alert: ${refused}`);

        const toLibrary = await retarget('library');

        report.check('retargeting to the library is allowed',
            /Destination changed to the library/.test(toLibrary),
            `alert: ${toLibrary}`);

        const back = await retarget('//LowExpectations/main');

        report.check('and back to the tested version',
            /Destination changed to \/\/LowExpectations\/main/.test(back),
            `alert: ${back}`);

        // Approve. The page asks for confirmation; accept it for the check.
        await cdp.evaluate(`window.confirm = () => true`);
        await cdp.evaluate(
            `document.querySelector('#prodQueue button[data-decision="approve"]').click()`
        );

        await cdp.waitFor(
            `/Approved/.test(document.getElementById('prodAlert')?.innerText || '')`,
            15000, 'the approval'
        );

        report.check('approving works from the queue', true);

        // -----------------------------------------------------------------
        // What the server holds afterwards
        // -----------------------------------------------------------------

        const after = new Database(dbPath, { readonly: true });

        const approval = after.prepare(`
            SELECT status, destination_kind, destination_stream, destination_source
            FROM creative_approvals ORDER BY id DESC LIMIT 1
        `).get();

        report.check('the approval records the game destination',
            approval?.status === 'approved'
            && approval?.destination_kind === 'game'
            && approval?.destination_stream === '//LowExpectations/main'
            && approval?.destination_source === 'prod',
            `approval: ${JSON.stringify(approval)}`);

        const store = after.prepare(`
            SELECT av.created_by, av.uploaded_by, av.manifest_hash
            FROM asset_versions av ORDER BY av.id DESC LIMIT 1
        `).get();

        report.check('and the store version names both people',
            store?.created_by === 2 && store?.uploaded_by === 1
            && store?.manifest_hash === MANIFEST,
            `store: ${JSON.stringify(store)}`);

        after.close();

        await cleanup();
        report.finish('the destination flow works in a real browser.');

    } catch (err) {
        // A SCREENSHOT IS WORTH MORE THAN A STACK TRACE when a page is what
        // failed. It is left on disk and its path printed.
        try {
            if (cdp) {
                const file = path.join(os.tmpdir(), 'lowex-browser-check-failure.png');
                await cdp.screenshot(file);
                console.error(`\n  screenshot: ${file}`);
            }
        } catch {
            // no page, no picture
        }

        await cleanup();
        throw err;
    }
}

main().catch(err => {
    console.error('\n  FAIL — the browser check could not complete:', err.message, '\n');
    process.exit(1);
});
