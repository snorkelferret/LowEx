// frontend/src/builds.js
//
// The Game builds panel: named builds, what is in them, the queue of approved
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
// AND THE BUILDS LIST COUNTS YOUR OWN WORK in each build, before it is even
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

const API = '/api/builds';
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

// THE BUILD'S VERDICT IS PRODUCTION'S CRAFT, and an administrator may correct
// it. A developer sees the status and does not draw the controls.
const CAN_REVIEW = ME.role === 'prod' || ME.role === 'admin';

let selectedId = null;
let allBuilds = [];

// WHICH STREAM GROUP IS OPEN. `null` is a real group — builds from before
// streams were recorded — so a boolean says whether one is open at all.
let selectedStream = null;
let streamOpen = false;

// The streams Perforce has told the portal about, so a stream with no builds
// yet is visible rather than waiting for its first build to exist.
let knownStreams = [];
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
    const box = $('buildAlert');
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

// A duration a person can read. Seconds below a minute, then minutes, then
// hours — a build is measured in minutes, not milliseconds.
function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || seconds === '') return null;

    const total = Number(seconds);

    if (!Number.isFinite(total) || total < 0) return null;

    if (total < 60) return `${total}s`;

    const minutes = Math.floor(total / 60);
    const rest = total % 60;

    if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const min = minutes % 60;

    return min ? `${hours}h ${min}m` : `${hours}h`;
}

const isMine = row => Boolean(ME.username && row.uploaded_by === ME.username);

const mineOnly = () => Boolean($('buildMineOnly')?.checked);

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
// Streams, and the builds in one
// ---------------------------------------------------------------------------

const NONE = '__none__';

const streamKeyOf = build => build.stream || NONE;

const streamLabel = key => key === NONE ? 'No stream recorded' : key;

// The badges a build carries wherever it is listed.
function buildVerdict(build) {
    return (build.over_size || build.over_time
        ? ' · <span class="text-warning">over limit</span>'
        : '') +
        (build.result === 'failed' ? ' · <span class="text-danger">build failed</span>' : '') +
        (build.status === 'rejected'
            ? ' · <span class="text-danger">rejected</span>'
            : build.status === 'accepted'
                ? ' · <span class="text-success">accepted</span>'
                : '');
}

function renderStreams() {
    const list = $('streamList');
    if (!list) return;

    const groups = new Map();

    for (const build of allBuilds) {
        const key = streamKeyOf(build);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(build);
    }

    // A stream Perforce named but which has no build yet is still a stream.
    for (const stream of knownStreams) {
        if (!groups.has(stream)) groups.set(stream, []);
    }

    const keys = [...groups.keys()].filter(key => key !== NONE).sort();

    // The legacy group goes last: it is a gap in the record, not a stream.
    if (groups.has(NONE)) keys.push(NONE);

    list.innerHTML = '';

    if (keys.length === 0) {
        list.innerHTML = '<span class="text-secondary">No streams or builds recorded yet.</span>';
        return;
    }

    for (const key of keys) {
        const builds = groups.get(key);

        // NEWEST BY CHANGELIST, not by the order the rows were written: a
        // report queued while the portal was down can arrive out of order.
        const latest = [...builds].sort(
            (a, b) => (b.changelist || 0) - (a.changelist || 0)
        )[0];

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'list-group-item list-group-item-action bg-transparent text-start'
            + (streamOpen && selectedStream === key ? ' active' : '');
        button.dataset.stream = key;

        const count = `${builds.length} build${builds.length === 1 ? '' : 's'}`;

        const latestText = latest
            ? ` · latest ${escapeHtml(latest.name)}` +
              `${latest.changelist ? ` (CL ${latest.changelist})` : ''}${buildVerdict(latest)}`
            : ' · no builds yet';

        button.innerHTML =
            `<span class="fw-semibold">${key === NONE ? 'No stream recorded' : escapeHtml(key)}</span>` +
            `<span class="d-block small text-secondary">${count}${latestText}</span>`;

        list.appendChild(button);
    }
}

