// frontend/src/adminReleases.js
//
// The Game releases panel: named builds, what is in them, the queue of approved
// work that could go into one, each version's FILES as a tree, and the DIFF
// between two builds.
//
// ============================================================
// WHY THIS EXISTS
// ============================================================
//
// An approved version could record a changelist and nothing else. "Which
// version of the game does this go into, what is already in it, and what is
// actually inside it?" had no answer anywhere. A release is a NAME and a DATE;
// its content is a set of approved versions; each version is a set of files
// with content hashes.
//
// ============================================================
// THE THREE THINGS ON THIS PAGE
// ============================================================
//
//   IN THIS RELEASE   what this build ships. One version per asset — the
//                     server refuses a second and names the one in the way.
//
//   CANDIDATES        approved, not in this release. A version already in
//                     ANOTHER release still appears, marked.
//
//   FILES / DIFF      the manifest of one version as a tree, with each file's
//                     hash and size behind a toggle; and what changed between
//                     two builds, by asset and by file CONTENT HASH.
//
// THE UPLOADER IS NOT ON THE STORE VERSION. The store records who approved;
// who authored it is one link back through the approval, and the server joins
// it. Both are shown, because they are different people and different acts.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';
import { formatBytes } from '../../shared/formatBytes.mjs';

const API = '/api/releases';
const GAME_API = '/api/game';

let selectedId = null;
let allReleases = [];

// WHICH PANEL, IF ANY, IS OPEN. Both the file tree and the diff are revealed
// by a button, and the same button hides them again — a control that only
// opens is a one-way door, and the only way back was to change release.
let openManifest = null;   // { assetId, versionId }
let openDiff = null;       // "fromId:toId" 

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

const shortHash = hash => (hash ? `${hash.slice(0, 12)}…` : '—');

