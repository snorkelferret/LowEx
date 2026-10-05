// frontend/src/adminUsers.js
//
// The Accounts table on the admin panel.
//
// Loaded on BOTH the admin and the superuser dashboard, because
// adminPanel.html is built into both. Putting this in admin.js would leave the
// table on the superuser dashboard permanently showing "Loading accounts...",
// which is exactly what happened to the invite table.
//
// WHO MAY ACT ON WHOM IS NOT DECIDED HERE. The server sends can_deactivate and
// can_reactivate per row. The buttons mirror those flags; they never re-derive
// the rule, because a client-side copy of a permission rule is a permission
// rule that can disagree with the server.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';

const API = '/api';

const ROLE_BADGES = {
    superuser: 'bg-danger',
    admin: 'bg-warning text-dark',
    developer: 'bg-info text-dark',
    user: 'bg-secondary',
};

// How each account came to exist, in a word an administrator reads rather than
// a code they have to know. Anything NOT in this map is unaccounted for — see
// the column declaration in db.js — and is rendered as a warning, never as a
// blank cell, because a blank would look like a rendering fault rather than a
// finding.
const ORIGINS = {
    bootstrap: 'created at setup',
    invitation: 'invitation',
    google: 'Google sign-in',
    manual: 'by hand',
};

// THE CHECK, AND WHY IT IS QUIET WHEN IT HAS NOTHING TO SAY.
//
// A warning that is always on screen is a warning nobody reads. This says
// nothing at all when every account is explicable, and names the accounts when
// one is not — including what to do about it, because "unrecorded" on its own
// is a fact with no next step.
function renderOriginCheck(unaccounted) {
    const box = $('accountOriginCheck');
    if (!box) return;

    box.textContent = '';
    box.classList.add('d-none');

    if (unaccounted.length === 0) return;

    box.className = 'alert alert-warning py-2 px-3 small mb-3';
    box.classList.remove('d-none');

    // TWO REASONS, EXPLAINED SEPARATELY. They call for different responses —
    // one is "something got in without going through the portal", the other is
    // "something privileged got in through the portal" — and lumping them under
    // one sentence would describe one of them wrongly.
    const REASONS = {
        unrecorded: {
            title: 'no recorded origin',
            detail: 'Nothing in the portal created these — not setup, not an ' +
                'invitation, not Google — so the rows were inserted directly ' +
                'into the database.',
        },
        privileged_from_web: {
            title: 'privileged, created through the website',
            detail: 'Admin and superuser accounts can only be created on the ' +
                'studio machine, by someone with access to it. These were ' +
                'created through the web interface, which is not supposed to be ' +
                'possible.',
        },
    };

    const groups = {};
    for (const u of unaccounted) {
        (groups[u.reason] = groups[u.reason] || []).push(u);
    }

    box.innerHTML =
        '<div class="fw-semibold mb-1">' +
        '<i class="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>' +
        (unaccounted.length === 1
            ? '1 account needs explaining'
            : `${unaccounted.length} accounts need explaining`) +
        '</div>' +
        Object.entries(groups).map(([reason, list]) => {
            const explained = REASONS[reason] || {
                title: reason,
                detail: '',
            };

            const names = list
                .map(u => `${u.username} (${u.role}, added ${u.created_at}` +
                    `${u.created_via ? ', via ' + u.created_via : ''})`)
                .join(', ');

            return `<div class="mt-1">` +
                `<strong>${escapeHtml(list.length)} with ${escapeHtml(explained.title)}:</strong> ` +
                `${escapeHtml(names)}. ${escapeHtml(explained.detail)}` +
                `</div>`;
        }).join('') +
        '<div class="mt-1">If either was intended, record why; if it was not, ' +
        'deactivate the account and find out how it got there.</div>';
}

function showAlert(message, variant) {
    const box = $('userListAlert');
    if (!box) return;

    box.className = `alert alert-${variant} py-2 px-3 small`;
    box.textContent = message;
    box.classList.remove('d-none');
}

function clearAlert() {
    const box = $('userListAlert');
    if (box) box.classList.add('d-none');
}

