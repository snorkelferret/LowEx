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

// THE STREAMS THE PORTAL KNOWS ABOUT, so retargeting is a choice rather than a
// path typed from memory. Cached for the page: they change when somebody
// submits, not while production is looking at the queue.
let cachedStreams = [];

function destinationCell(item) {
    const td = document.createElement('td');
    td.className = 'small';

    const current = document.createElement('div');
    current.textContent = item.destination_kind === 'game'
        ? (item.destination_stream || 'A game version')
        : 'The library';
    td.appendChild(current);

    if (item.destination_kind === 'game') {
        current.textContent = `Game: ${item.destination_stream || 'unnamed'}`;
    }

    if (item.destination_source === 'prod' || item.destination_source === 'admin') {
        const by = document.createElement('div');
        by.className = 'text-secondary small';
        by.textContent = `changed by ${item.destination_source}`;
        td.appendChild(by);
    }

    // WHAT WAS TESTED, WHERE. The receipt is the evidence production is being
    // asked to rely on; its absence next to a game destination is a fact worth
    // seeing rather than a blank.
    if (item.receipt) {
        const tested = document.createElement('div');
        tested.className = 'text-secondary small';

        // THE BUILD IS NAMED WHEN THE PORTAL KNOWS IT, and its absence is
        // stated rather than left as a bare changelist. Neither reading
        // refuses anything: the gate is the stream (decided 2026-11-19).
        const where = item.receipt.build
            ? `in ${item.receipt.build.name}`
            : 'in a build the portal has no record of';

        tested.textContent =
            `${item.receipt.result === 'passed' ? 'Tested' : 'Test failed'} ${where} — ` +
            `${item.receipt.parent_stream || item.receipt.stream} at CL ` +
            `${item.receipt.changelist}` +
            `${item.receipt.levels?.length ? ` — ${item.receipt.levels.join(', ')}` : ''}`;
        td.appendChild(tested);

        // A REJECTED BUILD IS STILL WHAT THE TEST RAN IN. Say so, with the
        // reason, rather than silently presenting it as context.
        if (item.receipt.build?.status === 'rejected') {
            const rejected = document.createElement('div');
            rejected.className = 'text-danger small';
            rejected.textContent =
                'That build was rejected' +
                `${item.receipt.build.review_note ? `: ${item.receipt.build.review_note}` : '.'}`;
            td.appendChild(rejected);
        }

        // ADVICE, NOT A REFUSAL. A newer build on the destination stream is
        // worth knowing; whether it matters is production's judgement.
        if (item.receipt.newer_build) {
            const newer = document.createElement('div');
            newer.className = 'text-warning small';
            newer.textContent =
                `A newer build is on this stream: ${item.receipt.newer_build.name} ` +
                `(CL ${item.receipt.newer_build.changelist}). Ask for a re-test if it matters.`;
            td.appendChild(newer);
        }
    } else if (item.destination_kind === 'game') {
        const none = document.createElement('div');
        none.className = 'text-warning small';
        none.textContent = 'No test receipt';
        td.appendChild(none);
    }

    // A DECIDED SUBMISSION IS NOT RETARGETED, so the control is not drawn.
    // The server refuses it (409); drawing a control that cannot work is the
    // thing the page avoids everywhere else.
    if (item.status !== 'pending') {
        return td;
    }

    const controls = document.createElement('div');
    controls.className = 'd-flex gap-1 mt-1';

    const select = document.createElement('select');
    select.className = 'form-select form-select-sm bg-dark text-light border-secondary py-0';
    select.dataset.destinationId = String(item.id);

    const libraryOption = document.createElement('option');
    libraryOption.value = 'library';
    libraryOption.textContent = 'The library';
    select.appendChild(libraryOption);

    const streams = new Set(cachedStreams);

    if (item.destination_kind === 'game' && item.destination_stream) {
        streams.add(item.destination_stream);
    }

    for (const stream of [...streams].sort()) {
        const option = document.createElement('option');
        option.value = stream;
        option.textContent = stream;
        select.appendChild(option);
    }

    select.value = item.destination_kind === 'game'
        ? (item.destination_stream || 'library')
        : 'library';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-sm btn-outline-secondary py-0 px-2';
    apply.dataset.destination = String(item.id);
    apply.textContent = 'Set';

    controls.appendChild(select);
    controls.appendChild(apply);
    td.appendChild(controls);

    return td;
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

    tr.appendChild(destinationCell(item));

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
          <th>Destination</th>
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
        // The game versions the portal has been told about. Fetched once; a
        // queue reload does not need to ask again.
        if (cachedStreams.length === 0) {
            const streams = await apiFetch('/api/perforce/streams', { credentials: 'include' })
                .then(response => response.ok ? response.json() : { streams: [] })
                .catch(() => ({ streams: [] }));

            cachedStreams = (streams.streams || []).map(row => row.stream);
        }

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
// RETARGETING IS PRODUCTION'S CALL, AND THE SERVER STILL CHECKS THE EVIDENCE.
// Moving a submission to a game version without a passing test in that version
// is refused — so this reports the refusal rather than hiding it.
async function retarget(id) {
    const select = document.querySelector(`select[data-destination-id="${id}"]`);
    if (!select) return;

    const value = String(select.value || '').trim();
    const kind = value === 'library' ? 'library' : 'game';

    showAlert('');

    try {
        const response = await apiFetch(`${API}/creative-approvals/${id}/destination`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                destination_kind: kind,
                destination_stream: kind === 'game' ? value : undefined,
            }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not change the destination.');
        }

        showAlert(
            kind === 'library'
                ? 'Destination changed to the library.'
                : `Destination changed to ${value}.`,
            'success'
        );

        await loadQueue();

    } catch (err) {
        showAlert(err.message, 'danger');
    }
}

function onDecision(event) {
    const retargetButton = event.target.closest('button[data-destination]');
    if (retargetButton) {
        retarget(Number(retargetButton.dataset.destination));
        return;
    }

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
