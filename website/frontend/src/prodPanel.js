// frontend/src/prodPanel.js
//
// The production reviewer's queue: what is waiting, and the decision on it.
//
// ============================================================
// THIS IS THE ONLY THING A PROD CAN DO, SO IT IS THE WHOLE PAGE
// ============================================================
//
// Prod has no workspace, no admin powers, cannot deactivate anybody and cannot
// invite anybody. Deciding creative approvals and commenting are the job, and
// commenting is not built — so this page is one table and two buttons.
//
// The server decides who may call any of it. Nothing here re-derives a
// permission: a prod who is not supposed to do something gets a 403, and this
// shows what the server said.
//
// ============================================================
// A REJECTION CARRIES A REASON, AND THE CLIENT INSISTS ON IT
// ============================================================
//
// The endpoint accepts an empty comment — it defaults to '' — which is right for
// the API and wrong for the person receiving it. A rejection with no reason
// tells a developer their work is not good enough and nothing else, which is
// worse than useless to somebody who then has to guess what to change. So the
// page asks for one and will not send without it.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';

const API = '/api/developer/workspace';

function showAlert(message, variant) {
    const box = $('prodAlert');
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.className = `alert alert-${variant || 'danger'} py-2 px-3 small`;
    box.textContent = message;
}

// SQLite gives 'YYYY-MM-DD HH:MM:SS' in UTC, and Safari reads that as an Invalid
// Date without the T and the Z. Same helper the invitation table uses.
function formatWhen(value) {
    if (!value) return '—';

    const parsed = new Date(String(value).replace(' ', 'T') + 'Z');

    if (Number.isNaN(parsed.getTime())) return String(value);

    const days = Math.floor((Date.now() - parsed.getTime()) / 86400000);

    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;

    return parsed.toISOString().slice(0, 10);
}

function cell(text, className) {
    const td = document.createElement('td');
    td.className = className || '';
    td.textContent = text ?? '';
    return td;
}

// THE PREVIEW OF ONE FILE IN A SUBMISSION. Scoped to the approval, so what can
// be seen is exactly what was submitted for this decision.
function previewUrl(approvalId, sha256) {
    return `${API}/creative-approvals/${approvalId}/preview/${sha256}`;
}

function row(item) {
    const tr = document.createElement('tr');

    // What it is. The asset name and the version, because "bigTree v3" is how
    // anybody in the studio refers to it.
    const what = document.createElement('td');
    const name = document.createElement('div');
    name.textContent = `${item.asset_name} v${item.version_number}`;
    what.appendChild(name);

    if (item.category) {
        const category = document.createElement('div');
        category.className = 'text-secondary small';
        category.textContent = item.category;
        what.appendChild(category);
    }

    // THE PICTURES, SO THE APPROVER CAN SEE WHAT THEY ARE DECIDING.
    //
    // PRODUCTION DOES NOT HAVE BLENDER OR UNREAL, so a download is useless to
    // them even when they are allowed one — they need to look. This is the
    // looking (docs/assettypes01 §1 B), and until it existed the queue told a
    // reviewer the file LIST and nothing about the work.
    //
    // A FILE WITH NO PREVIEW SHOWS NOTHING RATHER THAN A BROKEN IMAGE: a
    // .uasset has no picture, and an empty frame would look like a fault.
    const withPreview = (item.files || []).filter(file => file.preview_kind);

    if (withPreview.length > 0) {
        const strip = document.createElement('div');
        strip.className = 'd-flex flex-wrap gap-1 mt-1';

        for (const file of withPreview.slice(0, 6)) {
            const link = document.createElement('a');
            link.href = previewUrl(item.id, file.sha256);
            link.target = '_blank';
            link.rel = 'noopener';
            link.title = file.relative_path
                ? `${file.relative_path}/${file.filename}`
                : file.filename;

            const image = document.createElement('img');
            image.src = previewUrl(item.id, file.sha256);
            image.alt = file.filename;
            image.loading = 'lazy';
            image.width = 64;
            image.height = 64;
            image.style.objectFit = 'cover';
            image.className = 'rounded border border-secondary';

            link.appendChild(image);
            strip.appendChild(link);
        }

        if (withPreview.length > 6) {
            const more = document.createElement('span');
            more.className = 'small text-secondary align-self-center ms-1';
            more.textContent = `+${withPreview.length - 6} more`;
            strip.appendChild(more);
        }

        what.appendChild(strip);
    }

    tr.appendChild(what);

    // Who, and what they said about it. The version note is the developer's own
    // words about what changed, which is often the most useful thing on the row.
    const from = document.createElement('td');
    const who = document.createElement('div');
    who.textContent = item.requested_by_username || 'unknown';
    from.appendChild(who);

    if (item.version_note) {
        const note = document.createElement('div');
        note.className = 'text-secondary small';
        note.textContent = item.version_note;
        from.appendChild(note);
    }
    tr.appendChild(from);

    if (item.request_comment) {
        const comment = document.createElement('td');
        comment.className = 'text-secondary small';
        comment.textContent = item.request_comment;
        tr.appendChild(comment);
    } else {
        tr.appendChild(cell('—', 'text-secondary small'));
    }

    tr.appendChild(cell(formatWhen(item.requested_at), 'text-secondary small text-nowrap'));

    const actions = document.createElement('td');
    actions.className = 'text-end';

    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'btn btn-sm btn-outline-success py-0 px-2 me-1';
    approve.dataset.decision = 'approve';
    approve.dataset.id = String(item.id);
    approve.textContent = 'Approve';
    actions.appendChild(approve);

    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'btn btn-sm btn-outline-danger py-0 px-2';
    reject.dataset.decision = 'reject';
    reject.dataset.id = String(item.id);
    reject.textContent = 'Reject';
    actions.appendChild(reject);

    tr.appendChild(actions);

    return tr;
}