function renderStreamBuilds(key) {
    const list = $('buildList');
    if (!list) return;

    $('streamBuildsSection')?.classList.remove('d-none');

    const title = $('streamTitle');
    if (title) title.textContent = streamLabel(key);

    const builds = allBuilds.filter(build => streamKeyOf(build) === key);

    list.innerHTML = '';

    if (builds.length === 0) {
        list.innerHTML = '<span class="text-secondary">No builds recorded for this stream yet.</span>';
        return;
    }

    for (const build of builds) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'list-group-item list-group-item-action bg-transparent text-start'
            + (build.id === selectedId ? ' active' : '');
        button.dataset.buildId = String(build.id);

        const date = build.released_on ? formatDate(build.released_on) : 'no date';
        const changelist = build.changelist ? ` · CL ${build.changelist}` : '';

        const mine = build.mine_count > 0
            ? ` · <span class="text-info">${build.mine_count} of yours</span>`
            : '';

        button.innerHTML =
            `<span class="fw-semibold">${escapeHtml(build.name)}</span>` +
            `<span class="d-block small text-secondary">${date}${changelist} · ` +
            `${build.asset_count} version${build.asset_count === 1 ? '' : 's'}${mine}${buildVerdict(build)}</span>`;

        list.appendChild(button);
    }
}

function hideStream() {
    streamOpen = false;
    selectedStream = null;

    $('streamBuildsSection')?.classList.add('d-none');
    hideDetail();
    renderStreams();
}

function onClickStream(event) {
    const button = event.target.closest('button[data-stream]');
    if (!button) return;

    const key = button.dataset.stream;

    if (streamOpen && selectedStream === key) {
        hideStream();
        return;
    }

    hideDetail();

    streamOpen = true;
    selectedStream = key;

    renderStreams();
    renderStreamBuilds(key);
}

function refreshDiffSelects() {
    for (const id of ['buildDiffFrom', 'buildDiffTo']) {
        const select = $(id);
        if (!select) continue;

        const previous = select.value;

        select.innerHTML = allBuilds
            .map(build => `<option value="${build.id}">${escapeHtml(build.name)}</option>`)
            .join('');

        if (previous && allBuilds.some(r => String(r.id) === previous)) {
            select.value = previous;
        }
    }

    const to = $('buildDiffTo');
    const from = $('buildDiffFrom');

    if (to && selectedId !== null) to.value = String(selectedId);

    if (from && (!from.value || from.value === to?.value)) {
        const other = allBuilds.find(r => String(r.id) !== from.value);
        if (other) from.value = String(other.id);
    }
}

