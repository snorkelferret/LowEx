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
// WARNING AT 85, CRITICAL AT 95, and the gap is not decoration. An upload needs
// room to be written before it can be refused, and a filesystem at zero free is
// not merely full — SQLite cannot write its WAL, so the portal stops accepting
// anything at all, logins included, and the fix has to come from a shell. The
// margin exists so the portal is still usable, and still saying what is wrong,
// when the warning becomes true.

export const WARNING_PERCENT = 85;
export const CRITICAL_PERCENT = 95;

// A percentage, a band. Unknown or missing input is 'ok' rather than 'critical':
// a figure that failed to arrive is not evidence of a full disk, and a screen
// that cries wolf on a missing number gets ignored on the day it is right.
export function usageStatus(percent) {
    const value = Number(percent);

    if (!Number.isFinite(value)) return 'ok';
    if (value >= CRITICAL_PERCENT) return 'critical';
    if (value >= WARNING_PERCENT) return 'warning';
    return 'ok';
}

// The worse of two bands — for a measurement that can fail two ways at once,
// like a disk whose space and whose file table both run out. Either one alone
// stops every write, so the worse one is the honest answer.
export function worstStatus(...statuses) {
    if (statuses.includes('critical')) return 'critical';
    if (statuses.includes('warning')) return 'warning';
    return 'ok';
}
