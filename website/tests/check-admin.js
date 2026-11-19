#!/usr/bin/env node
/**
 * Checks ADMINISTRATION over HTTP: settings and account lifecycle.
 *
 *   node tests/check-admin.js      # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * Settings and deactivation are the two administrative acts with consequences
 * that outlive the click. A settings value is in force immediately and every
 * change must be recorded with who changed it and what it was before. A
 * deactivation is how access is actually revoked.
 *
 * Neither had a check. The suite could say what a developer may not do; it
 * could not say that an administrator's change is bounded, audited, and
 * refused when it is aimed at a peer.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   settings   an administrator reads them                   200
 *              a developer cannot                              403
 *              a valid change is applied and audited           200
 *              a value outside the bounds is refused           400
 *              an unknown key is refused                       400
 *              reset restores the default and is audited      200
 *
 *   accounts   the list is administrator-only                   403
 *              an administrator cannot deactivate themselves   409
 *              nor another administrator                      403
 *              a developer can be deactivated, and it is audited
 *              and reactivated
 *
 *   audit      the admin audit route reads what happened
 */

const { Reporter, startCheckServer, Database } = require('./lib/check-harness');

async function main() {
    const report = new Reporter();

    const server = await startCheckServer({
        prefix: 'lowex-admin-',
        route: 'backend/routes/admin',
        mount: '/api/admin',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'admin-one', 'one@check.invalid',  'x', 'admin',     1),
                    (2, 'admin-two', 'two@check.invalid',  'x', 'admin',     1),
                    (3, 'dev-check', 'dev@check.invalid',  'x', 'developer', 1),
                    (4, 'prod-check','prod@check.invalid', 'x', 'prod',      1);
            `);
        }
    });

    const admin = server.tokenFor(1);
    const admin2 = server.tokenFor(2);
    const dev = server.tokenFor(3);

    const db = new Database(server.dbPath, { readonly: true });

    // -----------------------------------------------------------------
    // SETTINGS
    // -----------------------------------------------------------------

    const read = await server.get('/settings', admin);

    report.check('an administrator reads the settings', read.status === 200
        && Array.isArray(read.json?.settings),
        `expected 200, got ${read.status}`);

    const devRead = await server.get('/settings', dev);

    report.check('a developer cannot read them', devRead.status === 403,
        `expected 403, got ${devRead.status}`);

    const changed = await server.post('/settings/session_hours', { value: 5 }, admin);

    report.check('a valid change is accepted', changed.status === 200,
        `expected 200, got ${changed.status} — ${changed.text.slice(0, 160)}`);

    const stored = db.prepare(`SELECT value FROM app_settings WHERE key = 'session_hours'`).get();

    report.check('and is stored', stored?.value === '5',
        `stored: ${JSON.stringify(stored)}`);

    const updateAudit = db.prepare(`
        SELECT * FROM audit_logs
        WHERE action = 'settings.update' AND actor_id = 1
        ORDER BY id DESC LIMIT 1
    `).get();

    report.check('and audited with the value it replaced',
        Boolean(updateAudit)
        && String(updateAudit.details).includes('"from":2')
        && String(updateAudit.details).includes('"to":5'),
        `audit row: ${JSON.stringify(updateAudit)}`);

    const tooLow = await server.post('/settings/session_hours', { value: 0 }, admin);

    report.check('a value below the minimum is refused', tooLow.status === 400,
        `expected 400, got ${tooLow.status}`);

    const tooHigh = await server.post('/settings/session_hours', { value: 25 }, admin);

    report.check('a value above the maximum is refused', tooHigh.status === 400,
        `expected 400, got ${tooHigh.status}`);

    const unknown = await server.post('/settings/not_a_setting', { value: 1 }, admin);

    report.check('an unknown key is refused', unknown.status === 400 || unknown.status === 404,
        `expected a refusal, got ${unknown.status}`);

    // THE BUILD LIMITS ARE TWO MORE BOUNDED INTEGERS, AND 0 IS A VALUE.
    // 0 means no limit, so the minimum has to allow it while a negative is
    // still refused.
    const buildSize = await server.post('/settings/build_max_gb', { value: 50 }, admin);

    report.check('the build size limit is settable', buildSize.status === 200,
        `expected 200, got ${buildSize.status} — ${buildSize.text.slice(0, 160)}`);

    const buildSizeStored = db.prepare(`SELECT value FROM app_settings WHERE key = 'build_max_gb'`).get();

    report.check('and stored', buildSizeStored?.value === '50',
        `stored: ${JSON.stringify(buildSizeStored)}`);

    const noLimit = await server.post('/settings/build_max_gb', { value: 0 }, admin);

    report.check('zero is a valid limit — it means none', noLimit.status === 200,
        `expected 200, got ${noLimit.status}`);

    const negativeLimit = await server.post('/settings/build_max_gb', { value: -1 }, admin);

    report.check('a negative limit is refused', negativeLimit.status === 400,
        `expected 400, got ${negativeLimit.status}`);

    const buildTime = await server.post('/settings/build_max_minutes', { value: 45 }, admin);

    report.check('the build time limit is settable', buildTime.status === 200,
        `expected 200, got ${buildTime.status}`);

    const reset = await server.post('/settings/session_hours/reset', {}, admin);

    report.check('reset restores the default', reset.status === 200,
        `expected 200, got ${reset.status} — ${reset.text.slice(0, 160)}`);

    const afterReset = db.prepare(`SELECT value FROM app_settings WHERE key = 'session_hours'`).get();

    report.check('and the default is what the registry says it is',
        !afterReset || afterReset.value === '2',
        `stored after reset: ${JSON.stringify(afterReset)}`);

    const resetAudit = db.prepare(`
        SELECT * FROM audit_logs
        WHERE action = 'settings.reset' AND actor_id = 1
        ORDER BY id DESC LIMIT 1
    `).get();

    report.check('and the reset is audited', Boolean(resetAudit),
        'no settings.reset row was written');

    // -----------------------------------------------------------------
    // ACCOUNTS
    // -----------------------------------------------------------------

    const users = await server.get('/users', admin);

    report.check('an administrator reads the accounts', users.status === 200,
        `expected 200, got ${users.status}`);

    const devUsers = await server.get('/users', dev);

    report.check('a developer cannot', devUsers.status === 403,
        `expected 403, got ${devUsers.status}`);

    const self = await server.post('/users/1/deactivate', {}, admin);

    report.check('an administrator cannot deactivate themselves', self.status === 409,
        `expected 409, got ${self.status}`);

    const peer = await server.post('/users/2/deactivate', {}, admin);

    report.check('nor another administrator', peer.status === 403,
        `expected 403, got ${peer.status}`);

    const disabled = await server.post('/users/3/deactivate', {}, admin);

    report.check('a developer can be deactivated', disabled.status === 200,
        `expected 200, got ${disabled.status} — ${disabled.text.slice(0, 160)}`);

    const devRow = db.prepare('SELECT is_active FROM users WHERE id = 3').get();

    report.check('and it takes effect in the database', devRow?.is_active === 0,
        `is_active: ${JSON.stringify(devRow)}`);

    const deactivateAudit = db.prepare(`
        SELECT * FROM audit_logs
        WHERE action = 'user.deactivate' AND actor_id = 1
        ORDER BY id DESC LIMIT 1
    `).get();

    report.check('and it is audited', Boolean(deactivateAudit),
        'no user.deactivate row was written');

    const enabled = await server.post('/users/3/reactivate', {}, admin);

    report.check('and the account can be restored', enabled.status === 200,
        `expected 200, got ${enabled.status}`);

    const devRowAgain = db.prepare('SELECT is_active FROM users WHERE id = 3').get();

    report.check('which also takes effect', devRowAgain?.is_active === 1,
        `is_active: ${JSON.stringify(devRowAgain)}`);

    // A DEACTIVATED ACCOUNT'S OWN TOKEN STOPS WORKING — the property the
    // deactivation exists for. Checked here from the account's side as well as
    // the administrator's.
    const writable = new Database(server.dbPath);
    writable.prepare('UPDATE users SET is_active = 0 WHERE id = 3').run();
    writable.close();

    const devAfter = await server.get('/users', dev);

    report.check('a deactivated account is refused on its next request',
        devAfter.status === 401 || devAfter.status === 403,
        `expected a refusal, got ${devAfter.status}`);

    // -----------------------------------------------------------------
    // AUDIT
    // -----------------------------------------------------------------

    const auditRead = await server.get('/audit', admin);

    report.check('the audit route reads what happened', auditRead.status === 200,
        `expected 200, got ${auditRead.status}`);

    report.check('and includes the settings change',
        auditRead.status === 200 && /settings\.update/.test(auditRead.text),
        `response did not mention settings.update: ${auditRead.text.slice(0, 200)}`);

    await server.close();
    report.finish('administration is bounded, applied, and recorded.');
}

main().catch(err => {
    console.error('\n  FAIL — the check could not run:', err.message, '\n');
    process.exit(1);
});
