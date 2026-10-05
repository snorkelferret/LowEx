// shared/usageStatus.mjs
//
// How full is too full. The ONE place that decides.
//
// WHY THIS IS SHARED. The disk, the inode table and every developer's quota are
// all "a proportion of a limit", and the question "is this a problem yet?" must
// get the same answer wherever it is asked. A threshold copied into a second
// file is a threshold that will be moved in one of them — and the failure is
// silent and asymmetric: the admin's screen says a developer is fine while the
// developer's own screen is refusing their upload, or worse, the reverse.
//
// So neither the admin panel nor the developer panel decides this. They are
// sent a band and they display it. The client is not trusted to agree because
// it is not asked.
//
// THE LEVELS ARE NOW ARGUMENTS, not constants, because they are an admin
// setting (backend/lib/settings.js). The defaults below are what apply when
// nobody has overridden them, and they are the values this file shipped with —
// so a caller that passes nothing behaves exactly as it did before.
//
// THEY ARE PASSED IN RATHER THAN LOOKED UP HERE, and that is not a style
// choice. This file lives in shared/, the directory for code BOTH halves of the
// app use, so the frontend may import it. A module the browser can load must
// never reach for the database, and a function that fetched its own thresholds
// would have to. The caller reads the setting; this only does the arithmetic.
//
// THE GAP BETWEEN THEM IS NOT DECORATION. An upload needs room to be written
// before it can be refused, and a filesystem at zero free is not merely full —
// SQLite cannot write its WAL, so the portal stops accepting anything at all,
// logins included, and the fix has to come from a shell. The margin exists so
// the portal is still usable, and still saying what is wrong, when the warning
// becomes true.

export const DEFAULT_WARNING_PERCENT = 85;
export const DEFAULT_CRITICAL_PERCENT = 95;

/**
 * A percentage, a band.
 *
 * Unknown or missing input is 'ok' rather than 'critical': a figure that failed
 * to arrive is not evidence of a full disk, and a screen that cries wolf on a
 * missing number gets ignored on the day it is right.
 *
 * Levels that arrive malformed fall back to the defaults for the same reason —
 * a bad threshold should not turn a healthy disk red.
 */
export function usageStatus(percent, levels = {}) {
    const warning = finite(levels.warning, DEFAULT_WARNING_PERCENT);
    const critical = finite(levels.critical, DEFAULT_CRITICAL_PERCENT);

    const value = Number(percent);

    if (!Number.isFinite(value)) return 'ok';
    if (value >= critical) return 'critical';
    if (value >= warning) return 'warning';
    return 'ok';
}

function finite(value, fallback) {
    const number = Number(value);

    return Number.isFinite(number) ? number : fallback;
}

// The worse of two bands — for a measurement that can fail two ways at once,
// like a disk whose space and whose file table both run out. Either one alone
// stops every write, so the worse one is the honest answer.
export function worstStatus(...statuses) {
    if (statuses.includes('critical')) return 'critical';
    if (statuses.includes('warning')) return 'warning';
    return 'ok';
}
