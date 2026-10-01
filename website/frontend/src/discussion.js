// frontend/src/discussion.js
//
// The discussion stub does almost nothing: it points the nav action at the
// right place depending on whether you are signed in, so the page does not
// tell a signed-in tester to "Sign in".
//
// When the real board exists this file becomes the client for it. Nothing here
// is worth keeping beyond that decision.

const $ = (id) => document.getElementById(id);

function readUser() {
    const raw = localStorage.getItem('user_info');
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        // A malformed profile is not worth breaking the page over.
        return null;
    }
}

const user = readUser();
const action = $('discussion-nav-action');

if (action) {
    if (user && user.role) {
        const destination = {
            superuser: '/superuserDashboard.html',
            admin: '/adminDashboard.html',
            developer: '/devDashboard.html',
            user: '/user.html',
        }[user.role] || '/user.html';

        action.href = destination;
        action.innerHTML = '<i class="bi bi-arrow-left me-1"></i> Back';
    } else {
        action.href = '/shopfront.html';
        action.innerHTML = '<i class="bi bi-box-arrow-in-left me-1"></i> Sign in';
    }
}
