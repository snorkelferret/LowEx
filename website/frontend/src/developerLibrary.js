// frontend/src/developerLibrary.js
//
// The Library tab: source material, shared with the studio.
//
// ============================================================
// THE ONE THING THIS PAGE HAS TO TEACH
// ============================================================
//
// An image is not a game asset (TODO 57, 58). It lives HERE, in a library the
// whole studio can see, and it reaches the game only by being PART of an asset
// somebody builds. So the page says that where the material is, rather than
// leaving a developer to discover it by uploading a folder of photographs and
// watching them head for a review queue.
//
// ============================================================
// NO DUPLICATES IS A FEATURE, NOT AN ERROR
// ============================================================
//
// Uploading something already in the library is NOT a failure and is not
// presented as one. The content is addressed by hash, so the same bytes ARE the
// same file, and the honest answer is "this is already here" — with the existing
// item named. The server decides this; this file only reports what it said.
//
// ============================================================
// AND A THUMBNAIL THAT IS MISSING IS NOT AN ERROR
// ============================================================
//
// Only images have thumbnails. Everything else gets an icon showing its type,
// which is information rather than a gap — a PDF should not look broken for not
// being a photograph.

import { $ } from './utils.js';
import { apiFetch } from './api.js';
import { formatBytes } from '../../shared/formatBytes.mjs';

const API = '/api/library';

// What is shown when there is no thumbnail. Chosen by TYPE, because that is
// what a person is looking for in a grid — "which of these is the PDF".
const ICONS = {
    Image: 'bi-file-earmark-image',
    Video: 'bi-file-earmark-play',
    Audio: 'bi-file-earmark-music',
    Document: 'bi-file-earmark-text',
    Archive: 'bi-file-earmark-zip',
    Font: 'bi-file-earmark-font',
    Code: 'bi-file-earmark-code',
    '3D model': 'bi-box',
};

let allItems = [];
let query = '';

function showAlert(boxId, message, variant) {
    const box = $(boxId);
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    // `result` is a success box and `alert` a failure one, so the class is set
    // rather than assumed — an error shown in a green box is worse than no box.
    box.className = `alert alert-${variant} py-2 px-3 small`;
    box.textContent = message;
}

function clearMessages() {
    showAlert('libraryAlert', '');
    showAlert('libraryResult', '');
}

