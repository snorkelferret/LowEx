// frontend/src/adminReleases.js
//
// The Game releases panel: named builds, what is in them, and the queue of
// approved work that could go into one.
//
// ============================================================
// WHY THIS EXISTS
// ============================================================
//
// An approved version could record a changelist and nothing else. "Which
// version of the game does this go into, and what is already in it?" had no
// answer anywhere — not in the portal, and not in a document. This is that
// answer: a release is a NAME and a DATE, its content is a set of approved
// versions, and the candidates are everything approved that it does not hold.
//
// ============================================================
// THE TWO LISTS, AND WHY THEY ARE DIFFERENT
// ============================================================
//
//   IN THIS RELEASE   what this build ships. One version per asset — the
//                     server refuses a second and names the one in the way.
//
//   CANDIDATES        approved, not in this release. A version already in
//                     ANOTHER release still appears, marked, because the same
//                     version can ship in several builds.
//
// ============================================================
// THE CHANGELIST IS OPTIONAL AND IS AN ASSERTION
// ============================================================
//
// The portal does not talk to Perforce. Adding a version to a release writes
// the membership; giving a changelist also records the import, which is what
// makes "what put this in Unreal" answerable later.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';

const API = '/api/releases';

let selectedId = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function showAlert(message, variant = 'danger') {
    const box = $('releaseAlert');
    if (!box) return;

    if (!message) {
        box.className = 'alert py-2 px-3 small d-none';
        box.textContent = '';
        return;
    }

    box.className = `alert alert-${variant} py-2 px-3 small`;
    box.textContent = message;
}

async function fetchJson(url, options = {}) {
    const response = await apiFetch(url, { credentials: 'include', ...options });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || 'That request was refused.');
    }

    return data;
}

function formatDate(value) {
    if (!value) return null;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

// "BigTree v3 — approved by prod on 12 Nov" — the line an admin reads.
function versionLabel(row) {
    const approved = row.approved_by
        ? `approved by ${escapeHtml(row.approved_by)}`
        : 'approval record missing';

    const when = row.decided_at ? ` on ${formatDate(row.decided_at)}` : '';

    return `${escapeHtml(row.asset_name)} <span class="text-secondary">v${row.version_number} — ${approved}${when}</span>`;
}

// ---------------------------------------------------------------------------
// The list of releases
// ---------------------------------------------------------------------------

function renderReleases(releases) {
    const list = $('releaseList');
    if (!list) return;

    list.innerHTML = '';

    if (releases.length === 0) {
        list.innerHTML = '<span class="text-secondary">No releases yet. Name one above — “0.4 Experimental, 12 Nov”.</span>';
        return;
    }

    for (const release of releases) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'list-group-item list-group-item-action bg-transparent text-start'
            + (release.id === selectedId ? ' active' : '');
        button.dataset.releaseId = String(release.id);

        const date = release.released_on ? formatDate(release.released_on) : 'no date';
        const changelist = release.changelist ? ` · CL ${release.changelist}` : '';

        button.innerHTML =
            `<span class="fw-semibold">${escapeHtml(release.name)}</span>` +
            `<span class="d-block small text-secondary">${date}${changelist} · ` +
            `${release.asset_count} version${release.asset_count === 1 ? '' : 's'}</span>`;

        list.appendChild(button);
    }
}

