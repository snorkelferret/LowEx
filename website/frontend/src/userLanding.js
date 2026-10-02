// frontend/src/userLanding.js
//
// The landing page for a signed-in account — which, by definition, is what a
// tester is: a login with no extra privileges.
//
// It does two things: it refuses to show anything to someone who is not signed
// in, and it fills in who you are. There is deliberately no more than that,
// because the tester features do not exist yet and a page that pretended
// otherwise would have people hunting for downloads that are not there.

import { executeGlobalLogout } from './authUtils.js';
import { $ } from './utils.js';

const ROLE_LABELS = {
    user: 'a tester',
    developer: 'a developer',
    admin: 'an administrator',
    superuser: 'a superuser',
};

function readUser() {
    const raw = localStorage.getItem('user_info');
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        // A malformed profile is not worth breaking the page over, but it is
        // not a session either.
        localStorage.removeItem('user_info');
        return null;
    }
}

const user = readUser();

if (!user || !user.role) {
    // Not signed in. The cookie may still be valid — this page cannot tell —
    // but without the profile there is nothing to show, so send them to sign
    // in rather than rendering an empty shell.
    window.location.href = '/shopfront.html';
} else {
    const username = user.username || 'there';

    const greeting = $('user-greeting');
    if (greeting) greeting.textContent = `, ${username}`;

    const roleLine = $('user-role-line');
    if (roleLine) roleLine.textContent = ROLE_LABELS[user.role] || user.role;

    const usernameField = $('account-username');
    if (usernameField) usernameField.textContent = user.username || '—';

    const roleField = $('account-role');
    if (roleField) roleField.textContent = user.role || '—';

    $('logoutBtn')?.addEventListener('click', () => executeGlobalLogout());
}
