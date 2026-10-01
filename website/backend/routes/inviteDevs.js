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
const { canAssignRole, assignableRolesFor } = require('../lib/roles');
const {
    INVITE_VALID_DAYS,
    MAX_REISSUES,
    DISPLAY_STATUS_SQL,
    REISSUE_REFUSALS,
    inviteLinkFor,
    canReissue,
} = require('../lib/invites');

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
        const rows = db.prepare(`
            SELECT
                id,
                email,
                assigned_role            AS role,
                ${DISPLAY_STATUS_SQL}        AS status,
                expires_at               AS expiresAt,
                reissue_count            AS reissueCount,
                last_reissued_at         AS lastReissuedAt,
                created_at               AS createdAt
            FROM invitations
            ORDER BY id DESC
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
 * The link is returned in the response rather than emailed, because there is
 * no mail transport yet (see TODO). That is a stopgap: it means the inviter
 * has to pass the link on by hand.
 */
router.post('/generate-invite', authenticateToken, requireAdmin, (req, res) => {
    const email = String(req.body?.email || '').trim();
    const role = String(req.body?.role || 'user').trim();

    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
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

        db.prepare(`
            INSERT INTO invitations (
                email, assigned_role, token, status,
                reissue_count, expires_at, created_at
            )
            VALUES (?, ?, ?, 'pending', 0, datetime('now', ?), datetime('now'))
        `).run(email, role, token, `+${INVITE_VALID_DAYS} days`);

        return res.json({
            success: true,
            email,
            role,
            inviteLink: linkFor(token),
            expiresInDays: INVITE_VALID_DAYS,
            note: 'No mail transport yet — pass this link on yourself.'
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
router.post('/request-reissue', (req, res) => {
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
        `).run(newToken, `+${INVITE_VALID_DAYS} days`, invite.id);

        const updated = db.prepare(
            'SELECT reissue_count, expires_at FROM invitations WHERE id = ?'
        ).get(invite.id);

        return res.json({
            success: true,
            reissuesRemaining: MAX_REISSUES - updated.reissue_count,
            expiresAt: updated.expires_at,
            // Returned rather than emailed, for the same reason as above.
            inviteLink: linkFor(newToken),
            message: `Invitation reissued. A new ${INVITE_VALID_DAYS}-day link has been generated.`
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
router.post('/:id/reissue', authenticateToken, requireAdmin, (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid invitation ID' });
    }

    try {
        const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(id);

        if (!invite) {
            return res.status(404).json({ error: 'Invitation not found' });
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
        `).run(newToken, `+${INVITE_VALID_DAYS} days`, id);

        const updated = db.prepare(
            'SELECT reissue_count, expires_at FROM invitations WHERE id = ?'
        ).get(id);

        return res.json({
            success: true,
            id,
            email: invite.email,
            inviteLink: linkFor(newToken),
            reissuesRemaining: MAX_REISSUES - updated.reissue_count,
            expiresAt: updated.expires_at,
            note: 'No mail transport yet — pass this link on yourself.'
        });

    } catch (err) {
        console.error('Error reissuing invitation:', err);
        return res.status(500).json({ error: 'Failed to reissue invitation.' });
    }
});


module.exports = router;
