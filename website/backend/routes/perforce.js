// backend/routes/perforce.js
//
// THE PORTAL IS TOLD. IT NEVER ASKS (TODO 88 §15, §16).
//
// ============================================================
// THE ONE DIRECTION
// ============================================================
//
//     PERFORCE -> PORTAL     this route: a post-commit notification
//     PORTAL -> PERFORCE     nothing. No query, no poll, no write.
//
// A changelist is committed in Perforce; a `change-commit` trigger — which
// runs AFTER the commit and cannot undo it — posts here. The portal records
// what it was told. If the portal is down, an event is lost and nothing else;
// no submit is ever stopped by this file, which is the point of choosing
// change-commit over change-submit.
//
// ============================================================
// A CREDENTIAL THAT CAN DO ONLY THIS
// ============================================================
//
// The trigger runs on the Perforce server, and a token with admin rights
// sitting in a trigger script is the same mistake as a password in a shell
// history (TODO 88 §15). So the notification is authenticated by its OWN shared
// secret, PERFORCE_TRIGGER_TOKEN, not by a session:
//
//   * unset           -> 503. Disabled rather than open.
//   * wrong           -> 401. Compared in constant time — the value is a secret,
//                        and a comparison that returns early leaks its length.
//
// It can do exactly one thing: write a notification row.
//
// ============================================================
// THE CURSOR, WHICH IS WHAT MAKES "ONLY TOLD" HONEST
// ============================================================
//
// A portal that cannot ask must be able to say what it last heard. The last
// changelist seen is kept in perforce_cursor; an incoming changelist further
// ahead than last + 1 is a GAP, and the response says so. A notification system
// with no cursor cannot tell "nothing happened" from "nothing was delivered".
//
// ============================================================
// AND THE SAME NOTIFICATION TWICE IS HARMLESS
// ============================================================
//
// changelist is UNIQUE, and the insert does nothing on a conflict. A trigger
// that fires twice, or a retry, leaves one row.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const db = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// THE BODY IS A FILE LIST, and a real submit can be large — the 3.1 MB LE001
// import was 245 files, and a binary-heavy submit is more. Five megabytes is a
// ceiling rather than a target: a notification bigger than this is far more
// likely to be a mistake than a changelist.
const notificationBody = express.json({ limit: '5mb' });

// The admin read below is cookie-authenticated; the notification is not. The
// parser is applied here because this router is mounted BEFORE the global one,
// so that the notification gets its own body limit.
router.use(cookieParser());

const insertChange = db.prepare(`
    INSERT INTO perforce_changes
        (changelist, username, client, stream, description, submitted_at, files)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (changelist) DO NOTHING
`);

const cursorNow = db.prepare('SELECT last_changelist, updated_at FROM perforce_cursor WHERE id = 1');

const advanceCursor = db.prepare(`
    UPDATE perforce_cursor
       SET last_changelist = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = 1 AND ? > last_changelist
`);

const listChanges = db.prepare(`
    SELECT changelist, username, client, stream, description, submitted_at, received_at, files
    FROM perforce_changes
    ORDER BY changelist DESC
    LIMIT ?
`);

// Constant-time comparison of the shared secret. Length is compared first
// because timingSafeEqual throws on different lengths — that early return
// leaks only the length, which a bearer token of fixed shape already reveals.
function tokenMatches(provided, expected) {
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(expected || ''));

    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
}

function requireTriggerToken(req, res, next) {
    const expected = process.env.PERFORCE_TRIGGER_TOKEN;

    // DISABLED, NOT OPEN. A portal with no token configured has no way to
    // authenticate a notify, so it refuses them all rather than trusting any.
    if (!expected) {
        return res.status(503).json({
            error: 'Perforce notifications are not configured on this portal.'
        });
    }

    const header = String(req.get('authorization') || '');
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!tokenMatches(provided, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
}

// ---------------------------------------------------------------------------
// POST /api/perforce/change-commit — the notification
// ---------------------------------------------------------------------------

router.post(
    '/change-commit',
    requireTriggerToken,
    notificationBody,

    (req, res) => {
        const body = req.body || {};

        const changelist = Number(body.changelist);

        if (!Number.isInteger(changelist) || changelist < 1) {
            return res.status(400).json({
                error: 'changelist must be a positive integer — the Perforce changelist number.'
            });
        }

        const username = String(body.user || '').trim();

        if (!username || username.length > 100) {
            return res.status(400).json({
                error: 'user is required — the Perforce user who submitted.'
            });
        }

        // FILES ARE THE POINT: they are what a later matcher maps to an
        // approved version. Absent is tolerated (an empty submit), malformed is
        // not.
        const files = body.files === undefined ? [] : body.files;

        if (!Array.isArray(files) || files.length > 20000
            || files.some(file => typeof file !== 'string' || file.length > 1024)) {
            return res.status(400).json({
                error: 'files must be an array of depot paths.'
            });
        }

        const text = (value, max) => {
            const trimmed = String(value ?? '').trim();
            return trimmed ? trimmed.slice(0, max) : null;
        };

        const client = text(body.client, 200);
        const stream = text(body.stream, 200);
        const description = text(body.description, 2000);
        const submittedAt = text(body.time, 40);

        try {
            const before = cursorNow.get();

            const result = insertChange.run(
                changelist,
                username,
                client,
                stream,
                description,
                submittedAt,
                files.length ? JSON.stringify(files) : null
            );

            advanceCursor.run(changelist, changelist);

            const after = cursorNow.get();

            // A GAP IS NOT AN ERROR — changelists can be missing for reasons
            // that are Perforce's own — but it is worth saying, because the
            // cursor exists so a missed notification is VISIBLE.
            const expected = before.last_changelist + 1;
            const gap = before.last_changelist > 0 && changelist > expected
                ? changelist - expected
                : 0;

            return res.status(result.changes ? 201 : 200).json({
                recorded: Boolean(result.changes),
                duplicate: !result.changes,
                changelist,
                files: files.length,
                gap,
                cursor: after.last_changelist
            });

        } catch (err) {
            console.error('Could not record a Perforce notification:', err);
            return res.status(500).json({ error: 'Could not record that notification' });
        }
    }
);

// ---------------------------------------------------------------------------
// GET /api/perforce/changes — what the portal has been told, for an admin
// ---------------------------------------------------------------------------

router.get(
    '/changes',
    authenticateToken,
    requireRole('admin'),

    (req, res) => {
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);

        const changes = listChanges.all(limit).map(row => ({
            changelist: row.changelist,
            user: row.username,
            client: row.client,
            stream: row.stream,
            description: row.description,
            submitted_at: row.submitted_at,
            received_at: row.received_at,
            files: row.files ? JSON.parse(row.files) : []
        }));

        return res.json({
            cursor: cursorNow.get(),
            changes
        });
    }
);

module.exports = router;
