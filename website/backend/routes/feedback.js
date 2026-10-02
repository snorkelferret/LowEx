// backend/routes/feedback.js
//
// Bug reports and suggestions, from anywhere in the portal.
//
// THE WHOLE POINT OF THIS ROUTE IS WHAT IT REFUSES TO READ. The actor comes
// from the session and the timestamp from the server clock. Neither is taken
// from the request body, and the body cannot influence either. A client-supplied
// "who" is a claim, not a fact; a client-supplied "when" is whatever the
// reporter's machine thinks the time is, which may be wrong by hours or set
// deliberately. A report you cannot trust about who sent it is not worth the
// row it occupies.
//
// The one thing the client DOES supply is page_url, because only the browser
// knows which page the report is about. That is the "where", and without it
// every report costs a round trip to interpret. It is untrusted like any other
// input: truncated on the way in (see shared/feedbackRules.mjs) and escaped on
// the way out.
//
// ANONYMOUS IS ALLOWED. Being unable to sign in is the single most likely thing
// to want to report, and by definition that person has no session. Those rows
// record a null user_id, which is not missing data — it says the report came
// from outside, and that is usually the fault being reported.

const express = require('express');
const router = express.Router();

const db = require('../db');
const audit = require('../lib/audit');
const {
    authenticateToken,
    requireRole,
    optionalAuth,
} = require('../middleware/auth');

const {
    validateFeedback,
    normalisePageUrl,
} = require('../../shared/feedbackRules.mjs');


// ============================================================
// Rate limiting
// ============================================================
//
// This is the ONLY write endpoint in the system that does not require a
// session, so it is the only one where "who is this" has no answer and the
// usual answer to abuse — deactivate the account — is unavailable. Hence a
// limiter.
//
// In memory and per-process, deliberately: it resets on restart and would not
// survive a second server instance. That is enough for the job it does, which
// is to stop one person emptying a textarea into the table in a loop. A real
// sink would need shared storage; this is not one.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 20;

const recent = new Map(); // key -> array of timestamps

function rateLimit(key) {
    const now = Date.now();
    const hits = (recent.get(key) || []).filter(t => now - t < WINDOW_MS);

    if (hits.length >= MAX_PER_WINDOW) {
        recent.set(key, hits);
        return false;
    }

    hits.push(now);
    recent.set(key, hits);

    // Without this the map grows once per distinct key forever. Cheap enough to
    // do inline at this size.
    if (recent.size > 1000) {
        for (const [k, v] of recent) {
            if (v.every(t => now - t >= WINDOW_MS)) recent.delete(k);
        }
    }

    return true;
}

// Behind a proxy this is the proxy's address unless trust proxy is set, in
// which case req.ip is already the real one. Either way it is only a bucket
// key, never stored.
function clientKey(req) {
    return req.user ? `user:${req.user.id}` : `ip:${req.ip}`;
}


// ============================================================
// POST /api/feedback
// ============================================================
//
// Open to everyone, signed in or not.
//
// Body: { kind, message, contact?, page_url? }
//
// Returns 201 with the id, or 400 with errors keyed by field so the client can
// point at the offending input instead of dumping one string somewhere.
// ============================================================

