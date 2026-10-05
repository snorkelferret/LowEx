#!/usr/bin/env node
//
// Create a privileged account, or set a password for an existing one.
// Runs on the studio machine only. Not reachable from the web.
//
// ============================================================
// WHY THIS EXISTS RATHER THAN A FORM ON A PAGE
// ============================================================
//
// Admin and superuser accounts cannot be created through the web interface at
// all. They are created here, by somebody with shell access to the host. That
// limits PERSISTENCE rather than impact: a stolen superuser session can still
// change settings and read everything, but it cannot plant a lasting privileged
// account — which is the difference between an incident you clean up and one you
// keep finding again.
//
// So this file is the whole of the privileged provisioning path, and the fact
// that it needs a shell is the control, not the obscurity of its name.
//
// ============================================================
// THE PASSWORD IS NEVER ECHOED, ANYWHERE
// ============================================================
//
// Not to the console, not into a log, not into an audit record, not into a
// shell history file. It exists as a bcrypt hash in the database and as the
// characters the person typed, and nowhere else.
//
// WHICH IS WHY IT IS PROMPTED FOR RATHER THAN PASSED IN. A password given as an
// argument lands in `ps` output and in the shell's history file; one given as an
// environment variable is readable from /proc by the same user and is inherited
// by every child process. Neither is acceptable for the account that can do
// everything, so a non-interactive run is REFUSED rather than compromised.
//
// There is deliberately no "generate one and print it" mode for the same
// reason: a password printed to a terminal is a password in a scrollback buffer
// and possibly in a screenshot.
//
// ============================================================
// WHAT IT REPLACES
// ============================================================
//
// db.js used to seed a superuser called "admin" with a fixed, known password
// on first run, and print that password to the console.
// The credential was in the repository, on the most privileged account in the
// system, and printed where anybody watching the terminal could read it.
//
// That is gone. A fresh database now has no accounts at all, and no way in
// except this script — which is the intended property, and better than a
// default password nobody remembers to change.
//
// ============================================================
// USAGE
// ============================================================
//
//   node scripts/create-superuser.js                  create a superuser
//   node scripts/create-superuser.js --role admin     create an admin instead
//   node scripts/create-superuser.js --reset <name>   set a new password
//   node scripts/create-superuser.js --list           who is on the system
//
// --reset exists because nothing else can change a password: there is no
// in-app password change, so without this a forgotten password means editing
// the database by hand.

const path = require('path');
const os = require('os');

const db = require(path.join(__dirname, '../backend/db'));
const audit = require(path.join(__dirname, '../backend/lib/audit'));
const bcrypt = require('bcryptjs');

// Roles this script will create. Developers and testers are NOT here: they come
// through invitations, which is what the invitation system is for. This is the
// privileged provisioning path only, and the rule it enforces is why it can be
// trusted that an admin account was made deliberately.
const CREATABLE_ROLES = ['admin', 'superuser'];

// Long enough to be worth the trouble on an account that can do everything.
// Length is not the whole story, but it is the part that can be checked without
// pretending to know what makes a password good.
const MIN_PASSWORD_LENGTH = 12;

const args = process.argv.slice(2);
const has = flag => args.includes(flag);

function option(name) {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] || null;
}

