#!/usr/bin/env node
/**
 * Checks BUG REPORTS AND SUGGESTIONS over HTTP.
 *
 *   node tests/check-feedback.js      # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * It is the only write path that accepts a POST from somebody who is not
 * signed in, which makes it the only one where the identity in the row cannot
 * be taken from a session — and the one an anonymous reporter most needs.
 *
 * There was no check for it at all. The manual tells people to use it; the
 * admin page reads it.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   report     anonymous: accepted, recorded with no user       201
 *              signed in: recorded with the SESSION's identity,
 *              even when the body claims somebody else
 *              missing message                                  400, by field
 *              an unknown kind                                  400
 *
 *   read       a developer cannot list them                     403
 *              an administrator can, with counts               200
 *              an unknown status filter                        400
 *
 *   resolve    a developer cannot                                403
 *              an administrator can, with a note               200
 *              the row records who and what
 *              the audit log records it
 *              resolving again changes nothing                 200, changed:false
 *              an unknown report                                404
 */

const { Reporter, startCheckServer, Database } = require('./lib/check-harness');

async function main() {
    const report = new Reporter();

    const server = await startCheckServer({
        prefix: 'lowex-feedback-',
        route: 'backend/routes/feedback',
        mount: '/api/feedback',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'admin-check', 'admin@check.invalid', 'x', 'admin',     1),
                    (2, 'dev-check',   'dev@check.invalid',   'x', 'developer', 1);
            `);
        }
    });

    const admin = server.tokenFor(1);
    const dev = server.tokenFor(2);

    const db = new Database(server.dbPath, { readonly: true });

    // -----------------------------------------------------------------
    // REPORTING
    // -----------------------------------------------------------------

    const anonymous = await server.post('/', {
        kind: 'bug',
        message: 'The bin button does nothing on the discussion page.',
        page_url: '/discussion.html'
    });

    report.check('an anonymous report is accepted',
        anonymous.status === 201 && anonymous.json?.signed_in === false,
        `expected 201 anonymous, got ${anonymous.status} — ${anonymous.text.slice(0, 160)}`);

    const anonymousRow = db.prepare('SELECT * FROM feedback WHERE id = ?')
        .get(anonymous.json?.id);

    report.check('and is recorded without a person',
        anonymousRow && anonymousRow.user_id === null
        && anonymousRow.username === null,
        `row: ${JSON.stringify(anonymousRow)}`);

    // THE BODY IS NOT THE IDENTITY. A signed-in report that claims to be
    // somebody else must still be recorded as the session.
    const signedIn = await server.post('/', {
        kind: 'idea',
        message: 'A way to compare two versions side by side.',
        username: 'admin-check',
        role: 'admin',
        user_id: 1
    }, dev);

    report.check('a signed-in report is accepted',
        signedIn.status === 201 && signedIn.json?.signed_in === true,
        `expected 201 signed in, got ${signedIn.status}`);

    const signedRow = db.prepare('SELECT * FROM feedback WHERE id = ?')
        .get(signedIn.json?.id);

    report.check('and records the SESSION, not the body',
        signedRow?.user_id === 2 && signedRow?.username === 'dev-check'
        && signedRow?.role === 'developer',
        `row: ${JSON.stringify(signedRow)}`);

    const missing = await server.post('/', { kind: 'bug' });

    report.check('a report with no message is refused by field',
        missing.status === 400 && Boolean(missing.json?.errors?.message),
        `expected 400 with errors.message, got ${missing.status} — ${missing.text.slice(0, 160)}`);

    const badKind = await server.post('/', {
        kind: 'complaint', message: 'something'
    });

    report.check('an unknown kind is refused',
        badKind.status === 400 && Boolean(badKind.json?.errors?.kind),
        `expected 400 with errors.kind, got ${badKind.status}`);

    // -----------------------------------------------------------------
    // READING
    // -----------------------------------------------------------------

    const devList = await server.get('/', dev);

    report.check('a developer cannot list reports', devList.status === 403,
        `expected 403, got ${devList.status}`);

    const list = await server.get('/', admin);

    report.check('an administrator can', list.status === 200
        && Array.isArray(list.json?.reports),
        `expected 200, got ${list.status}`);

    report.check('with the counts', list.status === 200
        && list.json?.counts?.open >= 2,
        `counts: ${JSON.stringify(list.json?.counts)}`);

    const badStatus = await server.get('/?status=whatever', admin);

    report.check('an unknown status filter is refused', badStatus.status === 400,
        `expected 400, got ${badStatus.status}`);

    // -----------------------------------------------------------------
    // RESOLVING
    // -----------------------------------------------------------------

    const id = anonymous.json?.id;

    const devResolve = await server.post(`/${id}/resolve`,
        { resolution_note: 'mine now' }, dev);

    report.check('a developer cannot resolve a report', devResolve.status === 403,
        `expected 403, got ${devResolve.status}`);

    const note = 'Stale build; the button is there in the current one.';

    const resolved = await server.post(`/${id}/resolve`,
        { resolution_note: note }, admin);

    report.check('an administrator can', resolved.status === 200
        && resolved.json?.status === 'resolved',
        `expected 200 resolved, got ${resolved.status} — ${resolved.text.slice(0, 160)}`);

    const resolvedRow = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);

    report.check('and the row records who and why',
        resolvedRow?.status === 'resolved'
        && resolvedRow?.resolution_note === note
        && resolvedRow?.resolved_by === 1,
        `row: ${JSON.stringify(resolvedRow)}`);

    const resolveAudit = db.prepare(`
        SELECT * FROM audit_logs
        WHERE action = 'feedback.resolve' AND actor_id = 1
        ORDER BY id DESC LIMIT 1
    `).get();

    report.check('and it is audited', Boolean(resolveAudit),
        'no feedback.resolve row was written');

    const again = await server.post(`/${id}/resolve`,
        { resolution_note: 'again' }, admin);

    report.check('resolving twice changes nothing',
        again.status === 200 && again.json?.changed === false,
        `expected 200 changed:false, got ${again.status} — ${again.text.slice(0, 120)}`);

    const unknown = await server.post('/99999/resolve', {}, admin);

    report.check('an unknown report is not found', unknown.status === 404,
        `expected 404, got ${unknown.status}`);

    await server.close();
    report.finish('reports are accepted from anyone, read by administrators, and resolved with a record.');
}

main().catch(err => {
    console.error('\n  FAIL — the check could not run:', err.message, '\n');
    process.exit(1);
});
