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

// WHO MAY TAKE A COPY INTO A WORKSPACE. Import writes a workspace asset; prod
// has no workspace (item 83 gives prod the READ side only). Download stays —
// it changes nothing.
const ME = (() => {
    try { return JSON.parse(localStorage.getItem('user_info') || '{}') || {}; }
    catch { return {}; }
})();

const CAN_IMPORT = ME.role === 'developer' || ME.role === 'admin';

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

    // WHO AUTHORED THE VERSION THIS ROW IS ABOUT, filled in once its versions
    // are known (loadVersionIds). The list is assets, so the uploader comes
    // from the latest version's record — uploaded_by, not created_by, which is
    // the APPROVER. Two different people and two different columns since
    // 2026-10-30.
    const uploadedBy = document.createElement('div');
    uploadedBy.className = 'small text-secondary';
    uploadedBy.dataset.uploadedBy = String(asset.id);
    what.appendChild(uploadedBy);

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

    // WHAT IS IN THE GAME — which is not necessarily the latest version, and
    // is an ASSERTION somebody recorded rather than an observation: the portal
    // cannot see Perforce (TODO 88 §8). A dash means "not known to be in the
    // game", which honestly covers both "never integrated" and "nobody
    // recorded it" — the portal cannot tell those apart.
    const game = document.createElement('td');
    game.className = 'small text-nowrap';

    if (asset.game_changelist) {
        game.textContent =
            `v${asset.game_version_number} · CL ${asset.game_changelist}`;
    } else {
        game.className += ' text-secondary';
        game.textContent = '—';
    }

    tr.appendChild(game);

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

    // AND THE NEGOTIATION, WHENEVER THE BROWSER CAN DO IT — which is now every
    // browser worth naming.
    //
    // THIS COMMENT USED TO SAY THE OPPOSITE, and it was true when it was
    // written: the first version of this used the File System Access API, so the
    // button was offered to Chrome and Edge and withheld from everybody else.
    // The rewrite removed the API, not the restriction — reading a folder is
    // `<input webkitdirectory>`, which Chrome, Edge, Firefox 50+ and Safari 11.1+
    // all have. So what canNegotiate() really tests now is that AND crypto.subtle,
    // and the second half is the load-bearing one: it needs a secure context, and
    // over plain http: on anything but localhost it is absent.
    //
    // WHICH IS STILL A REASON TO CHECK RATHER THAN ASSUME. A negotiation that
    // cannot hash would call every file missing and re-fetch the lot — worse
    // than not offering it — so the button is offered on what the browser can
    // actually do, and the zip beside it is the answer for everything else.
    if (canNegotiate()) {
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'btn btn-sm btn-outline-primary py-0 px-2 me-1';
        download.dataset.download = String(asset.id);
        download.dataset.name = asset.name;
        download.title =
            'Choose the folder this belongs in. It is read here, in your ' +
            'browser, and the only thing sent to the server is the list of ' +
            'hashes you are missing — so only those files come back. No file ' +
            'contents leave your machine.';
        // THE ELLIPSIS IS THE CONVENTION FOR "THIS OPENS A DIALOG", and this one
        // does — a confirmation, then the browser's folder chooser. Without it
        // the first dialog is a surprise twice over, since the second says
        // "Upload".
        download.innerHTML = '<i class="bi bi-folder-down me-1"></i>Download…';

        actions.insertBefore(download, zip);
    }

    if (CAN_IMPORT) {
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
    }

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
          <th>In the game</th>
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

            // The author of the version this row downloads. The store version
            // records the approver in created_by_username; this is the other
            // person.
            const by = document.querySelector(`[data-uploaded-by="${assetId}"]`);

            if (by && latest.uploaded_by_username) {
                by.textContent = `uploaded by ${latest.uploaded_by_username}`;
            }

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

// ============================================================
// THE DOWNLOAD EXPLAINS ITSELF, AND THE DEVELOPER DECIDES
// ============================================================
//
// EVERY STAGE IS SHOWN WHILE IT IS TRUE, rather than an outcome announced at
// the end. What is about to happen, what is being worked out, what was found,
// and what is going to be fetched — with the chance to stop it.
//
// WHICH IS ALSO THE ONLY WAY IT CAN BE EXPLAINED. The obvious place for a
// confirmation about the folder chooser would be a dialog before it, and a
// dialog before it IS A BUG: the chooser may only be shown while the page still
// holds the activation from the click that started it, and a modal spends it.
// The page says it in ordinary content instead, and the chooser is opened by a
// second, fresh click on a button in that content.

const planBox = () => $('storePlan');

function clearPlan() {
    const box = planBox();
    if (!box) return;

    box.className = 'd-none';
    box.textContent = '';
}

// The panel, filled by the callback, shown in the given Bootstrap alert colour.
function fillPlan(className, build) {
    const box = planBox();
    if (!box) return null;

    box.className = `alert alert-${className} py-2 px-3 small`;
    box.textContent = '';
    build(box);

    return box;
}

