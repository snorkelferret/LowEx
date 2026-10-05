// backend/routes/admin.js
//
// Admin operations. Everything here requires admin or superuser.
//
// ACCOUNT LIFECYCLE. Deactivation is how access is revoked — there is no
// delete, and there should not be: a user id is referenced by every asset,
// version, approval and check they ever touched, so removing the row would
// either fail or orphan the history.
//
// is_active = 0 takes effect IMMEDIATELY. authenticateToken re-reads is_active
// on every request rather than trusting the token, so a deactivated account
// stops working on its next request rather than whenever its token expires.
// That is the property that makes revocation real, and it is worth not
// breaking.

const express = require('express');
const router = express.Router();

const db = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { isStrictlyBelow } = require('../lib/roles');
const audit = require('../lib/audit');
// The two storage questions. Kept as libraries because each is asked on more
// than one screen and the answers must not diverge — see each file for why they
// are separate questions.
const { hostStorage } = require('../lib/hostStorage');
const { workspaceUsage, workspaceLimitBytes } = require('../lib/workspaceUsage');
// The admin-editable values, and the registry that bounds them. Every read
// inside hits the database, so a change made here is in force immediately.
const settings = require('../lib/settings');

// All routes require at least Admin privilege
router.use(authenticateToken, requireAdmin);

// Ordered most senior first, so the top of the list is who can do the most.
const BY_RANK = `
    ORDER BY
        CASE role
            WHEN 'superuser' THEN 0
            WHEN 'admin'     THEN 1
            WHEN 'developer' THEN 2
            ELSE 3
        END,
        username COLLATE NOCASE
`;

// Never selected, anywhere: password_hash and two_factor_secret. Listed
// explicitly rather than with SELECT * so that cannot drift.
const USER_FIELDS = `
    id,
    username,
    email,
    role,
    is_active,
    is_2fa_enabled,
    created_at,
    -- How this account came to exist. NULL means nothing in this application
    -- created it, which is the thing the check below looks for. See the column
    -- declaration in db.js for why it has no default.
    created_via
`;

/**
 * GET /api/admin/stats
 *
 * Real counts. These used to be hardcoded — activeUsers: 12, totalOrders: 148,
 * serverStatus: 'Healthy' — which was harmless while nothing read it and
 * actively misleading once the panel started showing it.
 */
router.get('/stats', (req, res) => {
    try {
        const users = db.prepare(`
            SELECT
                COUNT(*)                                          AS total,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END)     AS active
            FROM users
        `).get();

        return res.json({
            activeUsers: users.active || 0,
            totalUsers: users.total || 0,
            pendingInvitations: db.prepare(`
                SELECT COUNT(*) AS c
                FROM invitations
                WHERE status = 'pending'
                  AND (expires_at IS NULL OR datetime('now') <= expires_at)
            `).get().c,
        });

    } catch (err) {
        console.error('Failed to build admin stats:', err);
        return res.status(500).json({ error: 'Failed to load stats' });
    }
});


/**
 * GET /api/admin/audit?action=...&limit=...
 *
 * The audit trail, newest first.
 *
 * THIS HAS BEEN WRITTEN TO SINCE THE BEGINNING AND READABLE BY NOTHING. Every
 * deactivation, category retag, report resolution, restore, purge and daily job
 * run lands in audit_logs, and until now the only way to see any of it was a
 * terminal. An audit trail nobody can read is a write-only table.
 *
 * WHO. actor_id joins to users for a name, but it is NULLABLE ON PURPOSE and
 * that is meaningful rather than missing: the daily job acts on its own, and
 * attributing that to whoever happened to be signed in would be a lie. A null
 * actor is rendered as "system" here, from the server, so the client cannot
 * invent its own wording for it.
 *
 * details is JSON and its shape DIFFERS PER ACTION — from/to for a retag,
 * files/bytes for a purge. It is passed through as text rather than parsed into
 * columns, because inventing a common shape would lose whichever fields do not
 * fit it.
 */
