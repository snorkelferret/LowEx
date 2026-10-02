// frontend/src/sharedInvites.js
//
// The invitation panel, shared by the admin and superuser dashboards.
//
// Everything here talks to backend/routes/inviteDevs.js. An earlier version
// called two endpoints that had never existed — a reissue by id, and a copy
// helper reading an element nothing rendered — so neither reissue nor copy has
// ever worked from this panel.
//
// The status shown is the SERVER's. It used to be recomputed here from
// createdAt + 28 days, which was wrong twice over: a reissue moves expiresAt
// but not createdAt, so the panel kept calling a renewed invitation expired;
// and `new Date('2026-09-07 13:08:31')` is an Invalid Date in Safari because
// SQLite timestamps have a space instead of a T and are UTC.

import { escapeHtml } from './utils.js';
import { apiFetch } from './api.js';

const API_URL = '/api';

// The four states the server reports. Expiry is derived there, on read, so
// this never has to decide whether something has expired.
const STATUS_BADGES = {
    pending: { cls: 'bg-warning text-dark', label: 'Pending' },
    expired: { cls: 'bg-danger', label: 'Expired' },
    used: { cls: 'bg-success', label: 'Accepted' },
    revoked: { cls: 'bg-secondary', label: 'Revoked' }
};

/**
 * SQLite gives 'YYYY-MM-DD HH:MM:SS' in UTC. Left alone, Safari reads it as an
 * Invalid Date and Chrome reads it as local time. Both are wrong.
 */
