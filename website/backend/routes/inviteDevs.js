// backend/routes/inviteDevs.js
//
// Invitations — for developers, and for testers.
//
// A tester is a plain `user`: a login with no extra privileges. Being a tester
// needs no role of its own, because the tester features (download a build,
// comment, report) are available to anyone logged in. So 'user' is invitable
// and is the default, being the least privileged.
//
// This file is the single place invitations are created. There used to be two
// endpoints doing it differently — /api/auth/create-invite and
// /api/inviteDevs/generate-invite — and the former has been removed.
//
// ROLE RULES: an inviter may assign only roles STRICTLY BELOW their own. That
// closes a privilege escalation: both endpoints used to take assigned_role
// straight from the request body behind requireAdmin, so any admin could mint
// a superuser invitation and redeem it themselves, because the token comes
// back in the response. See backend/lib/roles.js.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { canAssignRole, assignableRolesFor, webAssignable } = require('../lib/roles');
const {
    inviteValidDays,
    normaliseEmail,
    inviteable,
    inviteRefusal,
    MAX_REISSUES,
    DISPLAY_STATUS_SQL,
    REISSUE_REFUSALS,
    inviteLinkFor,
    canReissue,
} = require('../lib/invites');
const { sendInvitation } = require('../lib/mailer');
const audit = require('../lib/audit');

const router = express.Router();

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const linkFor = (token) => inviteLinkFor(CLIENT_URL, token);


/**
 * GET /api/inviteDevs/list
 * Admin/superuser. Every invitation, newest first, with a derived status that
 * distinguishes expired from pending.
 */
router.get('/list', authenticateToken, requireAdmin, (req, res) => {
    try {
        // THE JOIN IS THE POINT, not decoration. An invitation whose address
        // already has an account is a stale record — it cannot be redeemed, and
        // it makes the list say somebody is waiting to get in when nobody is.
        // The panel flags them; this is what tells it.
        //
        // LOWER() on both sides, because the UNIQUE constraint on the column is
        // case-sensitive and an account may have been created with different
        // capitalisation from the invitation.
        //
        // created_by is joined too, so the list can say who issued each
        // invitation. It is NULL for rows that predate the column, which is
        // reported as "not recorded" rather than as nobody.
        const rows = db.prepare(`
            SELECT
                i.id,
                i.email,
                i.assigned_role          AS role,
                ${DISPLAY_STATUS_SQL}    AS status,
                i.expires_at             AS expiresAt,
                i.reissue_count          AS reissueCount,
                i.last_reissued_at       AS lastReissuedAt,
                i.created_at             AS createdAt,
                i.created_by             AS createdBy,
                i.source                 AS source,
                issuer.username          AS issuedBy,
                account.id               AS accountId,
                account.username         AS accountUsername,
                account.is_active        AS accountActive
            FROM invitations i
            LEFT JOIN users account ON LOWER(account.email) = LOWER(i.email)
            LEFT JOIN users issuer  ON issuer.id = i.created_by
            ORDER BY i.id DESC
        `).all();

        return res.json(rows);

    } catch (err) {
        console.error('Error fetching invite logs:', err);
        return res.status(500).json({ error: 'Failed to retrieve invitations list.' });
    }
});


/**
 * GET /api/inviteDevs/assignable-roles
 * Which roles the caller may hand out. Lets the UI offer only valid options
 * rather than letting someone pick one the server will refuse.
 */
router.get('/assignable-roles', authenticateToken, requireAdmin, (req, res) => {
    return res.json({ roles: assignableRolesFor(req.user.role) });
});


/**
 * GET /api/inviteDevs/token-state?token=...
 *
 * What state is this invitation in? Unauthenticated by necessity: whoever is
 * asking holds an invitation link and has no account yet, so there is nothing
 * to authenticate them with.
 *
 * This exists so the register page can say something useful — expired, with a
 * reissue offered; withdrawn; already accepted — instead of presenting a form
 * that will fail on submit. Discovering a token this way is not a risk: they
 * are 32 random bytes.
 */
