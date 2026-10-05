// backend/lib/retention.js
//
// How long the wastebin keeps things before their files are removed.
//
// A LIBRARY RATHER THAN A CONSTANT IN THE ROUTE, because two different things
// need the same number and they must not disagree: the route that shows a
// developer what is in their bin and when it expires, and the scheduled purge
// that will one day empty it (TODO 32). A developer told "3 days left" and then
// emptied on day 12 has been misled, and the two figures would have come from
// the same number only by luck.
//
// THE SERVER COMPUTES, THE CLIENT DISPLAYS. The bin endpoint returns expires_at
// and days_remaining per item rather than sending the retention period for the
// browser to do arithmetic with. A countdown the client calculates is a
// countdown that depends on the client's clock, which may be wrong by hours —
// and the one thing a countdown must be is right.
//
// THIS IS NOW AN ADMIN SETTING, as this file always said it would be — read
// through backend/lib/settings.js, per call, so a change takes effect without a
// restart.
//
// THE READ SITE IS WHY THIS ONE CONVERTED CLEANLY. The window is read inside
// retentionFor(), not at module scope, so it was already evaluated per call.
// Every other consumer of this number imported it by destructuring, which
// copies it once at require time — those had to be changed to call
// retentionDays() instead. See the note in settings.js: the import style is the
// bug, not the constant.
//
// KEEPING THE READ HERE MEANS the route that tells a developer what is in their
// bin and the purge that will empty it still cannot disagree, which is the
// reason this file exists.

const settings = require('./settings');

/**
 * The window in force right now.
 *
 * A function rather than a value, deliberately: `const RETENTION_DAYS =
 * getSetting(...)` at module scope would freeze it at boot and reintroduce the
 * exact bug this replaced.
 */
function retentionDays() {
    return settings.getSetting('retention_days');
}

/**
 * When something deleted now would expire.
 *
 * @param deletedAt  a SQLite DATETIME string, 'YYYY-MM-DD HH:MM:SS' in UTC
 * @returns { expires_at, days_remaining } or nulls if there is no deleted_at
 *
 * SQLite stores UTC without a timezone marker, so it is read as UTC
 * explicitly. Reading it as local time would shift the whole window by the
 * server's offset, which is the kind of bug that only shows up after a
 * timezone change.
 */
function retentionFor(deletedAt, now = new Date()) {
    if (!deletedAt) {
        return { expires_at: null, days_remaining: null };
    }

    const deleted = new Date(`${String(deletedAt).replace(' ', 'T')}Z`);

    if (Number.isNaN(deleted.getTime())) {
        return { expires_at: null, days_remaining: null };
    }

    const expires = new Date(deleted.getTime() + retentionDays() * 86400000);

    // Rounded UP, so anything still in the bin reads as at least 1 day rather
    // than 0 — "0 days left" reads as already gone, and something that has not
    // been purged yet is not gone.
    const daysRemaining = Math.max(
        0,
        Math.ceil((expires.getTime() - now.getTime()) / 86400000)
    );

    return {
        expires_at: expires.toISOString().slice(0, 19).replace('T', ' '),
        days_remaining: daysRemaining,
    };
}

// RETENTION_DAYS is no longer exported as a value — it is a setting, and a
// value exported from here would be a snapshot that callers could hold. Call
// retentionDays() where the number is needed.
module.exports = { retentionDays, retentionFor };
