// backend/lib/audit.js
//
// The audit trail. audit_logs has existed in the schema since it was written
// and nothing has ever inserted into it. This is its first use.
//
// WHO DID WHAT, TO WHOM, WHEN. The table is deliberately generic — actor,
// action, target, details — because the actions worth recording are not all
// the same shape, and inventing a column per action would make it worst-of-both
// rather than flexible.
//
// IMPORTANT: this does not catch its own errors. Callers are expected to write
// the record INSIDE the same transaction as the change it describes, so the two
// succeed or fail together. An action nobody can account for is worse than an
// action that did not happen — if the record cannot be written, the change
// should not stand.
//
// (The usual pattern is to swallow audit failures so they cannot break the
// operation. That is the wrong trade here: these are the actions someone will
// one day need to answer questions about.)

const db = require('./../db');

const insert = db.prepare(`
    INSERT INTO audit_logs (actor_id, action, target, details)
    VALUES (?, ?, ?, ?)
`);

/**
 * Record one action.
 *
 * @param actorId  who did it — an id, never a username, so a later rename does
 *                 not orphan the record
 * @param action   a stable dotted verb, e.g. 'user.deactivate'. Kept in code
 *                 rather than free text so it can be filtered on.
 * @param target   what it was done to, as a string. For a user, the username at
 *                 the time — the actor id is the link, this is for reading.
 * @param details  optional object, JSON-encoded.
 */
function record(actorId, action, target, details = null) {
    insert.run(
        actorId ?? null,
        action,
        target === null || target === undefined ? null : String(target),
        details ? JSON.stringify(details) : null
    );
}

module.exports = { record };
