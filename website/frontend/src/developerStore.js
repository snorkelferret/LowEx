// frontend/src/developerStore.js
//
// The Game store tab: what the studio has approved, and how to take a copy.
//
// ============================================================
// THE FIRST PAGE HERE THAT CONSUMES RATHER THAN PRODUCES
// ============================================================
//
// Every other developer page makes things. This one is where you find what
// already exists — including work by other people, because the store is the
// studio's rather than yours. Until this existed, the only way to know what was
// in it was to read the database.
//
// ============================================================
// TWO ACTIONS THAT LOOK SIMILAR AND ARE NOT
// ============================================================
//
//   DOWNLOAD   gives you the files, with a manifest. Nothing changes here; you
//              have a zip and the game store does not know or care.
//
//   IMPORT     takes the version into YOUR WORKSPACE and RECORDS WHERE IT CAME
//              FROM. That link is the whole point: approving your workspace
//              version later ADDS A VERSION to the store asset rather than
//              creating a second one with the same name.
//
// SO IMPORT IS THE ONE THAT MATTERS, and the page says so rather than leaving
// two buttons that look interchangeable.

import { $ } from './utils.js';
import { apiFetch } from './api.js';
import { formatBytes } from '../../shared/formatBytes.mjs';

const API = '/api/game';

let allAssets = [];
let query = '';

function showAlert(boxId, message, variant) {
    const box = $(boxId);
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.className = `alert alert-${variant} py-2 px-3 small`;
    box.textContent = message;
}

