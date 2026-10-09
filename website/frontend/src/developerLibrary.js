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
// A LIBRARY IS ONLY USEFUL IF THINGS CAN BE FOUND AGAIN
// ============================================================
//
// A folder of reference photographs arrives as IMG_4823, IMG_4824, IMG_4825, and
// a pile of those is not a library — it is a pile. So an item carries a NAME, a
// NOTE and TAGS, and the search reads all three. That is item 54's labelling
// step and its content search, which item 57 says are this space's own job.
//
// THE TAGS ARE NORMALISED AS YOU TYPE and the preview shows it, because the
// failure mode is silent: "Trees" and "trees" are the same word to a person and
// two words to a search, so the item is filed and then never found.
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
// The rule for which items a search is asking for, kept separate because it is
// the part that is worth testing on its own — see that file.
import { filterLibrary } from './libraryFilter.mjs';

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

// Which tags are switched on. A Set, because the questions asked of it are
// "is this on" and "how many are on", and because a tag cannot be on twice.
let selectedTags = new Set();

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

    // Tags as Bootstrap badges. Wrapped, because there is no telling how many
    // somebody will use, and a tile that grows is better than one that hides
    // what it holds.
    if (item.tags?.length) {
        const tags = document.createElement('div');
        tags.className = 'd-flex flex-wrap gap-1';

        for (const tag of item.tags) {
            const badge = document.createElement('span');
            badge.className = 'badge text-bg-secondary fw-normal';
            badge.textContent = tag;
            tags.appendChild(badge);
        }

        body.appendChild(tags);
    }

    const actions = document.createElement('div');
    // mt-auto keeps the button on the bottom edge whatever the tile contains.
    actions.className = 'mt-auto pt-1';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-sm btn-outline-secondary py-0 px-2 me-1';
    edit.dataset.edit = String(item.id);
    edit.textContent = 'Edit';
    actions.appendChild(edit);

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

// Every tag in the library, with how many items carry it.
function tagCounts() {
    const counts = new Map();

    for (const item of allItems) {
        for (const tag of item.tags || []) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }

    return counts;
}

// ------------------------------------------------------------
// The tag filter
// ------------------------------------------------------------
//
// BUTTONS RATHER THAN BADGES, and the distinction is deliberate: a badge on a
// tile is a LABEL, and this is a CONTROL. They look different because they do
// different things.
//
// MOST-USED FIRST, then alphabetical. A library's tags are not equally useful —
// the word on forty items is the one somebody wants — and alphabetical alone
// buries it behind whatever starts with 'a'.

function renderTagFilter() {
    const box = $('libraryTagFilter');
    if (!box) return;

    box.textContent = '';

    const counts = tagCounts();

    // Nothing tagged yet. An empty row with a heading would read as a fault.
    if (counts.size === 0) return;

    const sorted = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );

    const row = document.createElement('div');
    row.className = 'd-flex flex-wrap align-items-center gap-1';

    const label = document.createElement('span');
    label.className = 'small text-secondary me-1';
    label.textContent = 'Filter:';
    row.appendChild(label);

    for (const [tag, count] of sorted) {
        const on = selectedTags.has(tag);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = on
            ? 'btn btn-sm btn-primary py-0 px-2'
            : 'btn btn-sm btn-outline-secondary py-0 px-2';

        // aria-pressed is what makes a toggle a toggle to a screen reader. The
        // colour alone is not a state anybody can hear.
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.dataset.tag = tag;
        button.title = on
            ? `Stop filtering by ${tag}`
            : `Show only what is tagged ${tag}`;
        button.textContent = `${tag} (${count})`;
        row.appendChild(button);
    }

    if (selectedTags.size > 0) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn btn-sm btn-link py-0 px-2 text-secondary';
        clear.dataset.clearTags = '1';
        clear.textContent = 'Clear';
        row.appendChild(clear);
    }

    box.appendChild(row);
}

function toggleTag(tag) {
    if (selectedTags.has(tag)) {
        selectedTags.delete(tag);
    } else {
        selectedTags.add(tag);
    }

    render();
}

