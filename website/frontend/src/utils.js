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

// formatFileSize used to live here. It now lives in shared/formatBytes.mjs —
// see that file for why: the server had its own copy, and the two had already
// drifted to one decimal and two for the same figure. The client imports it
// from shared like everything else that both halves need.