function fail(message) {
    console.error(`\n  ${message}\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Reading a password without showing it
// ---------------------------------------------------------------------------

/**
 * Read a line from the terminal with echo switched off.
 *
 * RAW MODE, AND NOTHING IS WRITTEN BACK. Not even asterisks — the requirement
 * is that the characters never reach the terminal, and a length indicator is a
 * (small) disclosure that buys little.
 *
 * The cost is that the person sees nothing as they type, which is why the
 * prompt says so and why they are asked twice.
 */
function readHidden(prompt) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;

        if (!stdin.isTTY) {
            // Refused rather than worked around. See the header: every
            // non-interactive way of supplying a password leaves it somewhere
            // it should not be.
            reject(new Error('not a terminal'));
            return;
        }

        // RAW MODE BEFORE THE PROMPT, NOT AFTER.
        //
        // The other order leaves a window — brief, but real — in which input
        // arriving before echo is switched off is echoed by the terminal
        // itself. Nobody can type that fast, but a PASTE arrives all at once
        // and does not care how brief the window is. Prompting second closes
        // it, and costs nothing.
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        stdout.write(prompt);

        let value = '';

        const finish = (result, error) => {
            stdin.removeListener('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            stdout.write('\n');
            error ? reject(error) : resolve(result);
        };

        const onData = chunk => {
            for (const char of chunk) {
                if (char === '\r' || char === '\n') {
                    finish(value);
                    return;
                }

                // Ctrl-C. Handled rather than left to the default, because raw
                // mode swallows it and the terminal would be left unusable.
                if (char === '\u0003') {
                    finish('', new Error('cancelled'));
                    return;
                }

                if (char === '\u007f' || char === '\b') {
                    value = value.slice(0, -1);
                    continue;
                }

                // Ignore other control characters rather than storing them in
                // a password nobody can retype.
                if (char < ' ') continue;

                value += char;
            }
        };

        stdin.on('data', onData);
    });
}

async function askPassword(label) {
    let first;

    try {
        first = await readHidden(`  ${label} (not shown as you type): `);
    } catch (err) {
        if (err.message === 'not a terminal') {
            fail(
                'This needs a terminal to type into.\n\n' +
                '  A password cannot be passed as an argument or an environment\n' +
                '  variable: arguments appear in `ps` output and in the shell\'s\n' +
                '  history, and the environment is readable by other processes.\n' +
                '  Run it interactively on the studio machine.'
            );
        }
        fail('Cancelled.');
    }

    if (first.length < MIN_PASSWORD_LENGTH) {
        fail(
            `The password must be at least ${MIN_PASSWORD_LENGTH} characters.\n` +
            '  This account can do everything, including removing every other\n' +
            '  account. A short password here undoes the rest of the design.'
        );
    }

    let again;

    try {
        again = await readHidden(`  ${label} again: `);
    } catch {
        fail('Cancelled.');
    }

    if (first !== again) {
        fail('The two did not match. Nothing has been changed.');
    }

    return first;
}

// ---------------------------------------------------------------------------
// Telling the audit trail who did this
// ---------------------------------------------------------------------------

// NO SESSION ACTOR, and that is the truth rather than a gap: nothing signed in
// to do this. What identifies the person is the operating-system account they
// ran it as, plus the machine — so an audit entry for a console action says
// which human on which box, which is the most that can honestly be claimed.
function osIdentity() {
    let user = 'unknown';

    try {
        user = os.userInfo().username;
    } catch {
        // Some environments cannot answer this. Not worth failing over.
    }

    return { os_user: user, host: os.hostname() };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function listAccounts() {
    const users = db.prepare(`
        SELECT username, email, role, is_active, created_via, created_at
        FROM users
        ORDER BY
            CASE role
                WHEN 'superuser' THEN 0
                WHEN 'admin' THEN 1
                WHEN 'developer' THEN 2
                ELSE 3
            END,
            username
    `).all();

    if (users.length === 0) {
        console.log('\n  No accounts exist yet.');
        console.log('  Create the first one:  node scripts/create-superuser.js\n');
        return;
    }

    console.log(`\n  ${users.length} account(s):\n`);

    for (const u of users) {
        console.log(
            `   ${u.role.padEnd(10)} ${u.username.padEnd(18)} ${u.email.padEnd(34)}` +
            `${u.is_active ? '' : '[deactivated] '}created ${u.created_at}` +
            `${u.created_via ? '' : '  <- NO RECORDED ORIGIN'}`
        );
    }

    console.log('');
}

async function createAccount() {
    const role = option('--role') || 'superuser';

    if (!CREATABLE_ROLES.includes(role)) {
        fail(
            `This script creates ${CREATABLE_ROLES.join(' and ')} only.\n` +
            `  Developers and testers are created by invitation from the admin\n` +
            `  page, which is the path for everyone who is not privileged.`
        );
    }

    // Interactive for the same reason the password is: a username is not
    // secret, but a half-typed command line is a good way to create an account
    // with the wrong name on a system where that is hard to undo.
    const username = (option('--username') || await askLine('  Username: ')).trim();
    const email = (option('--email') || await askLine('  Email address: ')).trim().toLowerCase();

    if (!username) fail('A username is required.');
    if (!email) fail('An email address is required.');

    const clash = db.prepare(
        'SELECT username, email FROM users WHERE username = ? OR LOWER(email) = ?'
    ).get(username, email);

    if (clash) {
        fail(
            clash.username === username
                ? `The username "${username}" is already taken.`
                : `The address "${email}" already has an account.`
        );
    }

    const password = await askPassword('  Password');
    const hash = await bcrypt.hash(password, 12);

    const identity = osIdentity();

    db.transaction(() => {
        db.prepare(`
            INSERT INTO users (username, email, password_hash, role, created_via)
            VALUES (?, ?, ?, ?, 'console')
        `).run(username, email, hash, role);

        audit.record(null, 'user.create', username, {
            email,
            role,
            via: 'console',
            ...identity,
        });
    })();

    console.log(`\n  Created ${role} "${username}" <${email}>.`);
    console.log('  The password was not stored or shown anywhere but the database.\n');
}

// A visible line, for things that are not secret.
function askLine(prompt) {
    return new Promise(resolve => {
        const stdin = process.stdin;
        const stdout = process.stdout;

        if (!stdin.isTTY) {
            fail(
                'This needs a terminal. Pass --username and --email if you are\n' +
                '  running it from a script; the password is still asked for\n' +
                '  interactively because it must never appear in a command line.'
            );
        }

        stdout.write(prompt);
        stdin.resume();
        stdin.setEncoding('utf8');

        const onData = chunk => {
            stdin.removeListener('data', onData);
            stdin.pause();
            stdout.write('\n');
            resolve(chunk.replace(/[\r\n]/g, ''));
        };

        stdin.on('data', onData);
    });
}

async function resetPassword(username) {
    const user = db.prepare(
        'SELECT id, username, email, role FROM users WHERE username = ?'
    ).get(username);

    if (!user) {
        fail(`No account called "${username}".  Run --list to see them.`);
    }

    console.log(`\n  Setting a new password for ${user.role} "${user.username}" <${user.email}>.`);

    const password = await askPassword('  New password');
    const hash = await bcrypt.hash(password, 12);

    const identity = osIdentity();

    db.transaction(() => {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

        // Recorded, because a password change is a change of who can get in,
        // and on a privileged account it is exactly the event somebody would
        // want to find later. The password itself is not here — only that it
        // happened, and who did it.
        audit.record(null, 'user.password_reset', user.username, {
            role: user.role,
            via: 'console',
            ...identity,
        });
    })();

    console.log('\n  Done. The new password is in the database as a bcrypt hash.\n');
}

// ---------------------------------------------------------------------------

async function main() {
    if (has('--help') || has('-h')) {
        console.log(`
  Create a privileged account, or set a password for an existing one.
  Runs on the studio machine. Not reachable from the web.

    node scripts/create-superuser.js                  create a superuser
    node scripts/create-superuser.js --role admin     create an admin
    node scripts/create-superuser.js --reset <name>   set a new password
    node scripts/create-superuser.js --list           who is on the system

  Only ${CREATABLE_ROLES.join(' and ')} can be created here. Developers and
  testers are created by invitation from the admin page.

  The password is typed, never passed in, and never shown:
    --username / --email are accepted for scripting, but a password on a
    command line or in an environment variable would be readable by other
    processes and would land in the shell's history.
`);
        return;
    }

    if (has('--list')) {
        listAccounts();
        return;
    }

    const reset = option('--reset');

    if (args.includes('--reset')) {
        if (!reset) fail('--reset needs a username.  e.g. --reset admin');
        await resetPassword(reset);
        return;
    }

    await createAccount();
}

main().catch(err => {
    console.error('\n  Failed:', err.message, '\n');
    process.exit(1);
});