function renderQueue(queue) {
    const box = $('prodQueue');
    if (!box) return;

    box.className = '';
    box.innerHTML = '';

    if (queue.length === 0) {
        box.className = 'text-secondary';
        box.textContent = 'Nothing is waiting. Versions appear here when a developer submits one for approval.';
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'table-responsive';

    const table = document.createElement('table');
    table.className = 'table table-hover align-middle small mb-0';
    table.innerHTML = `
      <thead class="text-uppercase">
        <tr>
          <th>Version</th>
          <th>Submitted by</th>
          <th>Their note</th>
          <th>When</th>
          <th class="text-end"></th>
        </tr>
      </thead>
    `;

    const tbody = document.createElement('tbody');
    for (const item of queue) tbody.appendChild(row(item));

    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
}

async function loadQueue() {
    const box = $('prodQueue');
    if (!box) return;

    try {
        const response = await apiFetch(`${API}/creative-approvals`, { credentials: 'include' });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load what is waiting.');
        }

        renderQueue(data.approvals || []);

    } catch (err) {
        console.error('Could not load the approval queue:', err.message);

        box.className = 'text-secondary';
        box.textContent = '';
        showAlert(err.message, 'danger');
    }
}

async function decide(id, decision, comment) {
    showAlert('');

    try {
        const response = await apiFetch(`${API}/creative-approvals/${id}/${decision}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision_comment: comment }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || `Could not ${decision} it.`);
        }

        showAlert(
            decision === 'approve'
                ? 'Approved. The version is now in the game asset store.'
                : 'Rejected. The lock is released and the developer can work on it again.',
            'success'
        );

        // Reloaded from the server rather than removing the row locally: the
        // server is what knows whether it actually moved.
        await loadQueue();

    } catch (err) {
        showAlert(err.message, 'danger');
    }
}

// One delegated listener for the whole table, so a reload cannot leave
// listeners attached to rows that no longer exist.
function onDecision(event) {
    const button = event.target.closest('button[data-decision]');
    if (!button) return;

    const id = Number(button.dataset.id);
    const decision = button.dataset.decision;

    if (decision === 'approve') {
        const ok = window.confirm(
            'Approve this version?\n\n' +
            'It moves into the game asset store, and ownership passes to the ' +
            'game. This is the point at which it becomes part of the project ' +
            'rather than the developer\'s own work.'
        );

        if (!ok) return;

        decide(id, 'approve', '');
        return;
    }

    // A rejection MUST carry a reason — see the note at the top of this file.
    const reason = window.prompt(
        'Why is this being rejected?\n\n' +
        'The developer sees this, and it is the only thing telling them what to ' +
        'change. It cannot be empty.'
    );

    if (reason === null) return;              // cancelled

    if (!reason.trim()) {
        showAlert('A rejection needs a reason — the developer has nothing else to go on.', 'warning');
        return;
    }

    decide(id, 'reject', reason.trim());
}

document.addEventListener('DOMContentLoaded', () => {
    const box = $('prodQueue');
    if (!box) return;

    box.addEventListener('click', onDecision);

    loadQueue();
});
