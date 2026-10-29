// backend/lib/invites.js
//
// Invitation rules shared by the router that creates them and the endpoint
// that accepts them. Kept here rather than in either, so the two cannot drift
// apart on what "still valid" means.

// The window is an ADMIN SETTING, so it is read per use rather than held. A
// module-scope `const INVITE_VALID_DAYS = getSetting(...)` would freeze it at
// boot — the save would appear to work and nothing would change until a
// restart, which is the exact failure the settings mechanism exists to avoid.
const settings = require('./settings');

const MAX_REISSUES = 6;

// ---------------------------------------------------------------------------
// Who may be invited
// ---------------------------------------------------------------------------
//
// AN INVITATION IS FOR SOMEONE WHO HAS NO ACCOUNT. Issuing one for an address
// that already has a login produces a dead link, a confusing failure at the
// last step ("Username or Email already registered"), and a row in the admin's
// list that looks like somebody is waiting to get in when nobody is.
//
// It is also how a stale invitation ends up sitting beside a live account with
// nothing connecting them — which is exactly the state the portal was found in
// on 2026-10-05: a pending invitation for an address that already had a
// developer account, created a day earlier by hand rather than through the
// invitation flow.

// Emails are compared and stored LOWERCASED, because the column's UNIQUE
// constraint is case-sensitive. Without this, "Val@x.com" and "val@x.com" are
// two different invitations for one person, and an account for one does not
// block an invitation for the other — a hole that produces precisely the
// duplicate this function exists to prevent.
function normaliseEmail(email) {
    return String(email ?? '').trim().toLowerCase();
}

/**
 * The existing account for an address, or null.
 *
 * Case-insensitive, so it agrees with normaliseEmail above rather than with
 * whatever case the account happened to be created in.
 */
function accountFor(db, email) {
    const wanted = normaliseEmail(email);

    if (!wanted) return null;

    return db.prepare(
        'SELECT id, username, role, is_active FROM users WHERE LOWER(email) = ?'
    ).get(wanted) || null;
}

/**
 * May this address be invited? Returns { ok } or { ok: false, reason }.
 *
 * THE ONE PLACE THIS IS DECIDED, called by invitation creation and by both
 * reissue paths — a reissue prolongs access for an address just as an issue
 * does, so it needs the same answer.
 */
function inviteable(db, email) {
    if (!normaliseEmail(email)) {
        return { ok: false, reason: 'empty' };
    }

    const account = accountFor(db, email);

    if (account) {
        return { ok: false, reason: 'has_account', account };
    }

    return { ok: true };
}

// What to tell an administrator who tried. Names the account, because "this
// person already has a login" is only half an answer without saying which.
function inviteRefusal(email, account) {
    return `${normaliseEmail(email)} already has an account ` +
        `("${account.username}", ${account.role}` +
        `${account.is_active ? '' : ', deactivated'}). ` +
        `They can sign in — an invitation would be a dead link. ` +
        (account.is_active
            ? 'If they have lost their password, reset it rather than inviting them again.'
            : 'Reactivate the account instead of inviting them again.');
}

/**
 * How long a newly issued invitation lasts, in days.
 *
 * A function, not a value. Callers must call it where the number is used:
 * `inviteValidDays()` in the SQL, not a local captured at module load.
 */
function inviteValidDays() {
    return settings.getSetting('invite_valid_days');
}

const STATUSES = ['pending', 'used', 'revoked'];

// Stored status is pending / used / revoked.
//
// EXPIRY IS NOT STORED. It is derived from expires_at on read, so no scheduled
// job is needed to move a pending invitation into an expired state, and a
// missed job or a clock skew cannot leave one stuck in the wrong state.
const DISPLAY_STATUS_SQL = `
    CASE
        WHEN status <> 'pending' THEN status
        WHEN expires_at IS NOT NULL AND datetime('now') > expires_at THEN 'expired'
        ELSE 'pending'
    END
`;

const { resolveConfig } = require('../../shared/config.mjs');

// The fallback comes from the ONE config module, not from a third copy of the
// development address (shared/config.mjs).
const inviteLinkFor = (clientUrl, token) =>
    `${clientUrl || resolveConfig(process.env).clientUrl}/register?token=${token}`;

// May this invitation still be used to register?
//
// Both halves matter: a revoked or already-used invitation is refused
// regardless of dates, and a pending one is refused once expired.
function isAcceptable(db, invite) {
    if (!invite || invite.status !== 'pending') {
        return { ok: false, reason: invite ? invite.status : 'missing' };
    }

    if (invite.expires_at === null) {
        return { ok: true };
    }

    const { expired } = db.prepare(
        "SELECT datetime('now') > ? AS expired"
    ).get(invite.expires_at);

    return expired ? { ok: false, reason: 'expired' } : { ok: true };
}

// May this invitation be reissued?
//
// Shared by BOTH reissue paths — the unauthenticated one where the invitee
// holds a link, and the admin one where an administrator picks from the list.
// Two copies of these checks would drift, and the failure would be quiet: one
// path allowing a reissue of a revoked invitation, say.
function canReissue(invite) {
    if (!invite) {
        return { ok: false, reason: 'missing' };
    }

    if (invite.status === 'revoked') {
        return { ok: false, reason: 'revoked' };
    }

    if (invite.status === 'used') {
        return { ok: false, reason: 'used' };
    }

    if (invite.reissue_count >= MAX_REISSUES) {
        return { ok: false, reason: 'limit' };
    }

    return { ok: true };
}

// The messages both paths use for a refusal, so they cannot disagree either.
const REISSUE_REFUSALS = {
    revoked: {
        status: 403,
        body: {
            error: 'REVOKED',
            message: 'This invitation has been withdrawn. Please contact your administrator.'
        }
    },
    used: {
        status: 400,
        body: { message: 'This invitation has already been accepted.' }
    },
    limit: {
        status: 403,
        body: {
            error: 'LIMIT_REACHED',
            message:
                `Maximum reissue limit (${MAX_REISSUES}/${MAX_REISSUES}) reached. ` +
                `Please contact your administrator for a fresh invitation.`
        }
    }
};

module.exports = {
    inviteValidDays,
    normaliseEmail,
    accountFor,
    inviteable,
    inviteRefusal,
    MAX_REISSUES,
    STATUSES,
    DISPLAY_STATUS_SQL,
    REISSUE_REFUSALS,
    inviteLinkFor,
    isAcceptable,
    canReissue,
};
