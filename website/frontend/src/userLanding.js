// frontend/src/userLanding.js
//
// The tester's home page: who you are, and what you can do.
//
// ============================================================
// IT ASKS THE SERVER WHO YOU ARE
// ============================================================
//
// This page used to read localStorage.user_info and draw the account panel from
// it. That value is written at sign-in and NEVER EXPIRES, while the session
// cookie behind it does — so eight hours in, the page would greet you by name,
// print your role, and head a panel called "Your account" with details that
// were no longer true of anybody. It looked certain and it was stale.
//
// A panel that says "Your account" should be reporting a fact. So it asks
// /api/auth/me, which reads the row on this request, and shows what comes back.
// The greeting still uses the stored profile, because a greeting is a courtesy
// rather than a claim — but the account panel is the server's answer or it is
// nothing.
//
// THE TWO-FACTOR ROW READS has_2fa_secret, NOT is_2fa_enabled. The flag says
// "on" for accounts with no authenticator at all, so a page reporting it would
// be reporting a falsehood about security — see TODO 47, where the login path
// still accepts the fixed code 000000 for exactly those accounts. The row shows
// whether a secret actually exists, and it says "Not set up" for every account
// until that item is done. That is the truth, and it is more useful on screen
// than hidden behind a flag that lies.
//
// WHAT AN EXPIRED SESSION LOOKS LIKE. apiFetch handles the 401: it clears the
// stored profile and sends you to the sign-in page, which explains itself. So
// there is no separate "you are signed out" state to design — the redirect IS
// the state, and it is the same one every other page uses.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';

const API = '/api';

const ROLE_LABELS = {
    user: 'a tester',
    developer: 'a developer',
    prod: 'production',
    admin: 'an administrator',
};

// The greeting only, and only because it is nicer than "Welcome, .". Everything
// else on this page comes from the server.
function readStoredProfile() {
    try {
        const raw = localStorage.getItem('user_info');
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function greetFromStoredProfile() {
    const user = readStoredProfile();

    if (!user) return;

    const greeting = $('user-greeting');
    if (greeting) greeting.textContent = `, ${user.username || 'there'}`;
}

function renderAccount(user) {
    const panel = $('accountPanel');
    if (!panel) return;

    const roleLine = $('user-role-line');
    if (roleLine) roleLine.textContent = ROLE_LABELS[user.role] || user.role;

    panel.className = '';
    panel.innerHTML = `
      <dl class="row small mb-0">
        <dt class="col-sm-3 text-secondary fw-normal">Username</dt>
        <dd class="col-sm-9">${escapeHtml(user.username)}</dd>

        <dt class="col-sm-3 text-secondary fw-normal">Email</dt>
        <dd class="col-sm-9">${escapeHtml(user.email || '—')}</dd>

        <dt class="col-sm-3 text-secondary fw-normal">Role</dt>
        <dd class="col-sm-9">${escapeHtml(user.role)}</dd>

        <dt class="col-sm-3 text-secondary fw-normal">Two-factor</dt>
        <dd class="col-sm-9 mb-0">${user.has_2fa_secret
            ? 'Set up'
            : 'Not set up'}</dd>
      </dl>
    `;
}

// The session is over, or the endpoint failed. Either way this page cannot say
// who you are, and saying nothing is better than saying something stale — so it
// offers the way back in rather than a panel of guesses.
function renderSignedOut(message) {
    const panel = $('accountPanel');
    if (!panel) return;

    panel.className = '';

    const box = document.createElement('div');
    box.className = 'alert alert-secondary py-2 px-3 small mb-0';
    box.textContent = message;
    panel.appendChild(box);

    const link = document.createElement('a');
    link.className = 'btn btn-sm btn-outline-light mt-3';
    link.href = '/shopfront.html';
    link.textContent = 'Sign in again';
    panel.appendChild(link);
}

async function loadAccount() {
    const panel = $('accountPanel');
    if (!panel) return;

    try {
        // apiFetch never returns on a 401 — it clears the stored profile and
        // redirects to the sign-in page, which is the right end for a dead
        // session. So anything reaching here is a live one.
        const response = await apiFetch(`${API}/auth/me`, { credentials: 'include' });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.user) {
            renderSignedOut(
                data.error || 'Could not read your account from the server.'
            );
            return;
        }

        renderAccount(data.user);

    } catch (err) {
        console.error('Could not read the current account:', err.message);

        renderSignedOut(
            'Could not reach the server, so this page cannot say who you are.'
        );
    }
}

// There is no sign-out button in this file: the shared header owns it, and it
// is on the page because header.js is. That is the point of rebuilding this
// page — the controls live in one place rather than once per page.

greetFromStoredProfile();
loadAccount();
