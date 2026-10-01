// backend/lib/invites.js
//
// Invitation rules shared by the router that creates them and the endpoint
// that accepts them. Kept here rather than in either, so the two cannot drift
// apart on what "still valid" means.

const INVITE_VALID_DAYS = 28;
const MAX_REISSUES = 6;

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

const inviteLinkFor = (clientUrl, token) =>
    `${clientUrl || 'http://localhost:5173'}/register?token=${token}`;

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
    INVITE_VALID_DAYS,
    MAX_REISSUES,
    STATUSES,
    DISPLAY_STATUS_SQL,
    REISSUE_REFUSALS,
    inviteLinkFor,
    isAcceptable,
    canReissue,
};
