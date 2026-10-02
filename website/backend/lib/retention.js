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
// THIS BECOMES AN ADMIN SETTING. The decision is that an administrator changes
// the retention from the admin page, which needs a settings mechanism the
// schema does not have yet (TODO 28). Until then it is a constant, and when it
// moves, it moves HERE — so the route and the purge keep reading the same
// answer without either of them changing.

const RETENTION_DAYS = 14;

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

    const expires = new Date(deleted.getTime() + RETENTION_DAYS * 86400000);

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

module.exports = { RETENTION_DAYS, retentionFor };