router.get('/audit', (req, res) => {
    const action = String(req.query?.action || '').trim();

    // A cap, because this table only ever grows. Newest first, so the cap drops
    // the oldest rather than the most relevant.
    const requested = Number(req.query?.limit);
    const limit = Number.isInteger(requested) && requested > 0
        ? Math.min(requested, 500)
        : 100;

    try {
        const entries = db.prepare(`
            SELECT
                al.id,
                al.action,
                al.target,
                al.details,
                al.created_at,
                al.actor_id,
                u.username AS actor_username,
                u.role     AS actor_role
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.actor_id
            ${action ? 'WHERE al.action = ?' : ''}
            ORDER BY al.created_at DESC, al.id DESC
            LIMIT ?
        `).all(...(action ? [action, limit] : [limit]));

        // What the filter offers, from the data rather than a list in the code:
        // a new action appears in the dropdown the first time it is recorded,
        // with nothing to remember to update.
        const actions = db.prepare(`
            SELECT action, COUNT(*) AS count
            FROM audit_logs
            GROUP BY action
            ORDER BY action
        `).all();

        return res.json({
            action: action || null,
            limit,
            total: db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c,
            actions,
            entries,
        });

    } catch (err) {
        console.error('Failed to read the audit log:', err);
        return res.status(500).json({ error: 'Failed to load the audit log' });
    }
});


/**
 * GET /api/admin/storage
 *
 * Two questions, kept apart because their answers do not reconcile.
 *
 * WHAT THE DISK HOLDS — from backend/lib/hostStorage.js. Bytes and inodes on
 * the filesystem the blobs live on, with a status of ok / warning / critical.
 *
 * WHAT DEVELOPER WORKSPACES HOLD — per workspace, from
 * backend/lib/workspaceUsage.js. Not "charged": nobody is billed for putting
 * files here, and the word invited exactly that misreading. THE SAME FUNCTION THE DEVELOPER'S OWN PANEL
 * CALLS, deliberately: if this route summed the tables itself the two screens
 * would eventually disagree, and the developer would be told they have room
 * while the admin was told they did not. Same function, same answer, by
 * construction.
 *
 * THE TWO TOTALS ARE NOT SUPPOSED TO MATCH and the panel says so in as many
 * words. Workspace bytes exclude the game store, count a shared blob once per
 * workspace holding it, and ignore soft-deleted rows; disk bytes are every blob
 * once. The difference is the game store, plus whatever the collector has not
 * reached yet. An administrator who assumes one should equal the other will
 * report the accounting as broken.
 */
router.get('/storage', (req, res) => {
    try {
        const host = hostStorage();

        // What the store actually occupies. One row per SHA and one blob per
        // row — the flat content-addressed layout — so this is the store's real
        // size and not an estimate.
        const store = db.prepare(`
            SELECT COUNT(*) AS blob_count, COALESCE(SUM(file_size), 0) AS bytes
            FROM stored_files
        `).get();

        // Every developer account, including one that has never uploaded and so
        // has no workspace row. A list that silently omits them reads as "these
        // are all the developers", which is a different and wrong claim.
        //
        // Ordered by what they hold, largest first: the tab exists to show who
        // is near the limit, and that should be the first thing on it.
        const accounts = db.prepare(`
            SELECT
                u.id       AS developer_id,
                u.username,
                u.email,
                u.is_active,
                dw.id      AS workspace_id
            FROM users u
            LEFT JOIN developer_workspaces dw ON dw.developer_id = u.id
            WHERE u.role = 'developer' OR dw.id IS NOT NULL
        `).all();

        const developers = accounts.map(account => {
            // No workspace is genuinely zero, not unknown: nothing has been
            // uploaded, because a workspace is created by uploading.
            const usage = account.workspace_id
                ? workspaceUsage(account.workspace_id)
                : {
                    bytes: 0,
                    file_count: 0,
                    percent_used: 0,
                    status: 'ok',
                    limit_bytes: workspaceLimitBytes(),
                    remaining_bytes: workspaceLimitBytes()
                };

            return {
                developer_id: account.developer_id,
                username: account.username,
                email: account.email,
                is_active: account.is_active,
                workspace_id: account.workspace_id,
                ...usage
            };
        }).sort((a, b) => b.bytes - a.bytes);

        const held_bytes = developers.reduce((sum, d) => sum + d.bytes, 0);

        return res.json({
            host,
            store: {
                blob_count: store.blob_count,
                bytes: store.bytes
            },
            // NAMED FOR WHAT IT IS. This was "charged", which read as money owed
            // — nobody is billed for putting files on this server. It is
            // storage held in developer workspaces, and the label goes with the
            // figure so the distinction survives being read quickly.
            workspaces: {
                bytes: held_bytes,
                developer_count: developers.length
            },
            developers
        });

    } catch (err) {
        console.error('Failed to read storage figures:', err);
        return res.status(500).json({ error: 'Failed to load storage figures' });
    }
});