// SQLite gives 'YYYY-MM-DD HH:MM:SS' in UTC, and Safari reads that as an
// Invalid Date without the T and the Z. Same helper the other panels use.
function formatWhen(value) {
    if (!value) return '';

    const parsed = new Date(String(value).replace(' ', 'T') + 'Z');

    if (Number.isNaN(parsed.getTime())) return String(value);

    return parsed.toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// One item
// ------------------------------------------------------------

function tile(item) {
    // CANONICAL BOOTSTRAP THROUGHOUT, with a custom class only where Bootstrap
    // has nothing to offer. `card` already gives the surface, the border and the
    // radius; `overflow-hidden` clips the image to it. See the theme note at the
    // top of frontend/styles/styles.css.
    const card = document.createElement('div');
    card.className = 'card h-100 overflow-hidden';

    // aspect-ratio is the one thing here Bootstrap cannot express.
    const frame = document.createElement('div');
    frame.className =
        'library-tile-frame d-flex align-items-center justify-content-center';

    if (item.thumbnail_kind) {
        const img = document.createElement('img');
        img.className = 'w-100 h-100 object-fit-cover';
        img.loading = 'lazy';
        img.alt = '';
        img.src = `${API}/${item.id}/thumbnail`;
        frame.appendChild(img);
    } else {
        const icon = document.createElement('i');
        icon.className =
            `bi ${ICONS[item.asset_type] || 'bi-file-earmark'} fs-1 text-secondary`;
        icon.setAttribute('aria-hidden', 'true');
        frame.appendChild(icon);
    }

    card.appendChild(frame);

    const body = document.createElement('div');
    body.className = 'card-body p-2 d-flex flex-column gap-1';

    // The name is the download. textContent throughout: a filename is something
    // a person wrote, and a filename with a quote in it is a filename.
    const name = document.createElement('a');
    // The clamp is custom; everything else is Bootstrap.
    name.className = 'library-tile-name small fw-medium';
    name.href = `${API}/${item.id}/content`;
    name.textContent = item.display_name;
    name.title = item.display_name;
    body.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'small text-secondary';
    meta.textContent = [
        item.asset_type || 'File',
        formatBytes(item.file_size),
        formatWhen(item.created_at),
    ].filter(Boolean).join(' · ');
    body.appendChild(meta);

    // A contradiction is worth showing and is NOT a refusal: a JPEG named .png
    // is still a picture, and the library says so rather than hiding it.
    if (item.content_state === 'contradicted') {
        const warn = document.createElement('div');
        warn.className = 'small text-warning-emphasis';
        warn.textContent = 'Contents do not match the name';
        body.appendChild(warn);
    }

    if (item.note) {
        const note = document.createElement('div');
        note.className = 'small text-secondary';
        note.textContent = item.note;
        body.appendChild(note);
    }

    const actions = document.createElement('div');
    // mt-auto keeps the button on the bottom edge whatever the tile contains.
    actions.className = 'mt-auto pt-1';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-sm btn-outline-danger py-0 px-2';
    remove.dataset.remove = String(item.id);
    remove.dataset.name = item.display_name;
    remove.textContent = 'Remove';
    actions.appendChild(remove);

    body.appendChild(actions);
    card.appendChild(body);

    return card;
}

function render() {
    const grid = $('libraryGrid');
    if (!grid) return;

    const needle = query.trim().toLowerCase();
    const shown = needle
        ? allItems.filter(item =>
            String(item.display_name || '').toLowerCase().includes(needle))
        : allItems;

    grid.innerHTML = '';
    grid.className = '';

    const count = $('libraryCount');
    if (count) {
        count.textContent = allItems.length === 0
            ? ''
            : `${shown.length} of ${allItems.length} item${allItems.length === 1 ? '' : 's'}`;
    }

    if (allItems.length === 0) {
        grid.className = 'text-secondary';
        grid.textContent =
            'The library is empty. Add reference material, textures, scans — ' +
            'anything the studio might draw on.';
        return;
    }

    if (shown.length === 0) {
        grid.className = 'text-secondary';
        grid.textContent = `Nothing matches "${query.trim()}".`;
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'library-grid';

    for (const item of shown) wrap.appendChild(tile(item));

    grid.appendChild(wrap);
}

// ------------------------------------------------------------
// Loading
// ------------------------------------------------------------

async function load() {
    const grid = $('libraryGrid');
    if (!grid) return;

    try {
        const response = await apiFetch(API, { credentials: 'include' });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load the library.');
        }

        allItems = data.items || [];
        render();

    } catch (err) {
        console.error('Could not load the library:', err.message);

        grid.className = 'text-secondary';
        grid.textContent = '';
        showAlert('libraryAlert', err.message, 'danger');
    }
}

// ------------------------------------------------------------
// Adding
// ------------------------------------------------------------

function chosenFiles() {
    const input = $('libraryFileInput');
    return input?.files ? Array.from(input.files) : [];
}

function onChoose() {
    const files = chosenFiles();
    const label = $('libraryChosen');
    const button = $('libraryUploadBtn');

    if (label) {
        label.textContent = files.length === 0
            ? 'No files chosen'
            : `${files.length} file${files.length === 1 ? '' : 's'} chosen`;
    }

    if (button) button.disabled = files.length === 0;
}

async function onUpload() {
    const files = chosenFiles();
    if (files.length === 0) return;

    const button = $('libraryUploadBtn');
    clearMessages();

    if (button) {
        button.disabled = true;
        button.textContent = 'Adding...';
    }

    try {
        const form = new FormData();
        for (const file of files) form.append('files', file);

        const response = await apiFetch(`${API}/upload`, {
            method: 'POST',
            credentials: 'include',
            body: form,
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            // A refusal is per file and carries a reason. It is reported rather
            // than swallowed, because "why did that not go in" is the whole
            // question a person has.
            const refused = (data.refused || [])
                .map(r => `${r.filename}: ${r.reason}`)
                .join(' ');

            throw new Error([data.error, refused].filter(Boolean).join(' ') ||
                'Could not add those files.');
        }

        // What happened is THREE things, and they are not the same outcome:
        // added, already here, and refused. Saying only "done" would hide both
        // of the interesting ones.
        const parts = [];

        if (data.added?.length) {
            parts.push(`${data.added.length} added`);
        }

        if (data.existing?.length) {
            const names = data.existing.map(e => e.display_name).join(', ');
            parts.push(`${data.existing.length} already in the library (${names})`);
        }

        if (data.refused?.length) {
            const reasons = data.refused.map(r => `${r.filename}: ${r.reason}`).join(' ');
            parts.push(`${data.refused.length} refused — ${reasons}`);
        }

        if (parts.length) {
            showAlert('libraryResult', parts.join('. '), 'success');
        }

        // The picker is emptied so the same files cannot be sent twice by
        // pressing the button again, which is the mistake the button invites.
        const input = $('libraryFileInput');
        if (input) input.value = '';
        onChoose();

        await load();

    } catch (err) {
        showAlert('libraryAlert', err.message, 'danger');

    } finally {
        if (button) {
            button.textContent = 'Add to the library';
            button.disabled = chosenFiles().length === 0;
        }
    }
}

// ------------------------------------------------------------
// Removing
// ------------------------------------------------------------

async function onRemove(id) {
    clearMessages();

    try {
        const response = await apiFetch(`${API}/${id}/remove`, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not remove it.');
        }

        // Reloaded from the server rather than removed locally: the server is
        // what knows whether it moved.
        await load();

    } catch (err) {
        showAlert('libraryAlert', err.message, 'danger');
    }
}

// ------------------------------------------------------------
// Wiring
// ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    // Only present on the developer dashboard.
    if (!$('libraryGrid')) return;

    const input = $('libraryFileInput');
    const selectBtn = $('librarySelectBtn');
    const uploadBtn = $('libraryUploadBtn');
    const search = $('librarySearch');
    const grid = $('libraryGrid');

    selectBtn?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', onChoose);
    uploadBtn?.addEventListener('click', onUpload);

    search?.addEventListener('input', () => {
        query = search.value;
        render();
    });

    // One delegated listener for the whole grid, so a reload cannot leave
    // listeners attached to tiles that no longer exist.
    grid?.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-remove]');
        if (!button) return;

        const name = button.dataset.name;

        if (!window.confirm(
            `Remove "${name}" from the library?\n\n` +
            'It stops being listed and the studio stops seeing it. The file ' +
            'itself is only freed once nothing else is using it.'
        )) {
            return;
        }

        onRemove(Number(button.dataset.remove));
    });

    load();
});
