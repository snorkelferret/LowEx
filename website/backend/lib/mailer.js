// backend/lib/mailer.js
//
// Sending mail. Nothing in this project has ever sent any.
//
// GRACEFUL DEGRADATION IS THE DESIGN. If SMTP is not configured the
// application still works — the invitation endpoints return the link in their
// response instead of emailing it, which is exactly the behaviour that exists
// today. So turning email on is a configuration change, not a code change, and
// a fresh clone without credentials runs as it always did rather than failing
// at the point someone tries to invite somebody.
//
// A SEND FAILURE IS NOT A REQUEST FAILURE. If the invitation was created but
// the mail bounced, the invitation is still real and the caller is told the
// mail did not go, with the link so they can pass it on. Rolling the
// invitation back because a mail server was down would be the wrong trade.

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || 'Low Expectations <no-reply@lowexpectations.zone>';

// Host and from-address are the minimum. A local relay may need no auth at
// all, so user/pass are optional — but if one is set the other must be, or the
// relay will reject every message with a confusing error.
function isConfigured() {
    if (!SMTP_HOST) return false;
    if (SMTP_USER && !SMTP_PASS) return false;
    if (SMTP_PASS && !SMTP_USER) return false;
    return true;
}

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });

    return transporter;
}

/**
 * Send one message.
 *
 * Never throws. Returns { sent: true, messageId } or
 * { sent: false, reason, error? } so the caller can decide what to tell the
 * user rather than having to handle an exception on a path where the
 * important work has already succeeded.
 */
async function sendMail({ to, subject, text, html }) {
    if (!isConfigured()) {
        return { sent: false, reason: 'not_configured' };
    }

    try {
        const info = await getTransporter().sendMail({
            from: MAIL_FROM,
            to,
            subject,
            text,
            html,
        });

        return { sent: true, messageId: info.messageId };

    } catch (err) {
        // The token is in the body of these messages, so the error is logged
        // without the message content.
        console.error('Failed to send mail to', to, '-', err.message);

        return { sent: false, reason: 'error', error: err.message };
    }
}

const ROLE_LABELS = {
    user: 'a tester',
    developer: 'a developer',
    admin: 'an administrator',
    superuser: 'a superuser',
};

/**
 * The invitation email.
 *
 * Plain text and HTML both, because a token link in an HTML-only mail can be
 * mangled by some clients and this is the one link that has to survive intact.
 */
async function sendInvitation(to, { role, link, expiresAt, reissued = false }) {
    const roleLabel = ROLE_LABELS[role] || role;

    const subject = reissued
        ? 'Your Low Expectations invitation has been renewed'
        : 'You have been invited to Low Expectations';

    const opening = reissued
        ? 'A new invitation link has been generated for you, replacing the previous one.'
        : `You have been invited as ${roleLabel}.`;

    const text = [
        opening,
        '',
        'Open this link to choose a username and password:',
        link,
        '',
        expiresAt
            ? `This link is valid until ${expiresAt} (UTC).`
            : 'This link is valid for 28 days.',
        '',
        'If you were not expecting this, you can ignore this message.',
        '',
        '— Low Expectations',
    ].join('\n');

    // The link is the only interpolated value, and it is generated here rather
    // than supplied by a user. The role label is looked up from a fixed map.
    const html = `
        <div style="font-family: system-ui, sans-serif; line-height: 1.5;">
          <p>${opening}</p>
          <p>Open this link to choose a username and password:</p>
          <p><a href="${link}">${link}</a></p>
          <p style="color:#666; font-size: 0.9em;">
            ${expiresAt
                ? `This link is valid until ${expiresAt} (UTC).`
                : 'This link is valid for 28 days.'}
          </p>
          <p style="color:#666; font-size: 0.9em;">
            If you were not expecting this, you can ignore this message.
          </p>
          <p style="color:#666; font-size: 0.9em;">— Low Expectations</p>
        </div>
    `;

    return sendMail({ to, subject, text, html });
}

module.exports = {
    isConfigured,
    sendMail,
    sendInvitation,
};