async function loadBuilds() {
    try {
        const data = await fetchJson(API);
        allBuilds = data.builds || [];

        try {
            const streams = await fetchJson('/api/perforce/streams');
            knownStreams = (streams.streams || []).map(row => row.stream);
        } catch {
            // The builds are the important half; a streams fetch that fails
            // only means a stream with no builds is not listed.
            knownStreams = [];
        }

        renderStreams();

        if (streamOpen) renderStreamBuilds(selectedStream);

        refreshDiffSelects();
    } catch (err) {
        showAlert(`Could not load builds: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// What is in a build
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
    const box = $('buildMembers');
    const count = $('buildMemberCount');
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
            ? 'Nothing in this build yet.'
            : 'None of this build is yours.');
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
    const box = $('buildCandidates');
    const count = $('buildCandidateCount');
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
            ? 'Everything approved is already in this build.'
            : 'None of the candidates are yours.');
    }

    for (const row of shown) {
        const tr = document.createElement('tr');

        tr.appendChild(assetCell(row, row.in_other_build
            ? ' <span class="badge text-bg-secondary ms-1">in another build</span>'
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
// One build
// ---------------------------------------------------------------------------

function renderDetail(detail) {
    currentDetail = detail;
    const { build } = detail;

    $('buildDetail')?.classList.remove('d-none');

    const title = $('buildDetailTitle');
    if (title) title.textContent = build.name;

    renderReview(build);
    renderStats(build, detail.limits || {});

    const meta = $('buildDetailMeta');
    if (meta) {
        const parts = [];
        parts.push(build.released_on ? `Released ${formatDate(build.released_on)}` : 'No date');
        if (build.stream) parts.push(build.stream);
        if (build.build_id) parts.push(`build ${build.build_id}`);
        if (build.changelist) parts.push(`CL ${build.changelist}`);
        if (build.source === 'reported') parts.push('reported by the build machine');
        if (build.created_by) parts.push(`created by ${build.created_by}`);
        if (build.notes) parts.push(build.notes);
        meta.textContent = parts.join(' · ');
    }

    // The tree belongs to one version and one build; changing build closes
    // it rather than leaving a tree labelled with the wrong build.
    $('buildManifest')?.classList.add('d-none');
    openManifest = null;

    renderMembers(detail.members || []);
    renderCandidates(detail.candidates || []);

    // HOW MUCH OF IT IS THE VIEWER'S. Said once, in the header, rather than
    // repeated on every row.
    const note = $('buildMineNote');
    if (note) {
        const mine = (detail.members || []).filter(isMine).length;
        note.textContent = mine
            ? `${mine} of the versions in this build are yours.`
            : 'None of this build is your work.';
    }

    refreshDiffSelects();
}

async function selectBuild(id) {
    selectedId = id;

    try {
        const detail = await fetchJson(`${API}/${id}`);
        renderDetail(detail);

        for (const button of document.querySelectorAll('#buildList [data-build-id]')) {
            button.classList.toggle('active', Number(button.dataset.buildId) === id);
        }
    } catch (err) {
        showAlert(`Could not load that build: ${err.message}`);
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
    for (const button of document.querySelectorAll('#buildMembers button[data-manifest-version]')) {
        button.textContent = 'Files';
        button.classList.remove('active');
    }
}

function hideManifest() {
    $('buildManifest')?.classList.add('d-none');
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
    const panel = $('buildManifest');
    const title = $('buildManifestTitle');
    const tree = $('buildManifestTree');

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
    const box = $('buildDiffResult');
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
    const box = $('buildDiffResult');
    if (box) box.innerHTML = '';

    const button = $('buildDiffBtn');
    if (button) button.textContent = 'Compare';

    openDiff = null;
}

async function runDiff() {
    const from = Number($('buildDiffFrom')?.value);
    const to = Number($('buildDiffTo')?.value);

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
        showAlert('Choose two builds to compare.', 'warning');
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
        const button = $('buildDiffBtn');
        if (button) button.textContent = 'Hide diff';
    } catch (err) {
        showAlert(`Could not compare those builds: ${err.message}`);
    }
}

// What the build machine measured: result, time, size, warnings and errors,
// and the first errors when it failed. Absent fields are absent, not zero.
function renderStats(build, limits = {}) {
    const stats = $('buildStats');
    const failure = $('buildFailureLine');
    const limitLine = $('buildLimitLine');
    const logBox = $('buildLogBox');
    const logText = $('buildLogExcerpt');

    if (stats) {
        const parts = [];

        if (build.result === 'succeeded') parts.push('Build succeeded');
        if (build.result === 'failed') parts.push('Build failed');

        const duration = formatDuration(build.duration_seconds);
        if (duration) parts.push(`took ${duration}`);

        if (build.output_bytes !== null && build.output_bytes !== undefined) {
            parts.push(formatBytes(build.output_bytes));
        }

        if (build.warnings !== null && build.warnings !== undefined) {
            parts.push(`${build.warnings} warning${build.warnings === 1 ? '' : 's'}`);
        }

        if (build.errors !== null && build.errors !== undefined) {
            parts.push(`${build.errors} error${build.errors === 1 ? '' : 's'}`);
        }

        stats.textContent = parts.length
            ? parts.join(' · ')
            : 'No build stats reported.';
    }

    if (failure) {
        const failed = build.result === 'failed';

        failure.classList.toggle('d-none', !failed);
        failure.textContent = failed
            ? `Failed${build.failed_stage ? ` at ${build.failed_stage}` : ''}.`
            : '';
    }

    if (limitLine) {
        const over = [];

        if (build.over_size) {
            over.push(`Over the size limit — ${formatBytes(limits.max_bytes)}`);
        }

        if (build.over_time) {
            over.push(`Over the time limit — ${formatDuration(limits.max_seconds)}`);
        }

        limitLine.classList.toggle('d-none', over.length === 0);
        limitLine.textContent = over.join(' · ');
    }

    if (logBox && logText) {
        const hasLog = Boolean(build.log_excerpt);

        logBox.classList.toggle('d-none', !hasLog);
        logText.textContent = hasLog ? build.log_excerpt : '';
    }

    // A BUILD THAT DID NOT COMPILE CANNOT BE ACCEPTED. The server refuses it;
    // the page does not offer it.
    const accept = $('buildAcceptBtn');

    if (accept) {
        accept.disabled = build.result === 'failed';
        accept.title = build.result === 'failed'
            ? 'A build that failed cannot be accepted.'
            : 'Accept this build';
    }
}

// Where the build itself stands, and who may change it.
function renderReview(build) {
    const badge = $('buildStatusBadge');
    const note = $('buildReviewNote');
    const controls = $('buildReviewControls');

    if (badge) {
        const status = build.status || 'unreviewed';
        badge.textContent = status === 'accepted'
            ? 'Accepted'
            : status === 'rejected'
                ? 'Rejected'
                : 'Unreviewed';
        badge.className = 'badge ' + (status === 'accepted'
            ? 'text-bg-success'
            : status === 'rejected'
                ? 'text-bg-danger'
                : 'text-bg-secondary');
    }

    if (note) {
        const parts = [];
        if (build.review_note) parts.push(build.review_note);
        if (build.reviewed_by) parts.push(`by ${build.reviewed_by}`);
        if (build.reviewed_at) parts.push(formatDate(build.reviewed_at));
        note.textContent = parts.join(' · ');
    }

    if (controls) {
        controls.classList.toggle('d-none', !CAN_REVIEW);
    }
}

function reviewBuild(status, reason) {
    if (selectedId === null) return;

    fetchJson(`${API}/${selectedId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason: reason || null })
    })
        .then(detail => {
            showAlert(status === 'accepted' ? 'Build accepted.' : 'Build rejected.', 'success');
            renderDetail(detail);
            loadBuilds();
        })
        .catch(err => showAlert(err.message));
}