// SQLite gives 'YYYY-MM-DD HH:MM:SS' in UTC, and Safari reads that as an
// Invalid Date without the T and the Z — the same helper the other panels use.
function formatWhen(value) {
    if (!value) return '';

    const parsed = new Date(String(value).replace(' ', 'T') + 'Z');

    if (Number.isNaN(parsed.getTime())) return String(value);

    return parsed.toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// One row
// ------------------------------------------------------------

function row(asset) {
    const tr = document.createElement('tr');

    // WHAT IT IS
    const what = document.createElement('td');

    const name = document.createElement('div');
    name.className = 'fw-medium';
    name.textContent = asset.name;
    what.appendChild(name);

    if (asset.description) {
        const description = document.createElement('div');
        description.className = 'small text-secondary';
        description.textContent = asset.description;
        what.appendChild(description);
    }

    tr.appendChild(what);

    // WHAT PART OF THE GAME
    tr.appendChild(cell(asset.category || '—', 'small text-secondary'));

    // HOW MUCH OF IT
    const size = document.createElement('td');
    size.className = 'small text-secondary text-nowrap';

    const versions = asset.version_count === 1
        ? '1 version'
        : `${asset.version_count} versions`;

    size.textContent = `${asset.file_count} file${asset.file_count === 1 ? '' : 's'}`;
    size.title = `${versions}, latest v${asset.latest_version_number}`;
    tr.appendChild(size);

    tr.appendChild(cell(formatBytes(asset.total_bytes), 'small text-secondary text-nowrap'));
    tr.appendChild(cell(formatWhen(asset.created_at), 'small text-secondary text-nowrap'));

    // WHAT YOU CAN DO WITH IT
    const actions = document.createElement('td');
    actions.className = 'text-end text-nowrap';

    // A LINK, NOT A BUTTON WITH A FETCH. The browser already knows how to
    // download a file, and letting it do so means the archive streams straight
    // to disk rather than through memory in this page.
    const download = document.createElement('a');
    download.className = 'btn btn-sm btn-outline-secondary py-0 px-2 me-1';
    download.href = `${API}/${asset.id}/versions/${asset.latest_version_number}/download`;
    download.title =
        'Download the latest version as a zip, with a manifest of every file';
    download.innerHTML = '<i class="bi bi-download"></i> Download';

    // The link needs a version ID rather than a number, so it is corrected once
    // the asset's versions are known — see loadVersionIds().
    download.dataset.asset = String(asset.id);
    actions.appendChild(download);

    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'btn btn-sm btn-outline-success py-0 px-2';
    importButton.dataset.import = String(asset.id);
    importButton.dataset.name = asset.name;
    importButton.title =
        'Take this version into your workspace, recording where it came from, ' +
        'so approving it again becomes a new version of this asset';
    importButton.innerHTML = '<i class="bi bi-box-arrow-in-down"></i> Import';
    actions.appendChild(importButton);

    tr.appendChild(actions);

    return tr;
}

function cell(text, className) {
    const td = document.createElement('td');
    td.className = className || '';
    td.textContent = text ?? '';
    return td;
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

function render() {
    const box = $('storeList');
    if (!box) return;

    const needle = query.trim().toLowerCase();

    const shown = needle
        ? allAssets.filter(asset => [
            asset.name,
            asset.category,
            asset.description,
            asset.asset_type,
        ].filter(Boolean).join(' ').toLowerCase().includes(needle))
        : allAssets;

    box.innerHTML = '';
    box.className = '';

    const count = $('storeCount');

    if (count) {
        count.textContent = allAssets.length === 0
            ? ''
            : `${shown.length} of ${allAssets.length} asset${allAssets.length === 1 ? '' : 's'}`;
    }

    if (allAssets.length === 0) {
        box.className = 'text-secondary';
        box.textContent =
            'Nothing has been approved for the game yet. Assets appear here ' +
            'once creative approval has accepted them.';
        return;
    }

    if (shown.length === 0) {
        box.className = 'text-secondary';
        box.textContent = `Nothing in the store matches "${query.trim()}".`;
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'table-responsive';

    const table = document.createElement('table');
    table.className = 'table table-hover align-middle small mb-0';
    table.innerHTML = `
      <thead class="text-uppercase">
        <tr>
          <th>Asset</th>
          <th>Category</th>
          <th>Latest</th>
          <th>Size</th>
          <th>Approved</th>
          <th class="text-end"></th>
        </tr>
      </thead>
    `;

    const body = document.createElement('tbody');
    for (const asset of shown) body.appendChild(row(asset));

    table.appendChild(body);
    wrap.appendChild(table);
    box.appendChild(wrap);

    loadVersionIds();
}

// ------------------------------------------------------------
// The download links need a VERSION ID, and the list carries version NUMBERS
// ------------------------------------------------------------
//
// Deliberately a second pass rather than a query per asset in the list: a page
// of twenty assets should be one request, not twenty-one. The links are corrected
// as each answer arrives, and a link that is never corrected simply 404s rather
// than downloading the wrong thing.
async function loadVersionIds() {
    const links = document.querySelectorAll('a[data-asset]');

    await Promise.all([...links].map(async (link) => {
        if (link.dataset.resolved === '1') return;

        const assetId = Number(link.dataset.asset);

        try {
            const response = await apiFetch(`${API}/${assetId}`, { credentials: 'include' });
            if (!response.ok) return;

            const data = await response.json();
            const latest = (data.versions || [])[0];

            if (!latest) return;

            link.href = `${API}/${assetId}/versions/${latest.id}/download`;
            link.dataset.resolved = '1';
            link.dataset.version = String(latest.id);

        } catch {
            // A link that cannot be resolved stays where it is and 404s. That
            // is a better failure than a link that silently points somewhere
            // else.
        }
    }));
}

// ------------------------------------------------------------
// Loading
// ------------------------------------------------------------

async function load() {
    const box = $('storeList');
    if (!box) return;

    try {
        const response = await apiFetch(API, { credentials: 'include' });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load the game store.');
        }

        allAssets = data.assets || [];
        render();

    } catch (err) {
        console.error('Could not load the game store:', err.message);

        box.className = 'text-secondary';
        box.textContent = '';
        showAlert('storeAlert', err.message, 'danger');
    }
}

// ------------------------------------------------------------
// Importing
// ------------------------------------------------------------

async function importAsset(assetId, versionId, name, button) {
    const ok = window.confirm(
        `Import "${name}" into your workspace?\\n\\n` +
        'This takes a copy you can work on, and records which store asset and ' +
        'version it came from — so submitting it for approval again becomes a ' +
        'NEW VERSION of this asset rather than a second asset with the same ' +
        'name.\\n\\n' +
        'Nothing is duplicated: the files are shared, not copied.'
    );

    if (!ok) return;

    showAlert('storeAlert', '');
    showAlert('storeResult', '');

    button.disabled = true;
    const original = button.innerHTML;
    button.textContent = 'Importing…';

    try {
        const response = await apiFetch(`${API}/${assetId}/versions/${versionId}/import`, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not import it.');
        }

        // TWO OUTCOMES, AND THEY ARE NOT THE SAME NEWS. "Imported" means it is
        // now in the workspace; "already" means it was there and nothing
        // happened — which is not a failure and should not be reported as one.
        showAlert(
            'storeResult',
            data.status === 'already'
                ? data.message
                : `Imported. "${name}" is now in your workspace — see the Upload tab.`,
            'success'
        );

    } catch (err) {
        showAlert('storeAlert', err.message, 'danger');

    } finally {
        button.disabled = false;
        button.innerHTML = original;
    }
}

// ------------------------------------------------------------
// Wiring
// ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    // Only present on the developer dashboard.
    if (!$('storeList')) return;

    const search = $('storeSearch');
    const list = $('storeList');

    search?.addEventListener('input', () => {
        query = search.value;
        render();
    });

    // One delegated listener, so a reload cannot leave listeners on rows that
    // no longer exist.
    list?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-import]');
        if (!button) return;

        const assetId = Number(button.dataset.import);

        // The version to import is the one the download link resolved to, which
        // is the same "current" version the page is showing.
        const link = list.querySelector(`a[data-asset="${assetId}"]`);
        const versionId = Number(link?.dataset.version);

        if (!Number.isInteger(versionId)) {
            showAlert(
                'storeAlert',
                'Still working out which version to import. Try again in a moment.',
                'warning'
            );
            return;
        }

        importAsset(assetId, versionId, button.dataset.name, button);
    });

    load();
});
