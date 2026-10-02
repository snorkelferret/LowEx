// frontend/src/utils.js
//
// Small helpers shared by the client scripts.
//
// ONE COPY OF EACH. `$` was defined five times across the client files and
// escapeHtml three times. They were identical — but only by luck, and the
// failure mode of copies is that they diverge silently in the one that matters.
// A helper used in several places belongs in one place, not repeated.

export const $ = (id) => document.getElementById(id);

/**
 * Escape a value for interpolation into markup.
 *
 * Anything rendered from something a person chose — a username, an email
 * address, an asset name — goes through this. The invite table shipped without
 * it, so an invitation to `<img src=x onerror=...>` executed in the admin's
 * session.
 */
export function escapeHtml(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
}

/**
 * A file size in a unit a person can read.
 *
 * The exponent is derived rather than fixed: a hardcoded MB divisor rendered a
 * small limit as "0.0 MB" and a 5 GB one as "5120.0 MB".
 */
export function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];

    const exponent = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1
    );

    const value = bytes / Math.pow(1024, exponent);

    return `${value.toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}
