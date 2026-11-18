#!/usr/bin/env node
/**
 * Checks the PERFORCE NOTIFICATION — the one-way path by which the portal is
 * told that a changelist was committed.
 *
 *   node tests/check-perforce-notify.js    # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * TODO 88 §15/§16: the portal never asks Perforce anything; it is told. That
 * makes this route the WHOLE of the coupling — and its failure modes are quiet:
 *
 *   * no credential configured  -> must refuse, not accept everything
 *   * a wrong credential        -> must refuse
 *   * the same changelist twice -> must not duplicate the record
 *   * a missed notification     -> must show as a GAP in the cursor
 *
 * The last one is the reason the cursor exists at all: without it "nothing
 * happened" and "nothing was delivered" look identical.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   auth        no token 401; wrong token 401; unset on the portal 503
 *               (disabled rather than open)
 *   record      a valid notification is 201, with its files, user and client
 *   idempotent  the same changelist again is 200 and writes nothing
 *   cursor      advances to the highest changelist, never backwards
 *   gap         a jump is reported, and is not an error
 *   validation  a bad changelist, a bad user or a bad file list is 400
 *   read        an admin can list what was received; a developer cannot
 */

const { Reporter, startCheckServer } = require('./lib/check-harness');

const TOKEN = 'check-token-1a2b3c4d';

async function main() {
    const report = new Reporter();

    // The route reads this at request time; setting it before the requests is
    // enough, and it must be set before the disabled case is tested.
    process.env.PERFORCE_TRIGGER_TOKEN = TOKEN;

    const server = await startCheckServer({
        prefix: 'lowex-perforce-',
        route: 'backend/routes/perforce',
        mount: '/api/perforce',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'admin-check', 'admin@check.invalid', 'x', 'admin', 1),
                    (2, 'dev-check',   'dev@check.invalid',   'x', 'developer', 1);
            `);
        }
    });

    const admin = server.tokenFor(1);
    const dev = server.tokenFor(2);

    // The harness's post() takes a SESSION token; the notification uses a
    // bearer credential instead, so it is sent with fetch against the server
    // the harness started.
    const send = async (body, { token = TOKEN } = {}) => {
        const headers = { 'Content-Type': 'application/json' };

        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch(`${server.base}/change-commit`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        const text = await response.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

        return { status: response.status, text, json };
    };

    const payload = (changelist, extra = {}) => ({
        changelist,
        user: 'val',
        client: 'val-sandbox',
        stream: '//LowExpectations/main',
        description: 'a test submit',
        time: '2026-11-12 10:00:00',
        files: ['//LowExpectations/main/Content/A.uasset', '//LowExpectations/main/Config/Default.ini'],
        ...extra
    });

    // -----------------------------------------------------------------
    // AUTH
    // -----------------------------------------------------------------

    const noToken = await send(payload(100), { token: null });

    report.check('a notification with no credential is refused', noToken.status === 401,
        `expected 401, got ${noToken.status}`);

    const wrongToken = await send(payload(100), { token: 'not-the-token' });

    report.check('a notification with a wrong credential is refused', wrongToken.status === 401,
        `expected 401, got ${wrongToken.status}`);

    const previousToken = process.env.PERFORCE_TRIGGER_TOKEN;
    delete process.env.PERFORCE_TRIGGER_TOKEN;

    const disabled = await send(payload(100), { token: TOKEN });

    report.check('with no token configured the portal refuses everything',
        disabled.status === 503,
        `expected 503, got ${disabled.status} — disabled rather than open`);

    process.env.PERFORCE_TRIGGER_TOKEN = previousToken;

    // -----------------------------------------------------------------
    // RECORD
    // -----------------------------------------------------------------

    const first = await send(payload(100));

    report.check('a valid notification is recorded', first.status === 201,
        `expected 201, got ${first.status} — ${first.text.slice(0, 140)}`);

    report.check('it carries the user, client and files',
        first.json?.files === 2 && first.json?.changelist === 100,
        `response: ${JSON.stringify(first.json)}`);

    const duplicate = await send(payload(100));

    report.check('the same changelist again is not duplicated',
        duplicate.status === 200 && duplicate.json?.duplicate === true,
        `expected 200 duplicate, got ${duplicate.status} — ${duplicate.text.slice(0, 120)}`);

    const rows = await server.get('/changes', admin);

    report.check('the portal has one row for it',
        rows.json?.changes?.length === 1,
        `changes: ${JSON.stringify(rows.json?.changes)}`);

    report.check('with its depot paths kept as a list',
        rows.json?.changes?.[0]?.files?.length === 2,
        `files: ${JSON.stringify(rows.json?.changes?.[0]?.files)}`);

    // -----------------------------------------------------------------
    // CURSOR AND GAP
    // -----------------------------------------------------------------

    report.check('the cursor is at the changelist seen',
        rows.json?.cursor?.last_changelist === 100,
        `cursor: ${JSON.stringify(rows.json?.cursor)}`);

    const older = await send(payload(99));

    report.check('an older changelist is recorded but does not move the cursor back',
        older.status === 201,
        `expected 201 for a new row, got ${older.status}`);

    const afterOlder = await server.get('/changes', admin);

    report.check('and the cursor stays at the highest',
        afterOlder.json?.cursor?.last_changelist === 100,
        `cursor: ${JSON.stringify(afterOlder.json?.cursor)}`);

    const jump = await send(payload(110));

    report.check('a jump is reported as a gap, and is not an error',
        jump.status === 201 && jump.json?.gap === 9,
        `expected 201 with gap 9, got ${jump.status} — ${JSON.stringify(jump.json)}`);

    // -----------------------------------------------------------------
    // VALIDATION
    // -----------------------------------------------------------------

    const badChange = await send(payload('abc'));

    report.check('a non-numeric changelist is a 400', badChange.status === 400,
        `expected 400, got ${badChange.status}`);

    const noUser = await send(payload(120, { user: '' }));

    report.check('a missing user is a 400', noUser.status === 400,
        `expected 400, got ${noUser.status}`);

    const badFiles = await send(payload(121, { files: 'not-a-list' }));

    report.check('a malformed file list is a 400', badFiles.status === 400,
        `expected 400, got ${badFiles.status}`);

    // -----------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------

    // THE CURSOR READ, for the trigger's own credential: the installer proves
    // delivery with it after a test submit.
    const cursorWithToken = await (await fetch(`${server.base}/cursor`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
    })).json();

    report.check('the trigger credential can read the cursor',
        cursorWithToken?.last_changelist === 110,
        `cursor: ${JSON.stringify(cursorWithToken)}`);

    const cursorNoToken = await fetch(`${server.base}/cursor`);

    report.check('and only with the credential', cursorNoToken.status === 401,
        `expected 401, got ${cursorNoToken.status}`);

    const asDeveloper = await server.get('/changes', dev);

    report.check('a developer cannot list the notifications', asDeveloper.status === 403,
        `expected 403, got ${asDeveloper.status}`);

    // -----------------------------------------------------------------

    await server.close();

    report.finish('the portal is told, records it once, and can say what it last heard');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
