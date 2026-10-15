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
// The negotiation: what is already on the developer's machine decides what is
// fetched, and only the difference crosses the wire.
import { downloadVersion, canNegotiate } from './storeDownload.js';

// apiFetch adds the session cookie and signs out on 401. This adds the two
// things every call here needs on top: the error shape the server uses, and a
// way to ask for the raw Response instead of parsed JSON.
async function fetchJson(url, { raw = false, ...options } = {}) {
    const response = await apiFetch(url, { credentials: 'include', ...options });

    if (raw) return response;

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'The server refused that request.');
    }

    return response.json();
}

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

    // THE ZIP, ALWAYS. It works in every browser, it is what §5B specifies, and
    // it is the fallback the negotiation degrades to.
    const zip = document.createElement('a');
    zip.className = 'btn btn-sm btn-outline-secondary py-0 px-1';
    zip.href = `${API}/${asset.id}/versions/${asset.latest_version_number}/download`;
    zip.title =
        'Download the latest version as a zip, with a manifest of every file';
    zip.innerHTML = '<i class="bi bi-file-zip"></i><span class="visually-hidden">Download as a zip</span>';

    // The link needs a version ID rather than a number, so it is corrected once
    // the asset's versions are known — see loadVersionIds().
    zip.dataset.asset = String(asset.id);
    actions.appendChild(zip);

    // AND THE NEGOTIATION, WHERE THE BROWSER CAN DO IT. Only Chromium can read
    // and write a folder the developer picks; Firefox and Safari have no
    // equivalent, so the button is not offered rather than offered and broken.
    if (canNegotiate()) {
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'btn btn-sm btn-outline-primary py-0 px-2 me-1';
        download.dataset.download = String(asset.id);
        download.dataset.name = asset.name;
        download.title =
            'Choose a folder and fetch only what you do not already have — ' +
            'the difference is worked out by hash, and nothing is downloaded twice';
        download.innerHTML = '<i class="bi bi-folder-down me-1"></i>Download';

        actions.insertBefore(download, zip);
    }

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
// Downloading — the negotiation
// ------------------------------------------------------------

// WHAT WAS FOUND, BEFORE ANYTHING IS FETCHED. The point of the negotiation is
// that the developer sees the working-out rather than a progress bar: how much
// of this they already have, and what is actually going to cross the wire.
function reportToPage({ phase, plan, summary, assetName }) {
    if (phase === 'planned') {
        const bits = [];

        if (plan.keep.length) {
            bits.push(`${plan.keep.length} file${plan.keep.length === 1 ? '' : 's'} you already have`);
        }

        if (plan.write.length) {
            bits.push(
                `${plan.write.length} to fetch (${formatBytes(plan.writeBytes)})`
            );
        }

        if (plan.replace.length) {
            bits.push(`${plan.replace.length} that would be REPLACED`);
        }

        if (plan.write.length === 0 && plan.replace.length === 0) {
            showAlert('storeResult', 'You already have every file in this version. Nothing to fetch.', 'success');
            return;
        }

        showAlert('storeResult', `Checked: ${bits.join(', ')}.`, 'info');
    }

    if (phase === 'done') {
        const bits = [`${summary.written} file${summary.written === 1 ? '' : 's'} written`];

        if (summary.kept) bits.push(`${summary.kept} already there`);
        if (summary.replaced) bits.push(`${summary.replaced} replaced`);
        if (summary.failed) bits.push(`${summary.failed} FAILED — see the console`);

        showAlert(
            'storeResult',
            `${assetName}: ${bits.join(', ')}. ` +
            (summary.targetFolder ? `Written under "${summary.targetFolder}".` : ''),
            summary.failed ? 'warning' : 'success'
        );
    }
}

// LISTED BY NAME, NEVER SILENTLY. These files exist and differ, so writing them
// destroys something the developer has.
function confirmReplacements(files) {
    const shown = files.slice(0, 5).map(f => f.target).join('\n  ');

    return window.confirm(
        `${files.length} file(s) already exist with DIFFERENT contents:\n\n  ${shown}` +
        (files.length > 5 ? `\n  …and ${files.length - 5} more` : '') +
        '\n\nReplace them with the version from the store?'
    );
}

// THE FOLDER THEY WERE UPLOADED IN, WHICH MAY BE RENAMED.
//
// Item 54 calls that folder transport and says it is never retained; the code
// retains it (item 81), so the manifest's paths carry it and this is where a
// developer says otherwise. Cancelling keeps the default rather than aborting —
// the answer to "what shall I call this" is never "stop the download".
function chooseRootFolder(root) {
    if (!root) return null;

    const answer = window.prompt(
        `The files were uploaded in a folder called "${root}".\n\n` +
        'What should it be called on your machine? The structure inside it is kept.',
        root
    );

    if (answer === null) return root;

    return answer.trim() || root;
}

async function downloadAsset(assetId, versionId, name, button) {
    showAlert('storeAlert', '');
    showAlert('storeResult', '');

    button.disabled = true;
    const original = button.innerHTML;
    button.textContent = 'Choosing…';

    try {
        await downloadVersion({
            assetId,
            versionId,
            assetName: name,
            fetchJson,
            onReport: reportToPage,
            confirmReplacements,
            chooseRootFolder
        });

        // The history has a new entry, so the page reloads what it knows.
        await load();

    } catch (err) {
        // The folder picker being cancelled is not an error — it is somebody
        // changing their mind, and a red box for it would be wrong.
        if (err?.name === 'AbortError') {
            showAlert('storeResult', 'Cancelled — nothing was fetched.', 'secondary');
        } else {
            console.error('Could not download:', err);
            showAlert('storeAlert', err.message, 'danger');
        }

    } finally {
        button.disabled = false;
        button.innerHTML = original;
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

        // THREE OUTCOMES, AND THEY ARE NOT THE SAME NEWS. "Imported" means it
        // is now in the workspace; "already" means it was there and nothing
        // happened; "restored" means it was IN THE BIN and has come back —
        // which a developer needs to be told, because an asset reappearing
        // without explanation is exactly the kind of thing that makes somebody
        // distrust a page.
        const messages = {
            already: data.message,
            restored:
                `"${name}" was in your bin, so it has been RESTORED and the ` +
                'current version imported on top of it. Its earlier versions are ' +
                'back too.',
            imported: `Imported. "${name}" is now in your workspace — see the Upload tab.`
        };

        showAlert('storeResult', messages[data.status] || messages.imported, 'success');

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
        const downloadButton = event.target.closest('button[data-download]');

        if (downloadButton) {
            const id = Number(downloadButton.dataset.download);
            const link = list.querySelector(`a[data-asset="${id}"]`);
            const version = Number(link?.dataset.version);

            if (!Number.isInteger(version)) {
                showAlert('storeAlert', 'Still working out which version to fetch. Try again in a moment.', 'warning');
                return;
            }

            downloadAsset(id, version, downloadButton.dataset.name, downloadButton);
            return;
        }

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