function render() {
    const grid = $('libraryGrid');
    if (!grid) return;

    const needle = query.trim().toLowerCase();

    // The rule lives in libraryFilter.mjs, where it can be tested by calling it.
    const shown = filterLibrary(allItems, { query, tags: selectedTags });

    renderTagFilter();

    grid.innerHTML = '';
    grid.className = '';

    // The count has to say WHY it is showing fewer, or a filter that is on
    // looks like a library that has lost things.
    const count = $('libraryCount');

    if (count) {
        if (allItems.length === 0) {
            count.textContent = '';
        } else {
            const filteredBy = [
                needle ? 'the search' : null,
                selectedTags.size > 0
                    ? `${selectedTags.size} tag${selectedTags.size === 1 ? '' : 's'}`
                    : null,
            ].filter(Boolean);

            count.textContent = filteredBy.length === 0
                ? `${allItems.length} item${allItems.length === 1 ? '' : 's'}`
                : `${shown.length} of ${allItems.length} — by ${filteredBy.join(' and ')}`;
        }
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

        // Say WHICH filter emptied it. "Nothing matches" when the search box is
        // empty reads as a broken page rather than as a filter doing its job.
        const by = [
            query.trim() ? `"${query.trim()}"` : null,
            selectedTags.size > 0 ? [...selectedTags].join(' + ') : null,
        ].filter(Boolean);

        grid.textContent = `Nothing here is tagged ${by.join(' and ')}.`;
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

        // A tag can stop existing — its last item was removed, or relabelled.
        // Left selected it would filter everything away and look like an empty
        // library rather than a stale filter, so it is dropped on reload.
        const live = tagCounts();

        for (const tag of [...selectedTags]) {
            if (!live.has(tag)) selectedTags.delete(tag);
        }

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
// Labelling — the name, the note, and what it shows
// ------------------------------------------------------------

let editingId = null;

// The SAME normalisation the server applies, so the preview is what will be
// stored rather than a guess at it. Duplicated deliberately and narrowly: the
// server is the authority, and this exists only to show the person what it will
// do before they commit to it.
function parseTags() {
    const input = $('libraryEditTags');
    if (!input) return [];

    return [...new Set(
        input.value
            .split(',')
            .map(tag => tag.trim().toLowerCase().replace(/\s+/g, ' '))
            .filter(Boolean)
    )];
}

function renderTagPreview() {
    const box = $('libraryEditTagPreview');
    if (!box) return;

    box.textContent = '';

    const tags = parseTags();

    if (tags.length === 0) return;

    const label = document.createElement('div');
    label.className = 'small text-secondary mb-1';
    label.textContent = tags.length === 1
        ? 'Filed under:'
        : `Filed under ${tags.length} words:`;
    box.appendChild(label);

    const row = document.createElement('div');
    row.className = 'd-flex flex-wrap gap-1';

    for (const tag of tags) {
        const badge = document.createElement('span');
        badge.className = 'badge text-bg-secondary fw-normal';
        badge.textContent = tag;
        row.appendChild(badge);
    }

    box.appendChild(row);
}

function openEdit(item) {
    editingId = item.id;

    const title = $('libraryEditTitle');
    if (title) title.textContent = item.display_name || 'Edit item';

    const name = $('libraryEditName');
    if (name) name.value = item.display_name || '';

    const note = $('libraryEditNote');
    if (note) note.value = item.note || '';

    const tags = $('libraryEditTags');
    if (tags) tags.value = (item.tags || []).join(', ');

    // The picture, so it is obvious WHICH one is being named. A grid of
    // IMG_48xx is exactly the case this dialog exists for.
    const thumb = $('libraryEditThumb');

    if (thumb) {
        if (item.thumbnail_kind) {
            thumb.src = `${API}/${item.id}/thumbnail`;
            thumb.classList.remove('d-none');
        } else {
            thumb.removeAttribute('src');
            thumb.classList.add('d-none');
        }
    }

    showAlert('libraryEditAlert', '');
    renderTagPreview();

    window.bootstrap?.Modal.getOrCreateInstance($('libraryEditModal'))?.show();
}

async function saveEdit() {
    if (editingId === null) return;

    const nameInput = $('libraryEditName');
    const displayName = String(nameInput?.value || '').trim();

    // The server refuses this too. Checked here as well so the person is told
    // in the dialog they are looking at rather than by an alert behind it.
    if (!displayName) {
        showAlert('libraryEditAlert', 'An item needs a name.', 'danger');
        nameInput?.focus();
        return;
    }

    const button = $('libraryEditSave');

    if (button) button.disabled = true;

    try {
        const response = await apiFetch(`${API}/${editingId}/update`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                display_name: displayName,
                note: String($('libraryEditNote')?.value || '').trim(),
                tags: parseTags(),
            }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not save those changes.');
        }

        window.bootstrap?.Modal.getOrCreateInstance($('libraryEditModal'))?.hide();

        editingId = null;

        await load();

    } catch (err) {
        showAlert('libraryEditAlert', err.message, 'danger');

    } finally {
        if (button) button.disabled = false;
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
    const tagsInput = $('libraryEditTags');
    tagsInput?.addEventListener('input', renderTagPreview);

    $('libraryEditSave')?.addEventListener('click', saveEdit);

    // One delegated listener for the filter row, like the grid's — the row is
    // rebuilt on every render, so per-button listeners would be re-attached
    // endlessly.
    $('libraryTagFilter')?.addEventListener('click', (event) => {
        if (event.target.closest('[data-clear-tags]')) {
            selectedTags.clear();
            render();
            return;
        }

        const button = event.target.closest('button[data-tag]');
        if (!button) return;

        toggleTag(button.dataset.tag);
    });

    // Save on Enter in the name field — it is a one-line field and the dialog
    // has exactly one obvious action.
    $('libraryEditName')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveEdit();
        }
    });

    grid?.addEventListener('click', (event) => {
        const editButton = event.target.closest('button[data-edit]');

        if (editButton) {
            const item = allItems.find(i => i.id === Number(editButton.dataset.edit));
            if (item) openEdit(item);
            return;
        }

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