// A BUTTON THE FLOW WAITS FOR.
//
// `value` is what the click resolves to. The listener is `once`, so a second
// click on a button that has already answered cannot answer twice — and every
// button in a group is disabled together, so the decision is made once.
function pressAny(box, entries) {
    if (!box) return Promise.resolve(entries[0]?.value);

    return new Promise(resolve => {
        const buttons = entries.map(({ label, className, value }) => {
            const button = document.createElement('button');

            button.type = 'button';
            button.className = `btn btn-sm ${className}`;
            button.textContent = label;

            button.addEventListener('click', () => {
                for (const other of buttons) other.disabled = true;
                resolve(value);
            }, { once: true });

            box.appendChild(button);

            return button;
        });
    });
}

// The files, by name and size, because "42 files" is not something anybody can
// check and a list is. Capped, because a version can hold thousands and the
// count above it already says how many.
function fileList(files, className) {
    const list = document.createElement('ul');
    list.className = `list-unstyled mb-2 font-monospace small ${className || ''}`;
    list.style.maxHeight = '13rem';
    list.style.overflowY = 'auto';

    for (const file of files.slice(0, 300)) {
        const item = document.createElement('li');
        item.className = 'text-truncate';
        item.textContent = `${file.target}  ·  ${formatBytes(file.size)}`;
        list.appendChild(item);
    }

    if (files.length > 300) {
        const item = document.createElement('li');
        item.className = 'text-secondary';
        item.textContent = `…and ${files.length - 300} more, in the zip`;
        list.appendChild(item);
    }

    return list;
}

function paragraph(box, text, className) {
    const p = document.createElement('p');
    p.className = className || 'mb-2';
    p.textContent = text;
    box.appendChild(p);

    return p;
}