router.get('/token-state', (req, res) => {
    const token = String(req.query?.token || '').trim();

    if (!token) {
        return res.status(400).json({ state: 'unknown', error: 'A token is required.' });
    }

    try {
        const invite = db.prepare(`
            SELECT
                email,
                assigned_role,
                status                                AS stored_status,
                ${DISPLAY_STATUS_SQL}                 AS state,
                expires_at,
                reissue_count
            FROM invitations
            WHERE token = ?
        `).get(token);

        // Same answer for "no such token" as for a malformed one — there is
        // nothing here worth distinguishing.
        if (!invite) {
            return res.status(404).json({ state: 'unknown' });
        }

        return res.json({
            state: invite.state,
            role: invite.assigned_role,
            email: invite.email,
            expiresAt: invite.expires_at,
            // A used or revoked invitation cannot be reissued, and a pending
            // one that has not expired does not need to be.
            reissueAllowed:
                invite.stored_status === 'pending' &&
                invite.reissue_count < MAX_REISSUES,
            reissuesRemaining:
                invite.stored_status === 'pending'
                    ? Math.max(0, MAX_REISSUES - invite.reissue_count)
                    : 0
        });

    } catch (err) {
        console.error('Error checking invitation token:', err);
        return res.status(500).json({ state: 'unknown', error: 'Could not check the invitation.' });
    }
});


/**
 * POST /api/inviteDevs/generate-invite
 * The one way an invitation is created.
 *
 * Body: { email, role }
 *
 * Emails the invitation, and also returns the link. Both, deliberately:
 * the returned link is what the inviter needs if SMTP is not configured or
 * the mail bounces. See backend/lib/mailer.js — email degrades gracefully, so
 * a deployment without credentials behaves exactly as it did before email
 * existed rather than failing here.
 */
router.post('/generate-invite', authenticateToken, requireAdmin, async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const role = String(req.body?.role || 'user').trim();

    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
    }

    // AN INVITATION IS FOR SOMEONE WITH NO ACCOUNT. Checked here rather than
    // left to fail at the last step of registration, where the person holding
    // the link gets "Username or Email already registered" and nobody learns
    // that the invitation should never have existed.
    const eligible = inviteable(db, email);

    if (!eligible.ok) {
        return res.status(409).json({
            error: inviteRefusal(email, eligible.account),
            reason: eligible.reason,
            existing_account: eligible.account
                ? { username: eligible.account.username, role: eligible.account.role }
                : null,
        });
    }

    // TWO DIFFERENT REFUSALS, SAID DIFFERENTLY.
    //
    // "The web cannot grant that role at all" and "you are not senior enough"
    // are separate facts, and the person reading the message needs the right
    // one. A superuser told "you are not senior enough to invite an admin"
    // would reasonably conclude that somebody more senior could — and there is
    // nobody more senior, which is the whole point.
    if (!webAssignable(role)) {
        return res.status(403).json({
            error:
                `Admin accounts cannot be created from this page, ` +
                `by anyone. They are created on the studio machine, by somebody ` +
                `with access to it. Developers and testers are invited here.`,
            reason: 'not_web_assignable',
        });
    }

    // Strictly below the inviter. See backend/lib/roles.js for why.
    if (!canAssignRole(req.user.role, role)) {
        const allowed = assignableRolesFor(req.user.role);

        return res.status(403).json({
            error:
                `You cannot invite someone as "${role}". ` +
                (allowed.length
                    ? `You may assign: ${allowed.join(', ')}.`
                    : 'You cannot assign any role.'),
            assignable_roles: allowed
        });
    }

    try {
        const token = crypto.randomBytes(32).toString('hex');

        // Stored lowercased, so the UNIQUE constraint on this column compares
        // the way a person does. Otherwise "Val@x.com" and "val@x.com" are two
        // invitations for one address.
        // created_by records WHO ISSUED IT. The audit entry below says the same
        // thing, but the audit log is a stream and this is the row — "which
        // administrator let this address in?" should be answerable from the
        // invitation itself, not only by searching a log.
        const issued = db.transaction(() => {
            const result = db.prepare(`
                INSERT INTO invitations (
                    email, assigned_role, token, status,
                    reissue_count, expires_at, created_at, created_by
                )
                VALUES (?, ?, ?, 'pending', 0, datetime('now', ?), datetime('now'), ?)
            `).run(
                normaliseEmail(email),
                role,
                token,
                `+${inviteValidDays()} days`,
                req.user.id
            );

            audit.record(req.user.id, 'invitation.create', normaliseEmail(email), {
                role,
                invitation_id: result.lastInsertRowid,
                expires_in_days: inviteValidDays(),
            });

            return result;
        });

        issued();

        const created = db.prepare(
            'SELECT expires_at FROM invitations WHERE email = ?'
        ).get(normaliseEmail(email));

        const inviteLink = linkFor(token);

        const mail = await sendInvitation(email, {
            role,
            link: inviteLink,
            expiresAt: created?.expires_at,
            // The window this invitation was actually issued under, so the
            // fallback line in the email cannot state a window that is not the
            // one in force.
            validDays: inviteValidDays(),
        });

        return res.json({
            success: true,
            // The NORMALISED address, not what was typed. These differ whenever
            // somebody types a capital, and the panel is telling the
            // administrator what was recorded — so it has to be what was
            // recorded, or the screen and the database disagree about the same
            // invitation.
            email: normaliseEmail(email),
            role,
            inviteLink,
            expiresAt: created?.expires_at,
            expiresInDays: inviteValidDays(),
            emailSent: mail.sent,
            // The link comes back either way. If the mail did not go it is the
            // only way to reach them; if it did, it is the fallback for an
            // address that bounces later.
            note: mail.sent
                ? 'Invitation emailed.'
                : mail.reason === 'not_configured'
                    ? 'Email is not configured — pass this link on yourself.'
                    : `Email could not be sent (${mail.error}) — pass this link on yourself.`
        });

    } catch (err) {
        console.error('Error generating invitation:', err);

        return res.status(400).json({
            error: 'An active invitation profile already exists for this email.'
        });
    }
});