function parseSqliteUtc(value) {
    if (!value) return null;

    const parsed = new Date(String(value).replace(' ', 'T') + 'Z');

    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A human line for the expiry column. Uses the server's expires_at, so a
 * reissued invitation reads correctly.
 */
export function getInviteStatus(value) {
    const expiry = parseSqliteUtc(value);

    if (!expiry) return { isExpired: false, label: '—' };

    const now = new Date();

    if (now > expiry) {
        return { isExpired: true, label: 'Expired' };
    }

    const days = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

    return { isExpired: false, label: `${days} day${days === 1 ? '' : 's'} left` };
}

// ---------------------------------------------------------------------------
// Reissue
// ---------------------------------------------------------------------------

/**
 * Reissue by id. Admin/superuser only, enforced server-side.
 *
 * The list deliberately does not return tokens — putting every invitation's
 * token on the page would make the panel itself a liability — so an admin
 * picks the row and the server looks the token up. The invitee's own path,
 * POST /request-reissue, is token-based because they hold a link and have no
 * account.
 */
export async function reissueInvite(inviteId) {
    try {
        const response = await apiFetch(`${API_URL}/inviteDevs/${inviteId}/reissue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.message || data.error || 'Could not reissue the invitation.');
        }

        return { success: true, data };

    } catch (err) {
        console.error('Failed to reissue invite:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Revoke a pending invitation. The account half of revocation is different —
 * deactivating a user — and already takes effect immediately.
 */
async function revokeInvite(inviteId) {
    try {
        const response = await apiFetch(`${API_URL}/inviteDevs/${inviteId}/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not revoke the invitation.');
        }

        return { success: true, data };

    } catch (err) {
        console.error('Failed to revoke invite:', err);
        return { success: false, error: err.message };
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Show a link, with something to copy from. copyInviteLink used to look for an
 * element that nothing ever rendered, so it silently did nothing.
 */
function showLink(container, message, link, variant) {
    container.className = `alert alert-${variant} py-2 px-3 small`;
    container.textContent = '';

    const line = document.createElement('div');
    line.className = 'mb-2';
    line.textContent = message;
    container.appendChild(line);

    if (link) {
        const input = document.createElement('input');
        input.id = 'invite-link-input';
        input.className = 'form-control form-control-sm bg-dark text-light border-secondary';
        input.readOnly = true;
        input.value = link;
        container.appendChild(input);

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-sm btn-outline-secondary mt-2';
        copy.textContent = 'Copy link';
        copy.addEventListener('click', () => window.copyInviteLink('invite-link-input'));
        container.appendChild(copy);

        const hint = document.createElement('div');
        hint.className = 'text-secondary mt-2';
        hint.textContent = 'No email transport yet — pass this on yourself.';
        container.appendChild(hint);
    }

    container.classList.remove('d-none');
}

function showMessage(container, message, variant) {
    container.className = `alert alert-${variant} py-2 px-3 small`;
    container.textContent = message;
    container.classList.remove('d-none');
}

/**
 * Refresh the invitation table.
 */
async function refreshInvitationsList() {
    const listBody = document.getElementById('invite-list-body');
    if (!listBody) return;

    try {
        const response = await apiFetch(`${API_URL}/inviteDevs/list`, {
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to pull the invitations list');

        const invites = await response.json();

        if (invites.length === 0) {
            listBody.innerHTML =
                '<tr><td colspan="6" class="text-center text-muted py-3">No invitations found.</td></tr>';
            return;
        }

        // Every value is ESCAPED. This table renders an address an admin typed,
        // and previously interpolated it into innerHTML — so an invitation to
        // `<img src=x onerror=...>` executed in the admin's session.
        listBody.innerHTML = invites.map(invite => {
            const badge = STATUS_BADGES[invite.status] ||
                { cls: 'bg-secondary', label: invite.status };

            const status = getInviteStatus(invite.expiresAt);
            const expiry = invite.status === 'pending' || invite.status === 'expired'
                ? status.label
                : '—';

            const actions = [];

            if (invite.status === 'pending' || invite.status === 'expired') {
                actions.push(
                    `<button type="button" class="btn btn-sm btn-outline-warning py-0 px-2 btn-reissue-trigger"` +
                    ` data-id="${Number(invite.id)}">Reissue</button>`
                );
                actions.push(
                    `<button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 btn-revoke-trigger"` +
                    ` data-id="${Number(invite.id)}">Revoke</button>`
                );
            }

            if (actions.length === 0) {
                actions.push('<span class="text-secondary small">—</span>');
            }

            return `
                <tr>
                  <td>${escapeHtml(invite.email)}</td>
                  <td><span class="badge bg-dark border border-secondary text-light">${escapeHtml(invite.role)}</span></td>
                  <td><span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span></td>
                  <td>${escapeHtml(expiry)}</td>
                  <td><span class="text-secondary">${Number(invite.reissueCount) || 0}</span></td>
                  <td class="text-end">${actions.join(' ')}</td>
                </tr>
            `;
        }).join('');

        bindListActions(listBody);

    } catch (err) {
        console.error('Could not refresh the invitations list:', err.message);
    }
}

/**
 * One delegated listener rather than one per row. Binding per row meant every
 * refresh added another set, and the innerHTML replacement orphaned them.
 */
function bindListActions(listBody) {
    if (listBody.dataset.actionsBound === '1') return;

    listBody.dataset.actionsBound = '1';

    listBody.addEventListener('click', async (event) => {
        const reissueButton = event.target.closest('.btn-reissue-trigger');
        const revokeButton = event.target.closest('.btn-revoke-trigger');

        if (!reissueButton && !revokeButton) return;

        const alertBox = document.getElementById('invite-alert');
        const button = reissueButton || revokeButton;
        const id = button.dataset.id;

        button.disabled = true;

        if (reissueButton) {
            const outcome = await reissueInvite(id);

            if (outcome.success) {
                if (alertBox) {
                    showLink(
                        alertBox,
                        `Invitation reissued. New link for ${outcome.data.email}:`,
                        outcome.data.inviteLink,
                        'success'
                    );
                }
                await refreshInvitationsList();
            } else {
                if (alertBox) showMessage(alertBox, outcome.error, 'danger');
                button.disabled = false;
            }
            return;
        }

        const outcome = await revokeInvite(id);

        if (outcome.success) {
            if (alertBox) showMessage(alertBox, 'Invitation revoked.', 'success');
            await refreshInvitationsList();
        } else {
            if (alertBox) showMessage(alertBox, outcome.error, 'danger');
            button.disabled = false;
        }
    });
}

/**
 * Fill the role select with what THIS caller may assign.
 *
 * The markup used to hardcode Developer / Admin / Superuser, which no longer
 * matches the rule: an inviter may only assign roles strictly below their own,
 * so an admin offering "Superuser" was offering something the server refuses.
 */
async function populateAssignableRoles() {
    const select = document.getElementById('invite-role');
    if (!select) return;

    try {
        const response = await apiFetch(`${API_URL}/inviteDevs/assignable-roles`, {
            credentials: 'include'
        });

        if (!response.ok) return;

        const { roles } = await response.json();

        if (!Array.isArray(roles) || roles.length === 0) {
            select.innerHTML = '<option value="">No roles available</option>';
            return;
        }

        select.textContent = '';

        for (const role of roles) {
            const option = document.createElement('option');
            option.value = role;
            option.textContent = role;
            select.appendChild(option);
        }

        // Whatever the server listed first is the least privileged.
        select.value = roles[0];

    } catch (err) {
        console.error('Could not load assignable roles:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export function initInviteDeveloper() {
    const inviteForm = document.getElementById('inviteDevForm');
    if (!inviteForm) return;

    inviteForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const emailInput = document.getElementById('invite-email');
        const roleSelect = document.getElementById('invite-role');
        const generateButton = document.getElementById('btn-send-invite');
        const alertBox = document.getElementById('invite-alert');

        const email = emailInput ? emailInput.value.trim() : '';
        const role = roleSelect ? roleSelect.value : '';

        if (!email) {
            if (alertBox) showMessage(alertBox, 'Enter an email address.', 'danger');
            return;
        }

        if (!role) {
            if (alertBox) showMessage(alertBox, 'No role is available to assign.', 'danger');
            return;
        }

        if (generateButton) generateButton.disabled = true;

        try {
            const response = await apiFetch(`${API_URL}/inviteDevs/generate-invite`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email, role })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.error || 'Could not create the invitation.');
            }

            if (emailInput) emailInput.value = '';

            if (alertBox) {
                showLink(alertBox, `Invitation created for ${data.email}:`, data.inviteLink, 'success');
            }

            await refreshInvitationsList();

        } catch (err) {
            if (alertBox) showMessage(alertBox, err.message, 'danger');
        } finally {
            if (generateButton) generateButton.disabled = false;
        }
    });
}

// ---------------------------------------------------------------------------
// Copy helper
// ---------------------------------------------------------------------------

// Takes an explicit element id. The old version defaulted to a hardcoded id
// that no markup defined, so it silently did nothing.
if (!window.copyInviteLink) {
    window.copyInviteLink = function (elementId) {
        const input = document.getElementById(elementId);

        if (!input) {
            console.error('copyInviteLink: no element with id', elementId);
            return;
        }

        input.select();
        input.setSelectionRange(0, 99999);

        navigator.clipboard.writeText(input.value).catch(() => {
            console.error('Could not write to the clipboard; select and copy manually.');
        });
    };
}

document.addEventListener('DOMContentLoaded', () => {
    initInviteDeveloper();
    populateAssignableRoles();
    refreshInvitationsList();
});
