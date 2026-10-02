// frontend/src/adminReports.js
//
// The Reports panel on the admin and superuser dashboards.
//
// Loaded on BOTH, for the same reason adminUsers.js is: adminReports.html is
// built into each of them, and logic that lived in admin.js would leave the
// panel stuck on "Loading reports..." on the superuser dashboard. That has
// already happened once to the invite table.
//
// THE ROUTES ALREADY EXISTED. GET /api/feedback and POST /api/feedback/:id/
// resolve were built and tested with the report button, and nothing called
// either — so every report anyone has sent since has gone somewhere nobody
// looked. This is the half that was missing.
//
// THE SERVER DECIDES WHO MAY RESOLVE. These routes are admin/superuser only
// and the panel does not re-derive that; it shows what it is given.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';

const API = '/api';

// What kind of report it is. Matches shared/feedbackRules.mjs, which is where
// the values come from — if a fourth is ever added there, this is the list that
// would need to know, and a badge falling through to "secondary" is the signal.
const KIND_LABELS = {
    bug:   { text: 'Something is broken', variant: 'danger' },
    idea:  { text: 'Idea',                variant: 'info' },
    other: { text: 'Other',               variant: 'secondary' },
};

function showAlert(message, variant = 'danger') {
    const box = $('reportListAlert');
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.className = `alert alert-${variant} py-2 px-3 small`;
    box.textContent = message;
    box.classList.remove('d-none');
}

function badge(text, variant) {
    const span = document.createElement('span');
    span.className = `badge text-bg-${variant} me-2 mb-1`;
    span.textContent = text;
    return span;
}

// The page the report is about, shown as the path it was sent from. Clickable
// so whoever reads it can go and look — the link is the reporter's own page,
// which is the fastest way to understand what they were doing.
function pageLink(url) {
    const link = document.createElement('a');
    link.href = url;
    link.className = 'small text-info text-decoration-none';
    link.textContent = url;
    return link;
}

function renderReport(report) {
    const item = document.createElement('div');
    item.className = 'border border-secondary rounded p-3 mb-3';

    // --- header: kind, status, who, when ---
    const header = document.createElement('div');
    header.className = 'd-flex flex-wrap align-items-center mb-2';

    const kind = KIND_LABELS[report.kind] || { text: report.kind, variant: 'secondary' };
    header.appendChild(badge(kind.text, kind.variant));

    header.appendChild(report.status === 'resolved'
        ? badge('Resolved', 'success')
        : badge('Open', 'warning'));

    const who = document.createElement('span');
    who.className = 'small';

    if (report.username) {
        who.textContent = `${report.username} (${report.role})`;
    } else {
        // Not missing data. It says the report came from someone with no
        // session, which is usually the fault being reported.
        who.className += ' text-secondary fst-italic';
        who.textContent = 'anonymous — sent without signing in';
    }

    header.appendChild(who);

    const when = document.createElement('span');
    when.className = 'small text-secondary ms-auto';
    when.textContent = report.created_at || '';
    header.appendChild(when);

    item.appendChild(header);

    // --- what they said ---
    const message = document.createElement('p');
    message.className = 'mb-2';
    // textContent, not innerHTML: this is whatever a person typed, and the
    // panel that reads it is the most privileged account in the system.
    message.textContent = report.message;
    item.appendChild(message);

    // --- where it came from, and how to reply ---
    const meta = document.createElement('div');
    meta.className = 'd-flex flex-wrap align-items-center gap-3 mb-2';

    if (report.page_url) meta.appendChild(pageLink(report.page_url));

    if (report.contact_email) {
        const contact = document.createElement('span');
        contact.className = 'small text-secondary';
        contact.textContent = `reply to ${report.contact_email}`;
        meta.appendChild(contact);
    }

    if (meta.childElementCount) item.appendChild(meta);

    // --- already resolved ---
    if (report.status === 'resolved') {
        const done = document.createElement('p');
        done.className = 'small text-secondary mb-0';
        done.textContent = report.resolution_note
            ? `Closed: ${report.resolution_note}`
            : 'Closed with no note.';
        item.appendChild(done);
        return item;
    }

    // --- open: offer to resolve ---
    const actions = document.createElement('div');

    const resolveButton = document.createElement('button');
    resolveButton.type = 'button';
    resolveButton.className = 'btn btn-sm btn-outline-success py-0 px-2';
    resolveButton.textContent = 'Resolve';

    // The note field is revealed on demand rather than shown on every row. It
    // is optional, and a form on each of twenty open reports would be noise.
    const form = document.createElement('div');
    form.className = 'd-none mt-2';

    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'form-control form-control-sm mb-2';
    note.placeholder = 'What was done? (optional, but useful later)';

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-sm btn-success me-2';
    confirm.textContent = 'Confirm';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm btn-outline-secondary';
    cancel.textContent = 'Cancel';

    resolveButton.addEventListener('click', () => {
        form.classList.remove('d-none');
        resolveButton.classList.add('d-none');
        note.focus();
    });

    cancel.addEventListener('click', () => {
        form.classList.add('d-none');
        resolveButton.classList.remove('d-none');
        note.value = '';
    });

    confirm.addEventListener('click', () => {
        resolveReport(report, note.value.trim(), confirm);
    });

    // Enter confirms, because typing a note and reaching for the mouse is the
    // sort of small friction that stops notes being written at all.
    note.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            resolveReport(report, note.value.trim(), confirm);
        }
    });

    form.appendChild(note);
    form.appendChild(confirm);
    form.appendChild(cancel);

    actions.appendChild(resolveButton);
    actions.appendChild(form);
    item.appendChild(actions);

    return item;
}

function renderReports(data) {
    const list = $('reportList');
    if (!list) return;

    const counts = $('reportCounts');
    if (counts && data.counts) {
        counts.textContent =
            `${data.counts.open || 0} open, ${data.counts.resolved || 0} resolved`;
    }

    list.innerHTML = '';
    list.className = '';

    if (!data.reports || data.reports.length === 0) {
        list.className = 'text-secondary';
        list.textContent = data.status === 'open'
            ? 'Nothing open. Every report has been dealt with.'
            : 'Nothing here.';
        return;
    }

    for (const report of data.reports) {
        list.appendChild(renderReport(report));
    }
}

async function loadReports() {
    const list = $('reportList');
    if (!list) return;

    showAlert('');

    const status = $('reportStatusFilter')?.value || 'open';

    list.className = 'text-secondary';
    list.textContent = 'Loading reports...';

    try {
        const response = await apiFetch(
            `${API}/feedback?status=${encodeURIComponent(status)}`,
            { credentials: 'include' }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load reports.');
        }

        renderReports(data);

    } catch (err) {
        console.error('Could not load reports:', err.message);

        list.className = 'text-secondary';
        list.textContent = '';
        showAlert(err.message);
    }
}

async function resolveReport(report, note, button) {
    button.disabled = true;
    button.textContent = 'Closing…';

    try {
        const response = await apiFetch(`${API}/feedback/${report.id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ resolution_note: note }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not close the report.');
        }

        showAlert(
            note
                ? 'Report closed, with a note.'
                : 'Report closed. A note would have helped whoever reads it next.',
            note ? 'success' : 'warning'
        );

        await loadReports();

    } catch (err) {
        console.error('Could not close the report:', err.message);

        button.disabled = false;
        button.textContent = 'Confirm';
        showAlert(err.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Only present on the admin and superuser dashboards.
    if (!$('reportList')) return;

    $('reportStatusFilter')?.addEventListener('change', loadReports);

    loadReports();
});
