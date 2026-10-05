// frontend/src/adminAudit.js
//
// The Audit log panel, on both the admin and superuser dashboards — for the
// same reason adminUsers.js and adminReports.js are: the panel is built into
// both, and logic living in admin.js would leave it stuck on "Loading…" on the
// superuser dashboard. That has happened twice already to other panels.
//
// THE SERVER DECIDES WHO MAY READ IT, and nothing here re-derives that. An
// audit trail names who did what to whom; it is admin and superuser only, and
// the client shows what it is given.
//
// IT IS READ-ONLY, and there is no route that would let it be otherwise. A
// trail an administrator can edit is not a trail.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';

const API = '/api';

function showAlert(message) {
    const box = $('auditAlert');
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.textContent = message;
    box.classList.remove('d-none');
}

// details is JSON, and ITS SHAPE DIFFERS PER ACTION — from/to for a retag,
// files/bytes for a purge. Rendered as key: value pairs rather than parsed into
// columns, because a shape common to all of them would lose whichever fields do
// not fit it.
function describeDetails(raw) {
    if (!raw) return '';

    let parsed;

    try {
        parsed = JSON.parse(raw);
    } catch {
        // Not JSON. Show it as it was stored rather than pretending otherwise.
        return String(raw);
    }

    if (!parsed || typeof parsed !== 'object') return String(parsed);

    return Object.entries(parsed)
        .map(([key, value]) => {
            const shown = value === null || value === undefined
                ? '—'
                : String(value);
            return `${key}: ${shown}`;
        })
        .join(' · ');
}

function cell(text, className) {
    const td = document.createElement('td');
    td.className = className || '';
    // textContent throughout: an action name, a target and a detail value all
    // originate from something a person or the server wrote, and this table is
    // read by the most privileged account in the system.
    td.textContent = text ?? '';
    return td;
}

function renderRow(entry) {
    const tr = document.createElement('tr');

    tr.appendChild(cell(entry.created_at, 'text-secondary text-nowrap'));

    // A NULL actor is the SYSTEM acting, not a missing name. The wording comes
    // from here rather than the server so it reads as one thing in one place,
    // and it is styled distinctly so "system" is never mistaken for a username.
    if (entry.actor_id === null || entry.actor_id === undefined) {
        const actor = document.createElement('td');

        const badge = document.createElement('span');
        badge.className = 'badge text-bg-secondary';
        badge.textContent = 'system';

        actor.appendChild(badge);
        tr.appendChild(actor);
    } else {
        tr.appendChild(cell(entry.actor_username || `user ${entry.actor_id}`));
    }

    tr.appendChild(cell(entry.action, 'font-monospace small'));
    tr.appendChild(cell(entry.target, 'text-break'));
    tr.appendChild(cell(describeDetails(entry.details), 'text-secondary small text-break'));

    return tr;
}

function renderLog(data) {
    const list = $('auditList');
    if (!list) return;

    const counts = $('auditCounts');
    if (counts) {
        counts.textContent = data.total === 1
            ? '1 recorded action'
            : `${data.total} recorded actions`;
    }

    // The filter is rebuilt only when the options have changed, so choosing one
    // does not reset the dropdown under the reader's hand.
    const filter = $('auditActionFilter');
    if (filter) {
        const wanted = (data.actions || []).map(a => a.action).join('|');

        if (filter.dataset.options !== wanted) {
            const chosen = filter.value;

            filter.innerHTML = '<option value="">Everything</option>' +
                (data.actions || []).map(a =>
                    `<option value="${escapeHtml(a.action)}">` +
                    `${escapeHtml(a.action)} (${Number(a.count)})</option>`
                ).join('');

            filter.dataset.options = wanted;
            filter.value = chosen;
        }
    }

    list.className = '';
    list.innerHTML = '';

    if (!data.entries || data.entries.length === 0) {
        list.className = 'text-secondary';
        list.textContent = data.action
            ? `Nothing recorded for "${data.action}".`
            : 'Nothing has been recorded yet. Actions appear here as they happen.';
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'table-responsive';

    const table = document.createElement('table');
    table.className = 'table table-hover align-middle small mb-0';

    table.innerHTML = `
      <thead class="text-uppercase">
        <tr>
          <th>When</th>
          <th>Who</th>
          <th>Action</th>
          <th>Target</th>
          <th>Details</th>
        </tr>
      </thead>
    `;

    const tbody = document.createElement('tbody');
    for (const entry of data.entries) tbody.appendChild(renderRow(entry));

    table.appendChild(tbody);
    wrap.appendChild(table);
    list.appendChild(wrap);
}

async function loadAudit() {
    const list = $('auditList');
    if (!list) return;

    showAlert('');

    const action = $('auditActionFilter')?.value || '';

    list.className = 'text-secondary';
    list.textContent = 'Loading the audit log...';

    try {
        const response = await apiFetch(
            `${API}/admin/audit?action=${encodeURIComponent(action)}`,
            { credentials: 'include' }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load the audit log.');
        }

        renderLog(data);

    } catch (err) {
        console.error('Could not load the audit log:', err.message);

        list.className = 'text-secondary';
        list.textContent = '';
        showAlert(err.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Only present on the admin and superuser dashboards.
    if (!$('auditList')) return;

    $('auditActionFilter')?.addEventListener('change', loadAudit);

    loadAudit();
});