async function loadReleases() {
    try {
        const data = await fetchJson(API);
        renderReleases(data.releases || []);
    } catch (err) {
        showAlert(`Could not load releases: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// One release
// ---------------------------------------------------------------------------

function renderMembers(members) {
    const box = $('releaseMembers');
    const count = $('releaseMemberCount');

    if (count) count.textContent = `(${members.length})`;
    if (!box) return;

    box.innerHTML = '';

    if (members.length === 0) {
        box.innerHTML = '<span class="text-secondary">Nothing in this release yet.</span>';
        return;
    }

    const table = document.createElement('table');
    table.className = 'table table-sm align-middle mb-0';
    table.innerHTML = '<thead class="text-uppercase small"><tr><th>Asset</th><th>Approved</th><th>CL</th><th></th></tr></thead>';

    const body = document.createElement('tbody');

    for (const row of members) {
        const tr = document.createElement('tr');

        tr.innerHTML =
            `<td>${escapeHtml(row.asset_name)} <span class="text-secondary">v${row.version_number}</span></td>` +
            `<td class="small text-secondary">${row.approved_by ? escapeHtml(row.approved_by) : '—'}${row.decided_at ? ` · ${formatDate(row.decided_at)}` : ''}</td>` +
            `<td class="small text-secondary">${row.changelist ? `CL ${row.changelist}` : '—'}</td>`;

        const actions = document.createElement('td');
        actions.className = 'text-end';

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-sm btn-outline-danger py-0 px-2';
        remove.textContent = 'Remove';
        remove.dataset.removeVersion = String(row.asset_version_id);
        actions.appendChild(remove);

        tr.appendChild(actions);
        body.appendChild(tr);
    }

    table.appendChild(body);
    box.appendChild(table);
}

function renderCandidates(candidates) {
    const box = $('releaseCandidates');
    const count = $('releaseCandidateCount');
    const select = $('releaseCandidate');
    const form = $('releaseAddForm');

    if (count) count.textContent = `(${candidates.length})`;
    if (!box || !select || !form) return;

    box.innerHTML = '';
    select.innerHTML = '';

    if (candidates.length === 0) {
        box.innerHTML = '<span class="text-secondary">Everything approved is already in this release.</span>';
        form.classList.add('d-none');
        return;
    }

    const list = document.createElement('ul');
    list.className = 'list-unstyled mb-0';

    for (const row of candidates) {
        const item = document.createElement('li');
        item.className = 'mb-1';

        item.innerHTML = versionLabel(row)
            + (row.in_other_release
                ? ' <span class="badge text-bg-secondary ms-1">in another release</span>'
                : '');

        list.appendChild(item);

        const option = document.createElement('option');
        option.value = String(row.asset_version_id);
        option.textContent = `${row.asset_name} v${row.version_number}`;
        select.appendChild(option);
    }

    box.appendChild(list);
    form.classList.remove('d-none');
}

function renderDetail(detail) {
    const { release, members, candidates } = detail;

    const panel = $('releaseDetail');
    if (panel) panel.classList.remove('d-none');

    const title = $('releaseDetailTitle');
    if (title) title.textContent = release.name;

    const meta = $('releaseDetailMeta');
    if (meta) {
        const parts = [];

        parts.push(release.released_on ? `Released ${formatDate(release.released_on)}` : 'No date');
        if (release.changelist) parts.push(`CL ${release.changelist}`);
        if (release.created_by) parts.push(`created by ${release.created_by}`);
        if (release.notes) parts.push(release.notes);

        meta.textContent = parts.join(' · ');
    }

    renderMembers(members);
    renderCandidates(candidates);
}

async function selectRelease(id) {
    selectedId = id;

    try {
        const detail = await fetchJson(`${API}/${id}`);
        renderDetail(detail);

        // Keep the list's highlight in step without a second request.
        for (const button of document.querySelectorAll('#releaseList [data-release-id]')) {
            button.classList.toggle('active', Number(button.dataset.releaseId) === id);
        }
    } catch (err) {
        showAlert(`Could not load that release: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function onSubmitCreate(event) {
    event.preventDefault();

    const name = $('releaseName')?.value.trim();

    if (!name) {
        showAlert('A release needs a name.', 'warning');
        return;
    }

    const payload = {
        name,
        released_on: $('releaseDate')?.value || null,
        changelist: $('releaseChangelist')?.value || null,
        notes: $('releaseNotes')?.value || null
    };

    fetchJson(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(detail => {
            showAlert('', 'success');
            $('releaseCreateForm')?.reset();
            return loadReleases().then(() => selectRelease(detail.release.id));
        })
        .catch(err => showAlert(err.message));
}

function onSubmitAdd(event) {
    event.preventDefault();

    if (selectedId === null) return;

    const versionId = Number($('releaseCandidate')?.value);

    if (!Number.isInteger(versionId)) {
        showAlert('Choose a version first.', 'warning');
        return;
    }

    const payload = {
        asset_version_id: versionId,
        changelist: $('releaseAddChangelist')?.value || null,
        note: $('releaseAddNote')?.value || null
    };

    fetchJson(`${API}/${selectedId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(detail => {
            showAlert('', 'success');
            $('releaseAddForm')?.reset();
            renderDetail(detail);
            loadReleases();
        })
        .catch(err => showAlert(err.message));
}

function onClickList(event) {
    const button = event.target.closest('button[data-release-id]');
    if (!button) return;

    selectRelease(Number(button.dataset.releaseId));
}

// DELETING THE RELEASE, NOT ITS CONTENT. The membership cascades; the approved
// versions stay in the store. A misspelt release can be removed and named again.
function onClickDelete() {
    if (selectedId === null) return;

    const name = $('releaseDetailTitle')?.textContent || 'this release';

    if (!window.confirm(`Delete ${name}? The versions stay in the store; only the release is removed.`)) {
        return;
    }

    fetchJson(`${API}/${selectedId}`, { method: 'DELETE' })
        .then(() => {
            selectedId = null;
            $('releaseDetail')?.classList.add('d-none');
            $('releaseAlert')?.classList.add('d-none');
            loadReleases();
        })
        .catch(err => showAlert(err.message));
}

function onClickRemove(event) {
    const button = event.target.closest('button[data-remove-version]');
    if (!button || selectedId === null) return;

    const versionId = Number(button.dataset.removeVersion);

    fetchJson(`${API}/${selectedId}/assets/${versionId}`, { method: 'DELETE' })
        .then(detail => {
            showAlert('', 'success');
            renderDetail(detail);
            loadReleases();
        })
        .catch(err => showAlert(err.message));
}

document.addEventListener('DOMContentLoaded', () => {
    $('releaseCreateForm')?.addEventListener('submit', onSubmitCreate);
    $('releaseAddForm')?.addEventListener('submit', onSubmitAdd);
    $('releaseList')?.addEventListener('click', onClickList);
    $('releaseMembers')?.addEventListener('click', onClickRemove);
    $('releaseDeleteBtn')?.addEventListener('click', onClickDelete);

    loadReleases();
});
