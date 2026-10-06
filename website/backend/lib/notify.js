// backend/lib/notify.js
//
// Telling somebody about something urgent.
//
// ============================================================
// WHAT THIS IS FOR, AND WHAT IT IS NOT
// ============================================================
//
// The admin page can show a warning, but only to somebody who is looking at the
// admin page. A disk that is 95% full and climbing needs to reach a person who
// is not at their desk, which means a message rather than a screen.
//
// THIS IS NOT THE CONDITION REGISTRY. It answers "how does a message get to the
// right people, and did it actually go" — nothing here decides WHEN something
// is urgent. That is the next piece, and the conditions it will carry are
// recorded in the TODO: disk over the critical threshold and rising, the
// accounts-not-accounted-for finding, and others as they come up.
//
// ============================================================
// WHO GETS IT — every active administrator
// ============================================================
//
// ALL OF THEM, not one. An alert that reaches one person reaches nobody when
// that person is on holiday, and the point of an urgent message is that it
// arrives.
//
// AND CC, NOT BCC, SO THEY CAN SEE EACH OTHER. Several people receiving the
// same alarm need to be able to talk to each other about it, and they cannot do
// that without knowing who else has it. BCC would hide exactly the thing that
// makes it collaborative — and would also mean two people independently
// investigating the same disk without ever finding out.
//
// ============================================================
// THE LIMIT WORTH KNOWING BEFORE BUILDING ON THIS
// ============================================================
//
// THIS CANNOT REPORT ITS OWN DEATH. If the production server is down, this is
// down with it, and no message is sent about the thing that matters most. That
// case needs something OUTSIDE the portal watching it — a health endpoint and a
// monitor that notices when it stops answering. Nothing here helps with it, and
// no amount of care inside this file can.
//
// ============================================================
// LEVELS
// ============================================================
//
// Three, and they decide the channels. Only email exists today; SMS is under
// discussion (see the TODO) and the map below is where it lands.
//
// The distinction that matters is not how bad something is, it is WHETHER IT
// INTERRUPTS SOMEBODY. Everything else belongs on the admin page.

const { sendMail, isConfigured } = require('./mailer');
const { isAdminOrAbove, ROLE_RANK } = require('./roles');
const db = require('../db');

const LEVELS = {
    info: { label: 'Notice', channels: ['page'] },
    warning: { label: 'Warning', channels: ['page', 'email'] },
    // UR - the one that leaves the building. Email now, SMS when it exists.
    urgent: { label: 'URGENT', channels: ['page', 'email'] },
};

/**
 * Every active administrator, most senior first.
 *
 * INACTIVE ACCOUNTS ARE SKIPPED. A deactivated account cannot sign in, so
 * mailing it about an incident is mailing an address nobody is watching —
 * exactly the wrong thing to do with the message that has to arrive.
 *
 * Ordered in JS by ROLE_RANK rather than by a CASE expression in the SQL,
 * because the ranking already lives in backend/lib/roles.js and a second copy
 * of it here is a second thing to keep in step.
 */
function staffRecipients() {
    const rows = db.prepare(`
        SELECT id, username, email, role
        FROM users
        WHERE is_active = 1
          AND email IS NOT NULL
          AND TRIM(email) <> ''
    `).all();

    return rows
        .filter(row => isAdminOrAbove(row.role))
        .sort((a, b) =>
            (ROLE_RANK[b.role] - ROLE_RANK[a.role]) ||
            a.username.localeCompare(b.username));
}

/**
 * Send one message to every administrator.
 *
 * RETURNS WHAT ACTUALLY HAPPENED rather than throwing, because the caller has
 * to be able to say so. "Sent" and "the mail transport is not configured on
 * this server" are both ordinary outcomes here, and a caller that cannot tell
 * them apart is a caller that reports success for a message nobody received.
 *
 * @returns { sent, reason?, error?, to: [], cc: [] }
 */
async function notifyStaff({ level = 'urgent', subject, text, html }) {
    const recipients = staffRecipients();

    if (recipients.length === 0) {
        // Not a failure of the transport — there is simply nobody to tell. An
        // installation whose only administrator has no email address is a real
        // state to be in, and worth saying rather than reporting a send that
        // had no destination.
        return { sent: false, reason: 'no_recipients', to: [], cc: [] };
    }

    // FIRST IN `To`, THE REST IN `Cc`. Everyone still sees everyone, which is
    // the point; a message with an empty To is also treated as suspicious by
    // some spam filters, so there is a reason to have one beyond convention.
    const [first, ...rest] = recipients;

    const to = [first.email];
    const cc = rest.map(r => r.email);

    const result = await sendMail({ to: to.join(', '), cc, subject, text, html });

    return { ...result, to, cc };
}

/**
 * Is any outbound channel configured at all?
 *
 * Asked by the admin page so it can warn BEFORE somebody relies on alerts
 * arriving, rather than being discovered during the incident they were meant to
 * report.
 */
function channels() {
    return {
        email: { configured: isConfigured() },
    };
}

/**
 * The message a test sends.
 *
 * SHAPED LIKE A REAL ALERT, deliberately. A test that sends something prettier
 * or shorter than the real thing proves less than it appears to: what needs
 * checking is whether an urgent message survives the journey, so this uses the
 * same subject prefix, the same level and the same recipient list.
 */
function testMessage({ requestedBy, host }) {
    const subject = `[${LEVELS.urgent.label}] Test alert from the Studio portal`;

    const text = [
        'This is a test.',
        '',
        'It was sent from the admin page to confirm that urgent alerts can reach',
        'you. If you are reading it, email alerts work.',
        '',
        `Requested by : ${requestedBy}`,
        `Server       : ${host || 'unknown'}`,
        `Time         : ${new Date().toISOString()}`,
        '',
        'Everyone who receives alerts is on this message — you are all in the To',
        'and Cc lines so you can see who else would be told about a real',
        'incident, and talk to each other about it.',
        '',
        'No action is needed.',
        '',
        '— Low Expectations',
    ].join('\n');

    const html = `
        <div style="font-family: system-ui, sans-serif; line-height: 1.5;">
          <p><strong>This is a test.</strong></p>
          <p>It was sent from the admin page to confirm that urgent alerts can
             reach you. If you are reading it, email alerts work.</p>
          <p style="color:#666; font-size: 0.9em;">
            Requested by ${requestedBy}<br>
            Server ${host || 'unknown'}<br>
            ${new Date().toISOString()}
          </p>
          <p style="color:#666; font-size: 0.9em;">
            Everyone who receives alerts is on this message — you are all in the
            To and Cc lines so you can see who else would be told about a real
            incident, and talk to each other about it.
          </p>
          <p style="color:#666; font-size: 0.9em;">No action is needed.</p>
          <p style="color:#666; font-size: 0.9em;">— Low Expectations</p>
        </div>
    `;

    return { subject, text, html };
}

module.exports = {
    LEVELS,
    staffRecipients,
    notifyStaff,
    channels,
    testMessage,
};