// "uploaded by val · approved by prod · 12 Nov" — the line an admin reads.
function peopleLine(row) {
    const parts = [];

    if (row.uploaded_by) parts.push(`uploaded by ${escapeHtml(row.uploaded_by)}`);
    if (row.approved_by) parts.push(`approved by ${escapeHtml(row.approved_by)}`);
    if (row.decided_at) parts.push(formatDate(row.decided_at));

    return parts.join(' · ');
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

// The two selects for the diff, kept in step with the list. A selection is
// preserved when it still exists, so comparing does not reset itself.
function refreshDiffSelects() {
    for (const id of ['releaseDiffFrom', 'releaseDiffTo']) {
        const select = $(id);
        if (!select) continue;

        const previous = select.value;

        select.innerHTML = allReleases
            .map(release => `<option value="${release.id}">${escapeHtml(release.name)}</option>`)
            .join('');

        if (previous && allReleases.some(r => String(r.id) === previous)) {
            select.value = previous;
        }
    }

    // Default: to = the selected release, from = the newest other one.
    const to = $('releaseDiffTo');
    const from = $('releaseDiffFrom');

    if (to && selectedId !== null) to.value = String(selectedId);

    if (from && (!from.value || from.value === to?.value)) {
        const other = allReleases.find(r => String(r.id) !== from.value);
        if (other) from.value = String(other.id);
    }
}

async function loadReleases() {
    try {
        const data = await fetchJson(API);
        allReleases = data.releases || [];
        renderReleases(allReleases);
        refreshDiffSelects();
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
    table.innerHTML =
        '<thead class="text-uppercase small"><tr>' +
        '<th>Asset</th><th>Who</th><th>CL</th><th></th>' +
        '</tr></thead>';

    const body = document.createElement('tbody');

    for (const row of members) {
        const tr = document.createElement('tr');

        tr.innerHTML =
            `<td>${escapeHtml(row.asset_name)} <span class="text-secondary">v${row.version_number}</span></td>` +
            `<td class="small text-secondary">${peopleLine(row)}</td>` +
            `<td class="small text-secondary">${row.changelist ? `CL ${row.changelist}` : '—'}</td>`;

        const actions = document.createElement('td');
        actions.className = 'text-end text-nowrap';

        const files = document.createElement('button');
        files.type = 'button';
        files.className = 'btn btn-sm btn-outline-secondary py-0 px-2 me-1';
        files.textContent = 'Files';
        files.dataset.manifestAsset = String(row.asset_id);
        files.dataset.manifestVersion = String(row.asset_version_id);
        files.dataset.manifestName = `${row.asset_name} v${row.version_number}`;
        actions.appendChild(files);

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

        item.innerHTML =
            `<span class="fw-semibold">${escapeHtml(row.asset_name)}</span> ` +
            `<span class="text-secondary">v${row.version_number}</span> ` +
            `<span class="text-secondary small">— ${peopleLine(row)}</span>` +
            (row.in_other_release
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

    // A manifest belongs to one version and one release; changing release
    // closes it rather than leaving a tree labelled with the wrong build.
    $('releaseManifest')?.classList.add('d-none');
    openManifest = null;

    renderMembers(members);
    renderCandidates(candidates);
    refreshDiffSelects();
}

async function selectRelease(id) {
    selectedId = id;

    try {
        const detail = await fetchJson(`${API}/${id}`);
        renderDetail(detail);

        for (const button of document.querySelectorAll('#releaseList [data-release-id]')) {
            button.classList.toggle('active', Number(button.dataset.releaseId) === id);
        }
    } catch (err) {
        showAlert(`Could not load that release: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// The manifest, as a tree
// ---------------------------------------------------------------------------
//
// THE MANIFEST IS THE VERSION'S FILE LIST, read from the same endpoint a
// downloader uses — so what an admin sees here is exactly what a download would
// contain, not a second interpretation of the database.

function buildTree(files) {
    const root = { dirs: new Map(), files: [] };

    for (const file of files) {
        const parts = String(file.relative_path || '')
            .split('/')
            .filter(Boolean);

        let node = root;

        for (const part of parts) {
            if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
            node = node.dirs.get(part);
        }

        node.files.push(file);
    }

    return root;
}

function renderNode(node, parent) {
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `📁 ${name}`;
        details.appendChild(summary);

        const inner = document.createElement('div');
        inner.className = 'ps-3';
        renderNode(child, inner);
        details.appendChild(inner);

        parent.appendChild(details);
    }

    for (const file of [...node.files].sort((a, b) => a.filename.localeCompare(b.filename))) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `📄 ${file.filename}`;
        details.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'ps-3 text-secondary';
        body.innerHTML =
            `<div>sha256: <code class="text-info">${escapeHtml(file.sha256)}</code></div>` +
            `<div>size: ${formatBytes(file.size)}</div>` +
            `<div>path: ${escapeHtml(`${file.relative_path || ''}/${file.filename}`.replace(/^\/+/, ''))}</div>`;

        details.appendChild(body);
        parent.appendChild(details);
    }
}

function resetManifestButtons() {
    for (const button of document.querySelectorAll('#releaseMembers button[data-manifest-version]')) {
        button.textContent = 'Files';
        button.classList.remove('active');
    }
}

function hideManifest() {
    $('releaseManifest')?.classList.add('d-none');
    resetManifestButtons();
    openManifest = null;
}

async function toggleManifest(button) {
    const assetId = Number(button.dataset.manifestAsset);
    const versionId = Number(button.dataset.manifestVersion);

    if (openManifest && openManifest.versionId === versionId) {
        hideManifest();
        return;
    }

    resetManifestButtons();
    button.textContent = 'Hide';
    button.classList.add('active');

    openManifest = { assetId, versionId };

    await loadManifest(assetId, versionId, button.dataset.manifestName);
}

async function loadManifest(assetId, versionId, label) {
    const panel = $('releaseManifest');
    const title = $('releaseManifestTitle');
    const tree = $('releaseManifestTree');

    if (!panel || !title || !tree) return;

    panel.classList.remove('d-none');
    title.textContent = `${label} — loading…`;
    tree.innerHTML = '';

    try {
        const manifest = await fetchJson(`${GAME_API}/${assetId}/versions/${versionId}/manifest`);

        const files = manifest.files || [];

        title.innerHTML =
            `${escapeHtml(label)} — ${files.length} file${files.length === 1 ? '' : 's'}, ` +
            `${formatBytes(manifest.total_bytes || 0)}, ` +
            `<span class="text-secondary fw-normal">manifest <code>${shortHash(manifest.manifest_hash)}</code></span>`;

        const root = document.createElement('div');
        renderNode(buildTree(files), root);
        tree.innerHTML = '';
        tree.appendChild(root);

    } catch (err) {
        title.textContent = label;
        tree.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
    }
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

const STATUS_STYLE = {
    added: { label: 'Added', badge: 'success' },
    removed: { label: 'Removed', badge: 'danger' },
    changed: { label: 'Changed', badge: 'warning' },
    unchanged: { label: 'Unchanged', badge: 'secondary' }
};

function renderFileLine(text) {
    const row = document.createElement('div');
    row.className = 'ps-3';
    row.innerHTML = text;
    return row;
}

function renderDiff(diff) {
    const box = $('releaseDiffResult');
    if (!box) return;

    box.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'mb-2';
    heading.innerHTML =
        `<strong>${escapeHtml(diff.from.name)}</strong> → <strong>${escapeHtml(diff.to.name)}</strong> ` +
        `<span class="text-secondary">` +
        `${diff.summary.added} added · ${diff.summary.removed} removed · ` +
        `${diff.summary.changed} changed · ${diff.summary.unchanged} unchanged</span>`;
    box.appendChild(heading);

    for (const asset of diff.assets || []) {
        const style = STATUS_STYLE[asset.status] || STATUS_STYLE.unchanged;

        if (asset.status === 'unchanged') {
            const line = document.createElement('div');
            line.className = 'text-secondary small mb-1';
            line.textContent = `${asset.asset_name} — unchanged (v${asset.to_version})`;
            box.appendChild(line);
            continue;
        }

        const details = document.createElement('details');
        details.className = 'mb-1';

        const summary = document.createElement('summary');
        summary.innerHTML =
            `<span class="badge text-bg-${style.badge} me-2">${style.label}</span>` +
            escapeHtml(asset.asset_name) +
            `<span class="text-secondary"> ` +
            (asset.status === 'added'
                ? `v${asset.to_version}`
                : asset.status === 'removed'
                    ? `v${asset.from_version}`
                    : `v${asset.from_version} → v${asset.to_version}`) +
            `</span>`;
        details.appendChild(summary);

        for (const file of asset.files?.added || []) {
            details.appendChild(renderFileLine(`<span class="text-success">+ ${escapeHtml(file.path)}</span>`));
        }

        for (const file of asset.files?.removed || []) {
            details.appendChild(renderFileLine(`<span class="text-danger">− ${escapeHtml(file.path)}</span>`));
        }

        for (const file of asset.files?.changed || []) {
            details.appendChild(renderFileLine(
                `<span class="text-warning">~ ${escapeHtml(file.path)}</span> ` +
                `<span class="text-secondary">${shortHash(file.from_sha256)} → ${shortHash(file.to_sha256)}</span>`
            ));
        }

        box.appendChild(details);
    }
}

function hideDiff() {
    const box = $('releaseDiffResult');
    if (box) box.innerHTML = '';

    const button = $('releaseDiffBtn');
    if (button) button.textContent = 'Compare';

    openDiff = null;
}

async function runDiff() {
    const from = Number($('releaseDiffFrom')?.value);
    const to = Number($('releaseDiffTo')?.value);

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
        showAlert('Choose two releases to compare.', 'warning');
        return;
    }

    const key = `${from}:${to}`;

    // The same button closes what it opened.
    if (openDiff === key) {
        hideDiff();
        return;
    }

    try {
        const diff = await fetchJson(`${API}/${to}/diff?against=${from}`);
        renderDiff(diff);

        openDiff = key;
        const button = $('releaseDiffBtn');
        if (button) button.textContent = 'Hide diff';
    } catch (err) {
        showAlert(`Could not compare those releases: ${err.message}`);
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

function onClickMembers(event) {
    const manifestButton = event.target.closest('button[data-manifest-version]');

    if (manifestButton) {
        toggleManifest(manifestButton);
        return;
    }

    const removeButton = event.target.closest('button[data-remove-version]');
    if (!removeButton || selectedId === null) return;

    fetchJson(`${API}/${selectedId}/assets/${Number(removeButton.dataset.removeVersion)}`, {
        method: 'DELETE'
    })
        .then(detail => {
            showAlert('', 'success');
            renderDetail(detail);
            loadReleases();
        })
        .catch(err => showAlert(err.message));
}

// DELETING THE RELEASE, NOT ITS CONTENT. The membership cascades; the approved
// versions stay in the store.
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
            hideDiff();
            loadReleases();
        })
        .catch(err => showAlert(err.message));
}

document.addEventListener('DOMContentLoaded', () => {
    $('releaseCreateForm')?.addEventListener('submit', onSubmitCreate);
    $('releaseAddForm')?.addEventListener('submit', onSubmitAdd);
    $('releaseList')?.addEventListener('click', onClickList);
    $('releaseMembers')?.addEventListener('click', onClickMembers);
    $('releaseDeleteBtn')?.addEventListener('click', onClickDelete);
    $('releaseDiffBtn')?.addEventListener('click', runDiff);
    $('releaseDiffFrom')?.addEventListener('change', hideDiff);
    $('releaseDiffTo')?.addEventListener('change', hideDiff);
    $('releaseManifestClose')?.addEventListener('click', hideManifest);

    loadReleases();
});