/**
 * GET /api/admin/settings
 *
 * Every setting, with what it is in force, what it would fall back to, what it
 * may be set to, and the note to show beside it. The panel renders what it is
 * given rather than knowing any of the keys, so adding a setting is a line in
 * backend/lib/settings.js and nothing here.
 *
 * The values are read here and now, not cached — which is the point of the
 * whole mechanism. See the header of settings.js for why.
 */
router.get('/settings', (req, res) => {
    try {
        return res.json({ settings: settings.getSettings() });

    } catch (err) {
        console.error('Failed to read settings:', err);
        return res.status(500).json({ error: 'Failed to load settings' });
    }
});


/**
 * POST /api/admin/settings/:key  { value }
 *
 * Change one setting. Recorded in the audit trail with who did it and what it
 * was before, in the same transaction as the change — an administrator changing
 * the invite window is changing a rule everyone else is held to, so "who moved
 * this" is part of the change rather than a note about it.
 *
 * A REFUSED VALUE IS NOT A FAILURE OF THE REQUEST. Out-of-range values come
 * back as 400 with the reason, because the reason is the useful part: "must be
 * between 1 and 365 days" tells the administrator what to type instead, and
 * this message goes straight onto the page.
 */
router.post('/settings/:key', (req, res) => {
    const key = String(req.params.key || '');

    // The body arrives as JSON, but a form-encoded post would give a string,
    // and the registry coerces either.
    const value = req.body?.value;

    if (value === undefined || value === null || value === '') {
        return res.status(400).json({ error: 'No value was given.' });
    }

    try {
        const result = settings.setSetting(key, value, req.user.id);

        return res.json({
            key: result.key,
            value: result.value,
            previous: result.previous,
            settings: settings.getSettings(),
        });

    } catch (err) {
        // An unknown key is a bad request, not a server fault: the caller named
        // something that does not exist. Anything else is unexpected.
        if (err.message?.startsWith('settings: unknown key')) {
            return res.status(404).json({ error: 'No such setting.' });
        }

        if (err.message?.startsWith('settings:')) {
            console.error('Failed to save setting:', err);
            return res.status(500).json({ error: 'Failed to save the setting' });
        }

        return res.status(400).json({ error: err.message });
    }
});


/**
 * POST /api/admin/settings/:key/reset
 *
 * Back to the default, by removing the row rather than writing the default into
 * it — so there is one place the default can come from, and "reset" leaves the
 * table saying exactly what has been deliberately overridden.
 */
router.post('/settings/:key/reset', (req, res) => {
    const key = String(req.params.key || '');

    try {
        const result = settings.resetSetting(key, req.user.id);

        return res.json({
            key: result.key,
            value: result.value,
            previous: result.previous,
            changed: result.changed,
            settings: settings.getSettings(),
        });

    } catch (err) {
        if (err.message?.startsWith('settings: unknown key')) {
            return res.status(404).json({ error: 'No such setting.' });
        }

        console.error('Failed to reset setting:', err);
        return res.status(500).json({ error: 'Failed to reset the setting' });
    }
});


/**
 * GET /api/admin/users?status=active|inactive|all
 *
 * Everyone, newest-role-first. The caller's own account is included and marked,
 * because hiding it would make the list look wrong to the person reading it.
 */
