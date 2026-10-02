// frontend/src/discussion.js
//
// The link out to the discussion board, whichever one the project settles on.
//
// Deliberately knows nothing about which product it is. The board is
// third-party and service-neutral here on purpose: it names no provider, and
// takes its URL from VITE_DISCUSSION_URL, so switching boards — or not having
// chosen one yet — is a config change rather than an edit to this file.
//
// Two jobs: show the join link if configured, and point the nav action
// somewhere sensible depending on whether you are signed in.

import { $ } from './utils.js';

const BOARD_URL = import.meta.env.VITE_DISCUSSION_URL || '';

function showJoin() {
    const join = $('discussion-join');
    const notice = $('discussion-not-configured');

    // Only accept something that looks like a URL. Anything else is a
    // misconfiguration, and saying so is more useful than a dead button.
    const looksLikeUrl = /^https?:\/\//i.test(BOARD_URL);

    if (looksLikeUrl) {
        const link = $('discussion-link');
        if (link) link.href = BOARD_URL;
        if (join) join.classList.remove('d-none');
        return;
    }

    if (notice) notice.classList.remove('d-none');
}

function readUser() {
    const raw = localStorage.getItem('user_info');
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function pointNav() {
    const action = $('discussion-nav-action');
    if (!action) return;

    const user = readUser();
    if (!user || !user.role) return;

    const destination = {
        superuser: '/superuserDashboard.html',
        admin: '/adminDashboard.html',
        developer: '/devDashboard.html',
        user: '/user.html',
    }[user.role] || '/user.html';

    action.href = destination;
    action.innerHTML = '<i class="bi bi-arrow-left me-1"></i> Back';
}

showJoin();
pointNav();