/**
 * POST /api/inviteDevs/request-reissue
 * Unauthenticated on purpose: whoever is asking has an expired link and no
 * account yet, so there is nothing to authenticate them with.
 *
 * Mints a new token and returns the new link. It used to mint the token and
 * return only success/expiry — the call worked and the developer received
 * nothing usable, because the token was neither returned nor emailed.
 */
router.post('/request-reissue', async (req, res) => {
    const token = String(req.body?.token || '').trim();

    if (!token) {
        return res.status(400).json({ message: 'Invitation token is required.' });
    }

    try {
        const invite = db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);

        if (!invite) {
            return res.status(404).json({ message: 'Invitation record not found.' });
        }

        // Shared with the admin-side reissue below, so the two paths cannot
        // drift on what may be reissued.
        // The same rule as issuing one: an invitation for an address that now
        // has an account is a dead link, and reissuing extends the life of a
        // dead link. It can also become true AFTER the invitation was created —
        // an account made by hand, or a previous invitation redeemed — so this
        // is checked at reissue time and not only at creation.
        const eligible = inviteable(db, invite.email);

        if (!eligible.ok) {
            return res.status(409).json({
                error: inviteRefusal(invite.email, eligible.account),
                reason: eligible.reason,
            });
        }

        const reissueable = canReissue(invite);

        if (!reissueable.ok) {
            const refusal = REISSUE_REFUSALS[reissueable.reason];

            return refusal
                ? res.status(refusal.status).json(refusal.body)
                : res.status(400).json({ message: 'This invitation cannot be reissued.' });
        }

        const newToken = crypto.randomBytes(32).toString('hex');

        db.prepare(`
            UPDATE invitations
            SET token = ?,
                reissue_count = reissue_count + 1,
                expires_at = datetime('now', ?),
                last_reissued_at = datetime('now')
            WHERE id = ?
        `).run(newToken, `+${inviteValidDays()} days`, invite.id);

        const updated = db.prepare(
            'SELECT reissue_count, expires_at FROM invitations WHERE id = ?'
        ).get(invite.id);

        const inviteLink = linkFor(newToken);

        const mail = await sendInvitation(invite.email, {
            role: invite.assigned_role,
            link: inviteLink,
            expiresAt: updated.expires_at,
            validDays: inviteValidDays(),
            reissued: true,
        });

        return res.json({
            success: true,
            reissuesRemaining: MAX_REISSUES - updated.reissue_count,
            expiresAt: updated.expires_at,
            // Shown on the page as well as emailed. If the mail could not be
            // sent this is the only way the person asking gets a usable link.
            inviteLink,
            emailSent: mail.sent,
            message: mail.sent
                ? `Invitation reissued and emailed. A new ${inviteValidDays()}-day link is on its way.`
                : `Invitation reissued. A new ${inviteValidDays()}-day link has been generated.`
        });

    } catch (err) {
        console.error('Error reissuing invitation:', err);
        return res.status(500).json({ message: 'Internal server error processing reissue.' });
    }
});