async function reportToPage({ phase, plan, summary, assetName, done, total, count, bytes, what }) {

    // ------------------------------------------------------------
    // Before anything: what is about to happen, and the button that starts it
    // ------------------------------------------------------------
    if (phase === 'choose') {
        const box = fillPlan('info', b => {
            paragraph(b, `Downloading ${assetName}.`,
                'mb-1 fw-semibold');

            paragraph(b,
                'Next, your browser asks which folder these files belong in — and ' +
                'the button on that dialog says "Upload". THAT WORD IS THE ' +
                'BROWSER\'S, NOT THIS PAGE\'S: reading a folder is the one thing a ' +
                'browser only knows how to do with its upload control, so every ' +
                'site\'s folder picker says it.',
                'mb-2');

            paragraph(b,
                'No file leaves your machine. The folder is read here, in this ' +
                'browser, and the only thing sent to the server is a list of ' +
                'hashes — sixty-four characters for each file you are missing. ' +
                'You will see that list before anything is fetched, and you can ' +
                'stop it then.',
                'mb-2 text-secondary');
        });

        return pressAny(box, [
            { label: 'Choose folder…', className: 'btn-primary', value: true }
        ]);
    }

    if (phase === 'working') {
        fillPlan('secondary', b => paragraph(b, `Reading ${what}…`));
        return;
    }

    // ------------------------------------------------------------
    // The slow part, counted, because silence looks like a hang
    // ------------------------------------------------------------
    if (phase === 'hashing') {
        // NOTHING TO HASH IS THE COMMON CASE ON A SECOND RUN, and there is
        // nothing to report: the count would be 0 of 0.
        if (total === 0) return;

        fillPlan('secondary', b => {
            paragraph(b,
                `Working out what you already have — ${done} of ${total} files read.`,
                'mb-2');

            const outer = document.createElement('div');
            outer.className = 'progress';
            outer.style.height = '0.4rem';

            const inner = document.createElement('div');
            inner.className = 'progress-bar';
            inner.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;

            outer.appendChild(inner);
            b.appendChild(outer);
        });

        return;
    }

    // ------------------------------------------------------------
    // What it found, listed, and the decision
    // ------------------------------------------------------------
    if (phase === 'planned') {
        const nothingToDo = plan.write.length === 0 && plan.replace.length === 0;

        if (nothingToDo) {
            fillPlan('success', b => paragraph(b,
                `${assetName}: you already have every file in this version — ` +
                `all ${plan.keep.length} of them. Nothing to fetch.`));

            // NOT A CANCELLATION. Nothing was refused; there was simply nothing
            // to do, and saying "cancelled" would be a lie about who decided.
            return { proceed: true, includeReplacements: false };
        }

        const box = fillPlan('info', b => {
            paragraph(b,
                `${assetName}: ${plan.write.length} file` +
                `${plan.write.length === 1 ? '' : 's'} to download ` +
                `(${formatBytes(plan.writeBytes)}).`,
                'mb-1 fw-semibold');

            if (plan.keep.length) {
                paragraph(b,
                    `${plan.keep.length} file${plan.keep.length === 1 ? '' : 's'} ` +
                    'you already have, up to date — not listed, not sent, not fetched.',
                    'mb-2 text-secondary');
            }

            if (plan.write.length) {
                paragraph(b, 'To download:', 'mb-1 text-secondary');
                b.appendChild(fileList(plan.write));
            }

            // LISTED APART, AND OFFERED SEPARATELY. These are the destructive
            // ones — the file at that path exists and is different — and they
            // get their own button below so downloading the missing ones does
            // not quietly overwrite anything.
            if (plan.replace.length) {
                paragraph(b,
                    `${plan.replace.length} of these already exist with DIFFERENT ` +
                    'contents:',
                    'mb-1 fw-semibold text-warning');
                b.appendChild(fileList(plan.replace, 'text-warning'));
            }

            paragraph(b,
                'Sending the hashes of the files above is the only thing that ' +
                'goes to the server. No file contents leave this machine, either ' +
                'way — you are choosing how much comes back.',
                'mb-2 text-secondary');
        });

        const entries = [];

        if (plan.write.length) {
            entries.push({
                label: `Download ${plan.write.length} file${plan.write.length === 1 ? '' : 's'}`,
                className: 'btn-primary me-2',
                value: { proceed: true, includeReplacements: false }
            });
        }

        if (plan.replace.length) {
            entries.push({
                label: `Download and replace ${plan.replace.length}`,
                className: 'btn-warning me-2',
                value: { proceed: true, includeReplacements: true }
            });
        }

        entries.push({ label: 'Cancel', className: 'btn-outline-secondary', value: { proceed: false } });

        return pressAny(box, entries);
    }

    // ------------------------------------------------------------
    // Fetching, then how it ended
    // ------------------------------------------------------------
    if (phase === 'fetching') {
        fillPlan('secondary', b => paragraph(b,
            `Fetching ${count} file${count === 1 ? '' : 's'} (${formatBytes(bytes)})…`));
        return;
    }

    if (phase === 'cancelled') {
        clearPlan();
        showAlert('storeResult', 'Cancelled — nothing was fetched.', 'secondary');
        return;
    }

    if (phase === 'done') {
        clearPlan();

        // NOTHING TO FETCH MEANS NO ZIP EXISTS, and this fires AFTER the plan
        // has already explained why. Falling through would say "a zip with 0
        // files" and then tell the developer to unzip it — sending them to
        // their downloads folder for a file that was never made.
        if (summary.written === 0 && summary.failed === 0) {
            showAlert(
                'storeResult',
                `${assetName}: you already have every file in this version. Nothing was fetched.`,
                'success'
            );
            return;
        }

        // A ZIP RATHER THAN FILES WRITTEN, because that is what happens: the
        // browser downloads it and the developer unzips it over the folder they
        // chose. Saying "written" would be a lie the first time they looked in
        // the folder and found nothing.
        const bits = [
            `a zip with ${summary.written} file${summary.written === 1 ? '' : 's'}`
        ];

        if (summary.kept) bits.push(`${summary.kept} you already had, left out`);
        if (summary.replaced) bits.push(`${summary.replaced} to be replaced`);
        if (summary.failed) bits.push(`${summary.failed} FAILED — see the console`);

        showAlert(
            'storeResult',
            `${assetName}: ${bits.join(', ')}. ` +
            'Unzip it into the folder you chose and the version is complete.',
            summary.failed ? 'warning' : 'success'
        );
    }
}

// ============================================================
// WHY THIS CALLS SOMETHING THAT TALKS BACK
// ============================================================
//
// `downloadVersion` reports every stage and WAITS at two of them, and
// reportToPage answers both. The first is the explanation and the button that
// opens the folder chooser — which cannot be a dialog, because a file chooser
// may only be shown while the page still holds the activation from the click
// that started it, and a modal spends it. Doing it with a `window.confirm()`
// here stopped the download dead, silently, with
//
//     File chooser dialog can only be shown with a user activation.
//
// in the console and nothing at all on the screen. The explanation is ordinary
// page content instead, and the chooser is opened by a second, fresh click.
//
// THE SECOND IS THE DECISION: the list of what would be fetched, and the chance
// to stop it. Nothing crosses the wire until the developer has seen it.
async function downloadAsset(assetId, versionId, name, button) {
    showAlert('storeAlert', '');
    showAlert('storeResult', '');
    clearPlan();

    button.disabled = true;
    const original = button.innerHTML;
    button.textContent = 'Downloading…';

    try {
        await downloadVersion({
            assetId,
            versionId,
            assetName: name,
            fetchJson,
            onReport: reportToPage
        });

        // The history has a new entry, so the page reloads what it knows.
        await load();

    } catch (err) {
        console.error('Could not download:', err);
        showAlert('storeAlert', err.message, 'danger');

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
