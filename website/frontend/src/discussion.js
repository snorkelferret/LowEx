// frontend/src/discussion.js
//
// The bridge to the Discord server.
//
// Two jobs: show the join link if the invite is configured, and point the nav
// action somewhere sensible depending on whether you are signed in.
//
// The invite comes from VITE_DISCORD_INVITE rather than being written into the
// markup, so it is changed in one place instead of across every page linking
// here. Unset is treated as a configuration gap to report, not as a broken link
// to offer.

const $ = (id) => document.getElementById(id);

const INVITE = import.meta.env.VITE_DISCORD_INVITE || '';

function showInvite() {
    const join = $('discord-join');
    const notice = $('discord-not-configured');

    // Only accept something that looks like a URL. Anything else is a
    // misconfiguration and saying so is more useful than a dead button.
    const looksLikeUrl = /^https?:\/\//i.test(INVITE);

    if (looksLikeUrl) {
        const link = $('discord-invite-link');
        if (link) link.href = INVITE;
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

    if (!user || !user.role) {
        // The invite is public; anything else here is Discord's business.
        return;
    }

    const destination = {
        superuser: '/superuserDashboard.html',
        admin: '/adminDashboard.html',
        developer: '/devDashboard.html',
        user: '/user.html',
    }[user.role] || '/user.html';

    action.href = destination;
    action.innerHTML = '<i class="bi bi-arrow-left me-1"></i> Back';
}

showInvite();
pointNav();