router.get('/users', (req, res) => {
    const status = String(req.query?.status || 'all');

    const where = {
        active: 'WHERE is_active = 1',
        inactive: 'WHERE is_active = 0',
        all: '',
    }[status];

    if (where === undefined) {
        return res.status(400).json({
            error: 'Invalid status. Expected one of: active, inactive, all'
        });
    }

    try {
        const users = db.prepare(`
            SELECT ${USER_FIELDS}
            FROM users
            ${where}
            ${BY_RANK}
        `).all();

        // ACCOUNTS NOT ACCOUNTED FOR.
        //
        // Every account should be explicable: made at bootstrap, redeemed from
        // an invitation, or arrived through Google. An account with no recorded
        // origin is one that nothing in this application created — somebody
        // inserted it directly.
        //
        // It cannot be a complete answer, and it is not pretending to be one: a
        // determined hand can write a created_via alongside the row. What it
        // catches is the ordinary case, which is an ad-hoc command that does
        // not know the column exists. That is how the account this check was
        // written for got here.
        const unaccounted = users.filter(user => !user.created_via);

        return res.json({
            status,
            count: users.length,
            // Named so the panel does not have to derive it, and so the rule
            // lives here rather than in the client.
            unaccounted: unaccounted.map(user => ({
                id: user.id,
                username: user.username,
                role: user.role,
                created_at: user.created_at,
            })),
            users: users.map(user => ({
                ...user,
                is_self: user.id === req.user.id,
                // Whether THIS caller may deactivate them — so the UI can
                // disable a button rather than let someone click into a 403.
                // Computed here rather than in the client so the rule lives in
                // one place and cannot drift from what the route enforces.
                can_deactivate:
                    user.id !== req.user.id &&
                    user.is_active === 1 &&
                    isStrictlyBelow(req.user.role, user.role),
                can_reactivate:
                    user.id !== req.user.id &&
                    user.is_active === 0 &&
                    isStrictlyBelow(req.user.role, user.role),
            })),
        });

    } catch (err) {
        console.error('Failed to list users:', err);
        return res.status(500).json({ error: 'Failed to load users' });
    }
});


// ---------------------------------------------------------------------------
// Deactivate / reactivate
// ---------------------------------------------------------------------------

/**
 * Shared by both directions, because the guards are identical — only the value
 * written differs. Two copies of these checks would drift, and the drift would
 * be a permission hole rather than a cosmetic bug.
 */
function setUserActive(req, res, nextActive, action) {
    const actorId = req.user.id;
    const targetId = Number(req.params.id);

    if (!Number.isInteger(targetId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }

    const target = db.prepare(`
        SELECT id, username, role, is_active
        FROM users
        WHERE id = ?
    `).get(targetId);

    if (!target) {
        return res.status(404).json({ error: 'User not found' });
    }

    // Not yourself. An admin erroring into their own lockout has no way back
    // in except editing the database, and this is a button someone will
    // eventually press while tired.
    if (target.id === actorId) {
        return res.status(409).json({
            error: `You cannot ${action} your own account.`
        });
    }

    // Strictly below. An admin cannot deactivate another admin, and a superuser
    // cannot deactivate another superuser — so a peer cannot be removed, and
    // the last superuser cannot be locked out by a rival.
    if (!isStrictlyBelow(req.user.role, target.role)) {
        return res.status(403).json({
            error:
                `You cannot ${action} "${target.username}": they are a ` +
                `${target.role}, which is not below your own role (${req.user.role}).`
        });
    }

    if (target.is_active === nextActive) {
        return res.json({
            success: true,
            id: target.id,
            username: target.username,
            is_active: nextActive,
            note: 'Already in that state; nothing changed.'
        });
    }

    try {
        // The audit record is written INSIDE the transaction, so the change and
        // the record of it succeed or fail together. An unaudited change to
        // someone's access is worse than no change.
        const apply = db.transaction(() => {
            db.prepare('UPDATE users SET is_active = ? WHERE id = ?')
                .run(nextActive, target.id);

            audit.record(actorId, `user.${action}`, target.username, {
                role: target.role,
                from: target.is_active,
                to: nextActive,
            });
        });

        apply();

        return res.json({
            success: true,
            id: target.id,
            username: target.username,
            role: target.role,
            is_active: nextActive,
            note: nextActive === 0
                ? 'Access is revoked immediately — their next request will be refused.'
                : 'They can sign in again.',
        });

    } catch (err) {
        console.error(`Failed to ${action} user:`, err);
        return res.status(500).json({ error: `Failed to ${action} the account` });
    }
}

/**
 * POST /api/admin/users/:id/deactivate
 *
 * The revocation mechanism. An invitation can be withdrawn before it is used;
 * this is what withdrawing access afterwards looks like.
 *
 * Note this does NOT touch anything the user created. Their assets, versions
 * and approvals stay — the work belongs to the project, not to the account.
 */
router.post('/users/:id/deactivate', (req, res) => {
    return setUserActive(req, res, 0, 'deactivate');
});

/**
 * POST /api/admin/users/:id/reactivate
 */
router.post('/users/:id/reactivate', (req, res) => {
    return setUserActive(req, res, 1, 'reactivate');
});

module.exports = router;