router.post('/', optionalAuth, (req, res) => {
    const result = validateFeedback(req.body || {});

    if (!result.ok) {
        return res.status(400).json({
            error: 'That report could not be sent.',
            errors: result.errors,
        });
    }

    if (!rateLimit(clientKey(req))) {
        return res.status(429).json({
            error:
                'That is a lot of reports in a short time. Please wait a while ' +
                'before sending another.',
        });
    }

    const { kind, message, contact } = result.value;
    const pageUrl = normalisePageUrl(req.body?.page_url);

    try {
        const { lastInsertRowid } = db.prepare(`
            INSERT INTO feedback (
                user_id,
                username,
                role,
                contact_email,
                kind,
                message,
                page_url
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            // From the session, never from the body.
            req.user?.id ?? null,
            req.user?.username ?? null,
            req.user?.role ?? null,
            contact,
            kind,
            message,
            pageUrl || null
        );

        return res.status(201).json({
            id: Number(lastInsertRowid),
            received: true,
            // Told plainly so the reporter knows whether to expect an answer.
            signed_in: Boolean(req.user),
        });

    } catch (err) {
        console.error('Failed to store feedback:', err);

        return res.status(500).json({
            error: 'That report could not be sent. Please try again.'
        });
    }
});


// ============================================================
// GET /api/feedback
// ============================================================
//
// Admin and superuser only. Reports can contain anything — a fragment of a
// customer's data pasted into a bug report is the usual way — so they are not
// readable by whoever happens to be signed in.
//
// Optional ?status=open|resolved|all, defaulting to open, because the list
// anyone actually wants is the one that still needs doing.
//
// THERE IS NO UI FOR THIS YET. See TODO item 28: the admin pages are next, and
// this is one of the things waiting on them. Until then it is an API only.
// ============================================================

const FEEDBACK_STATUSES = ['open', 'resolved', 'all'];

router.get(
    '/',
    authenticateToken,
    requireRole('admin', 'superuser'),

    (req, res) => {
        const status = String(req.query.status || 'open').toLowerCase();

        if (!FEEDBACK_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Status must be one of: ${FEEDBACK_STATUSES.join(', ')}.`
            });
        }

        try {
            const columns = `
                id,
                user_id,
                username,
                role,
                contact_email,
                kind,
                message,
                page_url,
                status,
                resolution_note,
                resolved_at,
                resolved_by,
                created_at
            `;

            const reports = status === 'all'
                ? db.prepare(`
                    SELECT ${columns}
                    FROM feedback
                    ORDER BY created_at DESC, id DESC
                  `).all()
                : db.prepare(`
                    SELECT ${columns}
                    FROM feedback
                    WHERE status = ?
                    ORDER BY created_at DESC, id DESC
                  `).all(status);

            const counts = db.prepare(`
                SELECT
                    SUM(status = 'open')     AS open,
                    SUM(status = 'resolved') AS resolved,
                    COUNT(*)                 AS total
                FROM feedback
            `).get();

            return res.json({ status, counts, reports });

        } catch (err) {
            console.error('Failed to read feedback:', err);

            return res.status(500).json({
                error: 'Could not load the reports'
            });
        }
    }
);


// ============================================================
// POST /api/feedback/:id/resolve
// ============================================================
//
// Marks a report done. Admin and superuser only, audit-logged.
//
// The note is optional but the status change is not: a report that is resolved
// with no record of what was done is only marginally better than one that was
// never read.
//
// No UI yet — same as GET above. See TODO item 28.
// ============================================================

router.post(
    '/:id/resolve',
    authenticateToken,
    requireRole('admin', 'superuser'),

    (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isInteger(id)) {
            return res.status(400).json({ error: 'Invalid report ID' });
        }

        const note = String(req.body?.resolution_note || '').trim();

        try {
            const report = db.prepare(`
                SELECT id, status, kind
                FROM feedback
                WHERE id = ?
            `).get(id);

            if (!report) {
                return res.status(404).json({ error: 'Report not found' });
            }

            if (report.status === 'resolved') {
                return res.json({
                    id: report.id,
                    status: 'resolved',
                    changed: false,
                });
            }

            db.transaction(() => {
                db.prepare(`
                    UPDATE feedback
                    SET
                        status = 'resolved',
                        resolution_note = ?,
                        resolved_by = ?,
                        resolved_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(note || null, req.user.id, id);

                audit.record(
                    req.user.id,
                    'feedback.resolve',
                    `feedback:${id}`,
                    { kind: report.kind, note: note || null }
                );
            })();

            return res.json({
                id: report.id,
                status: 'resolved',
                changed: true,
            });

        } catch (err) {
            console.error('Failed to resolve feedback:', err);

            return res.status(500).json({
                error: 'Could not update the report'
            });
        }
    }
);


module.exports = router;