async function loadUsers() {
    const body = $('user-list-body');
    if (!body) return;

    const status = $('userStatusFilter')?.value || 'all';

    try {
        const response = await apiFetch(`${API}/admin/users?status=${encodeURIComponent(status)}`, {
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load accounts.');
        }

        if (data.users.length === 0) {
            body.innerHTML = '<tr><td colspan="6" class="text-secondary py-3">No accounts.</td></tr>';
            return;
        }

        renderOriginCheck(data.unaccounted || []);

        // Which rows are flagged, and why, so the badge can say which problem
        // it is. Keyed by id rather than re-derived here: the rule lives on the
        // server (backend/routes/admin.js) and this only renders its answer.
        const unaccountedById = {};
        for (const entry of data.unaccounted || []) {
            unaccountedById[entry.id] = entry.reason;
        }

        // Every value ESCAPED. Usernames and email addresses are chosen by
        // people, and this table is rendered for the account with the most
        // power in the system.
        body.innerHTML = data.users.map(user => {
            const roleBadge = ROLE_BADGES[user.role] || 'bg-secondary';

            const statusBadge = user.is_active
                ? '<span class="badge bg-success">Active</span>'
                : '<span class="badge bg-secondary">Deactivated</span>';

            const you = user.is_self
                ? ' <span class="badge bg-dark border border-secondary text-secondary">you</span>'
                : '';

            let action = '<span class="text-secondary small">—</span>';

            if (user.can_deactivate) {
                action = `<button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 btn-user-deactivate" data-id="${Number(user.id)}" data-name="${escapeHtml(user.username)}">Deactivate</button>`;
            } else if (user.can_reactivate) {
                action = `<button type="button" class="btn btn-sm btn-outline-success py-0 px-2 btn-user-reactivate" data-id="${Number(user.id)}" data-name="${escapeHtml(user.username)}">Reactivate</button>`;
            } else if (!user.is_self) {
                // Deliberately disabled rather than hidden. Seeing who exists
                // and that you cannot act on them is useful; a missing row is
                // just confusing.
                action = `<button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2" disabled title="Not below your own role">—</button>`;
            }

            // AN UNACCOUNTED ROW IS NOT SUBTLE. This is the one column whose
            // whole job is to be noticed when it says something unexpected, so
            // an unexplained account gets the status badge rather than a quiet
            // word in grey next to three other quiet words in grey.
            // The row says WHICH problem it is, not merely that there is one —
            // "unrecorded" and "created here, but privileged" need different
            // responses from whoever reads the table.
            const flagged = (unaccountedById || {})[user.id];

            const origin = ORIGINS[user.created_via];

            const originCell = flagged === 'privileged_from_web'
                ? '<span class="badge text-bg-warning">' +
                  '<i class="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>' +
                  'created via the web</span>'
                : flagged
                    ? '<span class="badge text-bg-warning">' +
                      '<i class="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>' +
                      'unrecorded</span>'
                    : `<span class="text-secondary small">${escapeHtml(origin || '')}</span>`;

            return `
                <tr>
                  <td>${escapeHtml(user.username)}${you}</td>
                  <td class="text-secondary">${escapeHtml(user.email)}</td>
                  <td><span class="badge ${roleBadge}">${escapeHtml(user.role)}</span></td>
                  <td>${statusBadge}</td>
                  <td>${originCell}</td>
                  <td class="text-end">${action}</td>
                </tr>
            `;
        }).join('');

        bindActions(body);

    } catch (err) {
        console.error('Could not load accounts:', err.message);
        body.innerHTML = `<tr><td colspan="6" class="text-danger py-3">${escapeHtml(err.message)}</td></tr>`;
    }
}

async function setActive(id, name, active) {
    const verb = active ? 'reactivate' : 'deactivate';

    const confirmed = window.confirm(
        active
            ? `Reactivate "${name}"? They will be able to sign in again.`
            : `Deactivate "${name}"?\n\n` +
              `Their access is revoked immediately — their next request is refused ` +
              `even if they are signed in. Nothing they created is deleted.`
    );

    if (!confirmed) return;

    clearAlert();

    try {
        const response = await apiFetch(`${API}/admin/users/${id}/${verb}`, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || `Could not ${verb} the account.`);
        }

        showAlert(
            active
                ? `"${name}" can sign in again.`
                : `"${name}" has been deactivated. Access is revoked immediately.`,
            'success'
        );

        await loadUsers();

    } catch (err) {
        showAlert(err.message, 'danger');
    }
}

// One delegated listener, not one per row per refresh.
function bindActions(body) {
    if (body.dataset.actionsBound === '1') return;
    body.dataset.actionsBound = '1';

    body.addEventListener('click', (event) => {
        const deactivate = event.target.closest('.btn-user-deactivate');
        const reactivate = event.target.closest('.btn-user-reactivate');

        if (deactivate) {
            setActive(deactivate.dataset.id, deactivate.dataset.name, false);
        } else if (reactivate) {
            setActive(reactivate.dataset.id, reactivate.dataset.name, true);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // The panel is only present on the admin and superuser dashboards, so this
    // is a no-op everywhere else.
    if (!$('user-list-body')) return;

    $('userStatusFilter')?.addEventListener('change', loadUsers);

    loadUsers();
});