function onClickAccept() {
    if (!window.confirm('Accept this build?')) return;
    reviewBuild('accepted', '');
}

function onClickReject() {
    const reason = window.prompt(
        'Why is this build being rejected?\n\n' +
        'A technical failure — a size ceiling, a time budget — or a judgement ' +
        'about how it looks. It is shown on the build and recorded.'
    );

    if (reason === null) return;

    if (reason.trim().length < 3) {
        showAlert('A rejection needs a reason.', 'warning');
        return;
    }

    reviewBuild('rejected', reason.trim());
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function addVersion(versionId, name) {
    if (selectedId === null) return;

    const payload = {
        asset_version_id: versionId,
        changelist: $('buildAddChangelist')?.value || null,
        note: $('buildAddNote')?.value || null
    };

    fetchJson(`${API}/${selectedId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(detail => {
            showAlert(`${name} added.`, 'success');
            renderDetail(detail);
            loadBuilds();
        })
        .catch(err => showAlert(err.message));
}

// CLOSING A RELEASE: the same entry that opened it closes it. Selecting is a
// toggle, so the list is not a one-way door into whichever build was clicked
// last.
function hideDetail() {
    selectedId = null;
    currentDetail = null;

    $('buildDetail')?.classList.add('d-none');

    hideManifest();
    hideDiff();

    for (const button of document.querySelectorAll('#buildList [data-build-id]')) {
        button.classList.remove('active');
    }

    const note = $('buildMineNote');
    if (note) note.textContent = '';
}

function onClickList(event) {
    const button = event.target.closest('button[data-build-id]');
    if (!button) return;

    const id = Number(button.dataset.buildId);

    if (id === selectedId) {
        hideDetail();
        return;
    }

    selectBuild(id);
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
            loadBuilds();
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

    const name = $('buildDetailTitle')?.textContent || 'this build';

    if (!window.confirm(`Delete ${name}? The versions stay in the store; only the build is removed.`)) {
        return;
    }

    fetchJson(`${API}/${selectedId}`, { method: 'DELETE' })
        .then(() => {
            selectedId = null;
            $('buildDetail')?.classList.add('d-none');
            hideDiff();
            loadBuilds();
        })
        .catch(err => showAlert(err.message));
}

document.addEventListener('DOMContentLoaded', () => {
    // WHAT THIS VIEWER MAY NOT DO IS NOT OFFERED. The server refuses it in any
    // case; a button that would be refused is a button that teaches the wrong
    // thing about the role.
    if (!IS_ADMIN) {
        $('buildDeleteBtn')?.classList.add('d-none');
        $('buildAddControls')?.classList.add('d-none');
    }

    $('streamList')?.addEventListener('click', onClickStream);
    $('buildList')?.addEventListener('click', onClickList);
    $('streamHideBtn')?.addEventListener('click', hideStream);
    $('buildMembers')?.addEventListener('click', onClickMembers);
    $('buildCandidates')?.addEventListener('click', onClickCandidates);
    $('buildDeleteBtn')?.addEventListener('click', onClickDelete);
    $('buildAcceptBtn')?.addEventListener('click', onClickAccept);
    $('buildRejectBtn')?.addEventListener('click', onClickReject);
    $('buildDiffBtn')?.addEventListener('click', runDiff);
    $('buildDiffFrom')?.addEventListener('change', hideDiff);
    $('buildDiffTo')?.addEventListener('change', hideDiff);
    $('buildManifestClose')?.addEventListener('click', hideManifest);
    $('buildMineOnly')?.addEventListener('change', onMineChange);
    $('buildHideBtn')?.addEventListener('click', hideDetail);

    loadBuilds();
});