/**
 * POST /api/inviteDevs/:id/revoke
 * Admin/superuser. Withdraws a pending invitation.
 *
 * Only the INVITATION is revoked here. Revoking an account that already exists
 * is a different operation — `users.is_active = 0` — and that already takes
 * effect immediately, because authenticateToken re-reads is_active on every
 * request rather than trusting the token.
 *
 * An invitation that has been used cannot be revoked: the account exists, and
 * revoking the invitation would do nothing to it, so saying "revoked" would be
 * misleading.
 */
router.post('/:id/revoke', authenticateToken, requireAdmin, (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid invitation ID' });
    }

    try {
        const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(id);

        if (!invite) {
            return res.status(404).json({ error: 'Invitation not found' });
        }

        if (invite.status === 'used') {
            return res.status(409).json({
                error:
                    'This invitation has already been accepted. To remove the ' +
                    'account, deactivate the user instead — revoking the ' +
                    'invitation would not affect them.'
            });
        }

        if (invite.status === 'revoked') {
            return res.json({ success: true, status: 'revoked', note: 'Already revoked.' });
        }

        db.prepare(`
            UPDATE invitations
            SET status = 'revoked'
            WHERE id = ?
        `).run(id);

        return res.json({
            success: true,
            id,
            email: invite.email,
            status: 'revoked'
        });

    } catch (err) {
        console.error('Error revoking invitation:', err);
        return res.status(500).json({ error: 'Failed to revoke invitation.' });
    }
});


/**
 * POST /api/inviteDevs/:id/reissue
 * Admin/superuser. Reissues a pending invitation, chosen from the list.
 *
 * This is the ADMIN-side counterpart to /request-reissue. That one is
 * unauthenticated because whoever asks holds a link and has no account yet, so
 * the token is the credential. An administrator has neither problem, and the
 * list endpoint deliberately does not return tokens — putting every
 * invitation's token on the page would make the list itself a liability. So
 * they pick by id and the server looks the token up.
 *
 * The route the admin UI called — /:id/reissue — was this path, but it did not
 * exist. Reissue from the panel has therefore never worked.
 */
router.post('/:id/reissue', authenticateToken, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid invitation ID' });
    }

    try {
        const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(id);

        if (!invite) {
            return res.status(404).json({ error: 'Invitation not found' });
        }

        // The same rule as issuing one: an invitation for an address that now
        // has an account is a dead link, and reissuing extends the life of a
        // dead link. It can also become true AFTER the invitation was created —
        // an account made by hand, or a previous invitation redeemed — so this
        // is checked at reissue time and not only at creation.
        const eligible = inviteable(db, invite.email);

        if (!eligible.ok) {
            return res.status(409).json({
                error: inviteRefusal(invite.email, eligible.account),
                reason: eligible.reason,
            });
        }

        const reissueable = canReissue(invite);

        if (!reissueable.ok) {
            const refusal = REISSUE_REFUSALS[reissueable.reason];

            return refusal
                ? res.status(refusal.status).json(refusal.body)
                : res.status(400).json({ error: 'This invitation cannot be reissued.' });
        }

        const newToken = crypto.randomBytes(32).toString('hex');

        db.prepare(`
            UPDATE invitations
            SET token = ?,
                reissue_count = reissue_count + 1,
                expires_at = datetime('now', ?),
                last_reissued_at = datetime('now')
            WHERE id = ?
        `).run(newToken, `+${inviteValidDays()} days`, id);

        const updated = db.prepare(
            'SELECT reissue_count, expires_at FROM invitations WHERE id = ?'
        ).get(id);

        const inviteLink = linkFor(newToken);

        const mail = await sendInvitation(invite.email, {
            role: invite.assigned_role,
            link: inviteLink,
            expiresAt: updated.expires_at,
            validDays: inviteValidDays(),
            reissued: true,
        });

        return res.json({
            success: true,
            id,
            email: invite.email,
            inviteLink,
            reissuesRemaining: MAX_REISSUES - updated.reissue_count,
            expiresAt: updated.expires_at,
            emailSent: mail.sent,
            note: mail.sent
                ? 'Invitation reissued and emailed.'
                : mail.reason === 'not_configured'
                    ? 'Email is not configured — pass this link on yourself.'
                    : `Email could not be sent (${mail.error}) — pass this link on yourself.`
        });

    } catch (err) {
        console.error('Error reissuing invitation:', err);
        return res.status(500).json({ error: 'Failed to reissue invitation.' });
    }
});


module.exports = router;
