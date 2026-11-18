#!/usr/bin/env node
/**
 * Checks SIGN-IN and SIGN-OUT over HTTP.
 *
 *   node tests/check-auth.js      # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * Every other HTTP check mints its own token and never touches the login
 * route, so the one thing every person uses was the one thing no check ran:
 * the password comparison, the case-insensitive username, the inactive
 * account refusal, and the cookie's flags. A regression there signs everybody
 * out or, worse, signs in the wrong person.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   login    no username or password                400
 *            an unknown user                       401
 *            the wrong password                    401
 *            a deactivated account                 403
 *            the right one                         200, with a session cookie
 *            the cookie is HttpOnly and SameSite=Lax
 *            the username is case-insensitive
 *            the response never contains a hash
 *
 *   me       with the cookie from login             200, the same person
 *            with no cookie                        401
 *            after the account is deactivated      403
 *
 *   logout   clears the cookie
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * A throwaway database with three users: one active, one inactive, and one
 * to be deactivated mid-check. The password is a TEST password, hashed here;
 * it is not any account's real password and nothing outside this throwaway
 * database ever sees it.
 */

const bcrypt = require('bcryptjs');
const { Reporter, startCheckServer } = require('./lib/check-harness');

const TEST_PASSWORD = 'check-only-password-123';

async function main() {
    const report = new Reporter();

    const server = await startCheckServer({
        prefix: 'lowex-auth-',
        route: 'backend/routes/auth',
        mount: '/api/auth',

        seed(db) {
            const hash = bcrypt.hashSync(TEST_PASSWORD, 4);

            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'alice',  'alice@check.invalid',  '${hash}', 'developer', 1),
                    (2, 'bob',    'bob@check.invalid',    '${hash}', 'developer', 0),
                    (3, 'carol',  'carol@check.invalid',  '${hash}', 'admin',     1);
            `);
        }
    });

    const cookieOf = response => {
        const raw = response.headers.get('set-cookie') || '';
        const match = raw.match(/token=([^;]+)/);
        return match ? match[1] : null;
    };

    // -----------------------------------------------------------------
    // LOGIN
    // -----------------------------------------------------------------

    const empty = await server.post('/login', { username: 'alice' });

    report.check('login without a password is refused', empty.status === 400,
        `expected 400, got ${empty.status}`);

    const unknown = await server.post('/login', {
        username: 'nobody', password: TEST_PASSWORD
    });

    report.check('an unknown username is refused', unknown.status === 401,
        `expected 401, got ${unknown.status}`);

    const wrong = await server.post('/login', {
        username: 'alice', password: 'not-the-password'
    });

    report.check('the wrong password is refused', wrong.status === 401,
        `expected 401, got ${wrong.status}`);

    report.check('and no cookie is issued on a refusal',
        cookieOf(wrong) === null,
        `set-cookie: ${wrong.headers.get('set-cookie')}`);

    const inactive = await server.post('/login', {
        username: 'bob', password: TEST_PASSWORD
    });

    report.check('a deactivated account is refused', inactive.status === 403,
        `expected 403, got ${inactive.status}`);

    // CASE-INSENSITIVE, because people type their own name how they like it.
    const good = await server.post('/login', {
        username: '  ALICE  ', password: TEST_PASSWORD
    });

    report.check('the right password signs in', good.status === 200,
        `expected 200, got ${good.status} — ${good.text.slice(0, 160)}`);

    report.check('and the response names the person',
        good.json?.user?.username === 'alice' && good.json?.user?.role === 'developer',
        `response: ${good.text.slice(0, 160)}`);

    report.check('and never returns a password hash',
        !/password_hash|\$2[aby]\$/.test(good.text),
        'the response contained something that looks like a hash');

    const rawCookie = good.headers.get('set-cookie') || '';

    report.check('the session cookie is HttpOnly', /HttpOnly/i.test(rawCookie),
        `set-cookie: ${rawCookie}`);

    report.check('the session cookie is SameSite=Lax', /SameSite=Lax/i.test(rawCookie),
        `set-cookie: ${rawCookie}`);

    const token = cookieOf(good);

    report.check('and carries a token', Boolean(token),
        `set-cookie: ${rawCookie}`);

    // -----------------------------------------------------------------
    // ME
    // -----------------------------------------------------------------

    const me = await server.get('/me', token);

    report.check('the session identifies the same person', me.status === 200
        && me.json?.user?.username === 'alice',
        `expected 200 alice, got ${me.status} — ${me.text.slice(0, 160)}`);

    report.check('/me reports whether a second factor exists, not the secret',
        me.status === 200 && 'has_2fa_secret' in (me.json?.user || {})
        && !('two_factor_secret' in (me.json?.user || {})),
        `response: ${me.text.slice(0, 200)}`);

    const anonymous = await server.get('/me');

    report.check('/me without a cookie is refused',
        anonymous.status === 401 || anonymous.status === 403,
        `expected a refusal, got ${anonymous.status}`);

    // -----------------------------------------------------------------
    // DEACTIVATION ENDS THE SESSION ON THE NEXT REQUEST
    // -----------------------------------------------------------------
    //
    // The role and the active flag are re-read from the database on every
    // request, which is what makes deactivation immediate rather than
    // eventual. This is the check that says so for the account that is signed
    // in, not only for one that is trying to sign in.

    const Database = require('better-sqlite3');
    const db = new Database(server.dbPath);
    db.prepare('UPDATE users SET is_active = 0 WHERE username = ?').run('alice');
    db.close();

    const after = await server.get('/me', token);

    report.check('deactivation takes effect on the next request',
        after.status === 401 || after.status === 403,
        `expected a refusal, got ${after.status} — ${after.text.slice(0, 120)}`);

    // -----------------------------------------------------------------
    // LOGOUT
    // -----------------------------------------------------------------

    const out = await server.post('/logout', {}, token);

    report.check('logout succeeds', out.status === 200,
        `expected 200, got ${out.status}`);

    const cleared = out.headers.get('set-cookie') || '';

    report.check('and clears the cookie', /token=;/.test(cleared)
        || /Expires=Thu, 01 Jan 1970/i.test(cleared),
        `set-cookie: ${cleared}`);

    await server.close();
    report.finish('sign-in, session identity and sign-out behave as described.');
}

main().catch(err => {
    console.error('\n  FAIL — the check could not run:', err.message, '\n');
    process.exit(1);
});
