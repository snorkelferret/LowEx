// frontend/src/releases.js
//
// The Game releases panel: named builds, what is in them, the queue of approved
// work that could go into one, each version's FILES as a tree, and the DIFF
// between two builds.
//
// ============================================================
// ONE PANEL, TWO PAGES, TWO ROLES
// ============================================================
//
// The same file is the admin's section and the developer's tab. The server
// decides what is allowed — reads are developer+admin, writes are admin — and
// this script does not offer what the server would refuse: the create form, the
// delete button, the add and remove buttons and the changelist fields are
// hidden unless the viewer is an administrator.
//
// A DEVELOPER SEES THE SAME THING, READ-ONLY, plus two aids for the question
// they actually have — "which of my assets were accepted, and into what":
//
//   ONLY MY WORK   filters both lists to versions the viewer uploaded
//   SORTING        every column header sorts, so finding your rows in a long
//                  build does not mean reading it
//
// AND THE RELEASES LIST COUNTS YOUR OWN WORK in each build, before it is even
// opened.
//
// ============================================================
// THE UPLOADER IS NOT THE APPROVER
// ============================================================
//
// The store version records both. created_by is who approved it; uploaded_by is
// who authored it. "Mine" means uploaded_by, because that is the question "my
// work" asks.

import { $, escapeHtml } from './utils.js';
import { apiFetch } from './api.js';
import { formatBytes } from '../../shared/formatBytes.mjs';

const API = '/api/releases';
const GAME_API = '/api/game';

// WHO IS LOOKING. From the profile the login stored — cosmetic only, because
// the server checks the role on every request; this decides what to DRAW.
const ME = (() => {
    try {
        return JSON.parse(localStorage.getItem('user_info') || '{}') || {};
    } catch {
        return {};
    }
})();

const IS_ADMIN = ME.role === 'admin';

let selectedId = null;
let allReleases = [];
let currentDetail = null;

// WHICH PANEL, IF ANY, IS OPEN. Both the file tree and the diff are revealed by
// a button, and the same button hides them again — a control that only opens is
// a one-way door.
let openManifest = null;   // { assetId, versionId }
let openDiff = null;       // "fromId:toId"

// Sorting, per table. Toggling a header flips the direction; choosing another
// header starts ascending on that one.
let memberSort = { key: 'asset', dir: 1 };
let candidateSort = { key: 'asset', dir: 1 };

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

const isMine = row => Boolean(ME.username && row.uploaded_by === ME.username);

const mineOnly = () => Boolean($('releaseMineOnly')?.checked);

// The sort keys, so the header buttons and the comparators cannot disagree.
const SORT_KEYS = {
    asset: row => String(row.asset_name || '').toLowerCase(),
    version: row => row.version_number || 0,
    uploaded: row => String(row.uploaded_by || '').toLowerCase(),
    approved: row => String(row.approved_by || '').toLowerCase(),
    decided: row => String(row.decided_at || ''),
    changelist: row => row.changelist || 0
};

function sortRows(rows, sort) {
    const key = SORT_KEYS[sort.key] || SORT_KEYS.asset;

    return [...rows].sort((a, b) => {
        const left = key(a);
        const right = key(b);

        if (left < right) return -1 * sort.dir;
        if (left > right) return 1 * sort.dir;
        return String(a.asset_name).localeCompare(String(b.asset_name));
    });
}

// A column header that sorts. The arrow says which column is in charge and
// which way round.
function sortHeader(label, table, key, current) {
    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-link p-0 text-decoration-none text-uppercase small '
        + (current.key === key ? 'text-info' : 'text-secondary');
    button.dataset.sortTable = table;
    button.dataset.sortKey = key;
    button.innerHTML = escapeHtml(label)
        + (current.key === key
            ? ` <i class="bi bi-caret-${current.dir === 1 ? 'up' : 'down'}-fill"></i>`
            : ' <i class="bi bi-arrow-down-up"></i>');

    th.appendChild(button);
    return th;
}

// ---------------------------------------------------------------------------
// The list of releases
// ---------------------------------------------------------------------------

function renderReleases(releases) {
    const list = $('releaseList');
    if (!list) return;

    list.innerHTML = '';

    if (releases.length === 0) {
        list.innerHTML = '<span class="text-secondary">No releases yet.</span>';
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

        // HOW MUCH OF THIS BUILD IS THE VIEWER'S OWN WORK. That is the question
        // a developer opens this page to answer.
        const mine = release.mine_count > 0
            ? ` · <span class="text-info">${release.mine_count} of yours</span>`
            : '';

        button.innerHTML =
            `<span class="fw-semibold">${escapeHtml(release.name)}</span>` +
            `<span class="d-block small text-secondary">${date}${changelist} · ` +
            `${release.asset_count} version${release.asset_count === 1 ? '' : 's'}${mine}</span>`;

        list.appendChild(button);
    }
}

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
// What is in a release
// ---------------------------------------------------------------------------

