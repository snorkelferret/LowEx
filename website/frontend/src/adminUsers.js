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

const API = '/api';

const ROLE_BADGES = {
    superuser: 'bg-danger',
    admin: 'bg-warning text-dark',
    developer: 'bg-info text-dark',
    user: 'bg-secondary',
};

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
        const response = await fetch(`${API}/admin/users?status=${encodeURIComponent(status)}`, {
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load accounts.');
        }

        if (data.users.length === 0) {
            body.innerHTML = '<tr><td colspan="5" class="text-secondary py-3">No accounts.</td></tr>';
            return;
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

            return `
                <tr>
                  <td>${escapeHtml(user.username)}${you}</td>
                  <td class="text-secondary">${escapeHtml(user.email)}</td>
                  <td><span class="badge ${roleBadge}">${escapeHtml(user.role)}</span></td>
                  <td>${statusBadge}</td>
                  <td class="text-end">${action}</td>
                </tr>
            `;
        }).join('');

        bindActions(body);

    } catch (err) {
        console.error('Could not load accounts:', err.message);
        body.innerHTML = `<tr><td colspan="5" class="text-danger py-3">${escapeHtml(err.message)}</td></tr>`;
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
        const response = await fetch(`${API}/admin/users/${id}/${verb}`, {
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
