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

module.exports = {
    INVITE_VALID_DAYS,
    MAX_REISSUES,
    STATUSES,
    DISPLAY_STATUS_SQL,
    inviteLinkFor,
    isAcceptable,
};
