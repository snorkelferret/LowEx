// frontend/src/api.js
//
// Calling the API from a page that needs a session.
//
// THE BUG THIS EXISTS FOR. Two things decide whether you are signed in, and
// they do not expire together:
//
//   * localStorage.user_info — written at login, NEVER expires. It is what the
//     page guard reads, so the page renders.
//   * the session cookie — expires after 8 hours. It is what the API reads.
//
// So eight hours in, the dashboard draws perfectly, greets you by name from
// localStorage, and then every panel says "Authentication required" — with
// nothing on the page saying why or what to do. Nothing redirected: every call
// site showed the error and stayed put.
//
// ONE PLACE HANDLES IT. Every dashboard call goes through here, so an expired
// session is dealt with once rather than in twenty catch blocks, and the
// behaviour cannot differ between panels.
//
// NOT FOR THE SIGN-IN PAGE. /api/auth/login answers 401 for a wrong password —
// the same status an expired session gives. Redirecting on 401 there would
// bounce someone back to the form they just failed on, for ever. So this is for
// pages you can only be on WITH a session; the login and invitation flows use
// plain fetch deliberately.

const SIGN_IN_PAGE = '/shopfront.html';

// Shown on the sign-in page, so arriving there explains itself rather than
// looking like a stray redirect.
export const EXPIRED_PARAM = 'session';
export const EXPIRED_VALUE = 'expired';

let signingOut = false;

function endExpiredSession() {
    // Several panels load at once, so several calls can 401 together. The
    // first one signs out; the rest must not fight over the redirect.
    if (signingOut) return;
    signingOut = true;

    // The stale profile is the thing that made the page render as signed in.
    // Leaving it would put the next page in the same state.
    try {
        localStorage.removeItem('user_info');
    } catch {
        // Private mode, or storage disabled. Nothing to clear.
    }

    window.location.href = `${SIGN_IN_PAGE}?${EXPIRED_PARAM}=${EXPIRED_VALUE}`;
}

/**
 * fetch(), for a page that requires a session.
 *
 * Returns the Response unchanged for anything other than 401, so callers keep
 * doing their own error handling — this only takes over the one case they
 * cannot deal with themselves.
 *
 * On 401 it never returns: the session is over, the page is about to be
 * replaced, and any code still waiting on this should not run.
 */
export async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'include',
        ...options,
    });

    if (response.status === 401) {
        endExpiredSession();

        // Never resolves. A caller awaiting this is on a page that is being
        // navigated away from, and running its catch block would put an error
        // on screen for a fraction of a second on the way out.
        return new Promise(() => {});
    }

    return response;
}