function peopleCell(row) {
    const cell = document.createElement('td');
    cell.className = 'small text-secondary';

    const parts = [];
    if (row.uploaded_by) parts.push(`uploaded ${escapeHtml(row.uploaded_by)}`);
    if (row.approved_by) parts.push(`approved ${escapeHtml(row.approved_by)}`);
    if (row.decided_at) parts.push(formatDate(row.decided_at));

    cell.innerHTML = parts.join(' · ') || '—';
    return cell;
}

function assetCell(row, extraBadge) {
    const cell = document.createElement('td');

    cell.innerHTML =
        `${escapeHtml(row.asset_name)} <span class="text-secondary">v${row.version_number}</span>` +
        (isMine(row) ? ' <span class="badge text-bg-info ms-1">yours</span>' : '') +
        (extraBadge || '');

    return cell;
}

function emptyRow(table, message) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'text-secondary';
    td.textContent = message;
    tr.appendChild(td);
    table.appendChild(tr);
}

function renderMembers(members) {
    const box = $('releaseMembers');
    const count = $('releaseMemberCount');
    if (!box) return;

    const shown = sortRows(mineOnly() ? members.filter(isMine) : members, memberSort);

    if (count) {
        const mine = members.filter(isMine).length;
        count.textContent = `(${shown.length}${shown.length !== members.length ? ` of ${members.length}` : ''}`
            + `${mine ? ` · ${mine} yours` : ''})`;
    }

    box.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'table table-sm align-middle mb-0';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(sortHeader('Asset', 'members', 'asset', memberSort));
    headRow.appendChild(sortHeader('Uploaded', 'members', 'uploaded', memberSort));
    headRow.appendChild(sortHeader('Approved', 'members', 'approved', memberSort));
    headRow.appendChild(sortHeader('CL', 'members', 'changelist', memberSort));
    headRow.appendChild(document.createElement('th'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const body = document.createElement('tbody');

    if (shown.length === 0) {
        emptyRow(table, members.length === 0
            ? 'Nothing in this release yet.'
            : 'None of this release is yours.');
    }

    for (const row of shown) {
        const tr = document.createElement('tr');

        tr.appendChild(assetCell(row));
        tr.appendChild(peopleCell(row));

        const changelist = document.createElement('td');
        changelist.className = 'small text-secondary';
        changelist.textContent = row.changelist ? `CL ${row.changelist}` : '—';
        tr.appendChild(changelist);

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

        if (IS_ADMIN) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn btn-sm btn-outline-danger py-0 px-2';
            remove.textContent = 'Remove';
            remove.dataset.removeVersion = String(row.asset_version_id);
            actions.appendChild(remove);
        }

        tr.appendChild(actions);
        body.appendChild(tr);
    }

    table.appendChild(body);
    box.appendChild(table);
}

function renderCandidates(candidates) {
    const box = $('releaseCandidates');
    const count = $('releaseCandidateCount');
    if (!box) return;

    const shown = sortRows(mineOnly() ? candidates.filter(isMine) : candidates, candidateSort);

    if (count) {
        const mine = candidates.filter(isMine).length;
        count.textContent = `(${shown.length}${shown.length !== candidates.length ? ` of ${candidates.length}` : ''}`
            + `${mine ? ` · ${mine} yours` : ''})`;
    }

    box.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'table table-sm align-middle mb-0';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(sortHeader('Asset', 'candidates', 'asset', candidateSort));
    headRow.appendChild(sortHeader('Uploaded', 'candidates', 'uploaded', candidateSort));
    headRow.appendChild(sortHeader('Approved', 'candidates', 'approved', candidateSort));
    headRow.appendChild(document.createElement('th'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const body = document.createElement('tbody');

    if (shown.length === 0) {
        emptyRow(table, candidates.length === 0
            ? 'Everything approved is already in this release.'
            : 'None of the candidates are yours.');
    }

    for (const row of shown) {
        const tr = document.createElement('tr');

        tr.appendChild(assetCell(row, row.in_other_release
            ? ' <span class="badge text-bg-secondary ms-1">in another release</span>'
            : ''));
        tr.appendChild(peopleCell(row));
        tr.appendChild(cellDate(row.decided_at));

        const actions = document.createElement('td');
        actions.className = 'text-end text-nowrap';

        if (IS_ADMIN) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'btn btn-sm btn-success py-0 px-2';
            add.textContent = 'Add';
            add.dataset.addVersion = String(row.asset_version_id);
            add.dataset.addName = `${row.asset_name} v${row.version_number}`;
            actions.appendChild(add);
        }

        tr.appendChild(actions);
        body.appendChild(tr);
    }

    table.appendChild(body);
    box.appendChild(table);
}

// A date cell, in the same shape as peopleCell's tail.
function cellDate(value) {
    const cell = document.createElement('td');
    cell.className = 'small text-secondary';
    cell.textContent = value ? formatDate(value) : '—';
    return cell;
}

// ---------------------------------------------------------------------------
// One release
// ---------------------------------------------------------------------------

function renderDetail(detail) {
    currentDetail = detail;
    const { release } = detail;

    $('releaseDetail')?.classList.remove('d-none');

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

    // The tree belongs to one version and one release; changing release closes
    // it rather than leaving a tree labelled with the wrong build.
    $('releaseManifest')?.classList.add('d-none');
    openManifest = null;

    renderMembers(detail.members || []);
    renderCandidates(detail.candidates || []);

    // HOW MUCH OF IT IS THE VIEWER'S. Said once, in the header, rather than
    // repeated on every row.
    const note = $('releaseMineNote');
    if (note) {
        const mine = (detail.members || []).filter(isMine).length;
        note.textContent = mine
            ? `${mine} of the versions in this release are yours.`
            : 'None of this release is your work.';
    }

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

function buildTree(files) {
    const root = { dirs: new Map(), files: [] };

    for (const file of files) {
        const parts = String(file.relative_path || '').split('/').filter(Boolean);

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

function addVersion(versionId, name) {
    if (selectedId === null) return;

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
            showAlert(`${name} added.`, 'success');
            renderDetail(detail);
            loadReleases();
        })
        .catch(err => showAlert(err.message));
}

// CLOSING A RELEASE: the same entry that opened it closes it. Selecting is a
// toggle, so the list is not a one-way door into whichever build was clicked
// last.
function hideDetail() {
    selectedId = null;
    currentDetail = null;

    $('releaseDetail')?.classList.add('d-none');

    hideManifest();
    hideDiff();

    for (const button of document.querySelectorAll('#releaseList [data-release-id]')) {
        button.classList.remove('active');
    }

    const note = $('releaseMineNote');
    if (note) note.textContent = '';
}

function onClickList(event) {
    const button = event.target.closest('button[data-release-id]');
    if (!button) return;

    const id = Number(button.dataset.releaseId);

    if (id === selectedId) {
        hideDetail();
        return;
    }

    selectRelease(id);
}

// Sorting: any column header in either table.
function onClickSort(event) {
    const button = event.target.closest('button[data-sort-table]');
    if (!button || !currentDetail) return;

    const table = button.dataset.sortTable;
    const key = button.dataset.sortKey;

    if (table === 'members') {
        memberSort = { key, dir: memberSort.key === key ? -memberSort.dir : 1 };
        renderMembers(currentDetail.members || []);
    } else {
        candidateSort = { key, dir: candidateSort.key === key ? -candidateSort.dir : 1 };
        renderCandidates(currentDetail.candidates || []);
    }
}

function onClickMembers(event) {
    if (event.target.closest('button[data-sort-table]')) {
        onClickSort(event);
        return;
    }

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

function onClickCandidates(event) {
    if (event.target.closest('button[data-sort-table]')) {
        onClickSort(event);
        return;
    }

    const addButton = event.target.closest('button[data-add-version]');
    if (!addButton) return;

    addVersion(Number(addButton.dataset.addVersion), addButton.dataset.addName || 'That version');
}

function onMineChange() {
    if (currentDetail) {
        renderMembers(currentDetail.members || []);
        renderCandidates(currentDetail.candidates || []);
    }
}

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
    // WHAT THIS VIEWER MAY NOT DO IS NOT OFFERED. The server refuses it in any
    // case; a button that would be refused is a button that teaches the wrong
    // thing about the role.
    if (!IS_ADMIN) {
        $('releaseCreateForm')?.classList.add('d-none');
        $('releaseDeleteBtn')?.classList.add('d-none');
        $('releaseAddControls')?.classList.add('d-none');
    }

    $('releaseCreateForm')?.addEventListener('submit', onSubmitCreate);
    $('releaseList')?.addEventListener('click', onClickList);
    $('releaseMembers')?.addEventListener('click', onClickMembers);
    $('releaseCandidates')?.addEventListener('click', onClickCandidates);
    $('releaseDeleteBtn')?.addEventListener('click', onClickDelete);
    $('releaseDiffBtn')?.addEventListener('click', runDiff);
    $('releaseDiffFrom')?.addEventListener('change', hideDiff);
    $('releaseDiffTo')?.addEventListener('change', hideDiff);
    $('releaseManifestClose')?.addEventListener('click', hideManifest);
    $('releaseMineOnly')?.addEventListener('change', onMineChange);
    $('releaseHideBtn')?.addEventListener('click', hideDetail);

    loadReleases();
});
