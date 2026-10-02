// frontend/src/developerWorkspace.js

// The same rules the server uses. shared/ is the one copy.
import {
    isBackupFile,
    ASSET_CATEGORIES,
    normaliseCategory,
} from '../../shared/assetRules.mjs';
import { $, escapeHtml, formatFileSize } from './utils.js';

const API_URL = '/api/developer/workspace';

// The sentinel for the free-text escape hatch. A value starting with "__" is
// never a real category, so it cannot collide with one someone types.
const OTHER_CATEGORY = '__other__';

// Builds the category select from the shared list rather than writing the
// options into the HTML, so the choices and the rule that validates them cannot
// drift apart.
function fillCategoryOptions() {
    const select = $('assetCategory');
    if (!select) return;

    const options = [
        '<option value="">Not set</option>',
        ...ASSET_CATEGORIES.map(
            c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`
        ),
        `<option value="${OTHER_CATEGORY}">Other…</option>`,
    ];

    select.innerHTML = options.join('');

    // "Other…" is a dead end without a box to type in, so reveal one.
    select.addEventListener('change', () => {
        const other = $('assetCategoryOther');
        if (!other) return;

        const isOther = select.value === OTHER_CATEGORY;
        other.classList.toggle('d-none', !isOther);

        if (isOther) {
            other.focus();
        } else {
            other.value = '';
        }
    });
}

// What the developer actually chose, whichever of the two controls holds it.
function readCategory() {
    const select = $('assetCategory');
    if (!select) return '';

    if (select.value === OTHER_CATEGORY) {
        return ($('assetCategoryOther')?.value || '').trim();
    }

    return select.value;
}

// Shows a stored category in the controls.
//
// A value that is NOT in the list is shown in the "Other…" box rather than
// being dropped — the column is free text, and an admin can set something the
// list does not contain. Rendering that as blank would look like the category
// had been lost.
function setCategoryValue(value) {
    const select = $('assetCategory');
    const other = $('assetCategoryOther');
    if (!select || !other) return;

    const wanted = String(value ?? '').trim();

    if (!wanted) {
        select.value = '';
        other.value = '';
        other.classList.add('d-none');
        return;
    }

    // normaliseCategory maps a known category to its canonical spelling and
    // passes anything else through unchanged, so matching on its result finds
    // the option the server would have stored.
    const canonical = normaliseCategory(wanted);

    if (ASSET_CATEGORIES.includes(canonical)) {
        select.value = canonical;
        other.value = '';
        other.classList.add('d-none');
        return;
    }

    select.value = OTHER_CATEGORY;
    other.value = wanted;
    other.classList.remove('d-none');
}


// ============================================================
// Upload state
// ============================================================

let selectedFiles = [];

// Backups dropped from the current selection. Shown in the preview so the
// file count is not mysteriously smaller than what was selected.
let skippedBackupCount = 0;


// ============================================================
// DOM helpers
// ============================================================

// $, escapeHtml and formatFileSize come from ./utils.js. They were defined here
// as well as in three other client files — identical, but only by luck.


// ============================================================
// Initialisation
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

    fillCategoryOptions();
    initialiseUploadUI();
    initialiseHistoryTab();
    initialiseBinTab();
    loadDeveloperWorkspace();

});


// ============================================================
// Upload UI
// ============================================================

function initialiseUploadUI() {

    const selectFilesBtn =
        $('selectFilesBtn');

    const selectDirectoryBtn =
        $('selectDirectoryBtn');

    const fileInput =
        $('fileInput');

    const directoryInput =
        $('directoryInput');


    selectFilesBtn?.addEventListener(
        'click',
        () => fileInput?.click()
    );


    selectDirectoryBtn?.addEventListener(
        'click',
        () => directoryInput?.click()
    );


    fileInput?.addEventListener(
        'change',
        event => {

            addSelectedFiles(
                Array.from(event.target.files)
            );

            event.target.value = '';
        }
    );


    directoryInput?.addEventListener(
        'change',
        event => {

            addSelectedFiles(
                Array.from(event.target.files)
            );

            event.target.value = '';
        }
    );


    $('clearUploadBtn')?.addEventListener(
        'click',
        clearUpload
    );


    $('uploadAssetBtn')?.addEventListener(
        'click',
        uploadAsset
    );


    $('enablePathOverride')?.addEventListener(
        'change',
        updatePathOverrideState
    );


    $('globalPathOverride')?.addEventListener(
        'input',
        renderUploadPreview
    );
}


// ============================================================
// Add files
// ============================================================

// ---------------------------------------------------------------------------
// Backup files
//
// Dropped BEFORE upload, so they are never transferred and never stored. This
// is not tidiness: Blender's .blend1 is a FULL COPY of the .blend beside it, so
// on a 500 MB asset it is half a gigabyte of upload for nothing.
//
// isBackupFile() comes from shared/assetRules.mjs — the SAME function the
// server uses. It used to be written twice, once per side, with a test
// asserting the copies agreed; a test that catches divergence is a poor
// substitute for not having two copies to diverge.
// ---------------------------------------------------------------------------



function addSelectedFiles(files) {

    skippedBackupCount = 0;

    for (const file of files) {

        const relativePath =
            file.webkitRelativePath ||
            file.name;


        // A backup is not an asset. Counted rather than silently ignored, so
        // the preview can say why it is not in the list.
        if (isBackupFile(relativePath)) {
            skippedBackupCount++;
            continue;
        }


        selectedFiles.push({
            file,
            originalPath: relativePath,
            filename: getFilename(relativePath),
            relativePath: getDirectory(relativePath)
        });
    }


    renderUploadPreview();

    // Ask the server what this selection would be called. The rules are
    // server-side, so this is a request rather than a local calculation — the
    // display then cannot disagree with what the upload will actually do.
    checkUploadName();
}


// ============================================================
// Path helpers
// ============================================================

function normalisePath(value) {

    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/')
        .replace(/^\.\//, '');
}


function getFilename(filePath) {

    const path =
        normalisePath(filePath);

    const parts =
        path.split('/');

    return parts[parts.length - 1];
}


function getDirectory(filePath) {

    const path =
        normalisePath(filePath);

    const parts =
        path.split('/');

    parts.pop();

    return parts.join('/');
}


// ============================================================
// Render preview
// ============================================================

// ---------------------------------------------------------------------------
// Asset name
//
// NOT typed. It comes from the FOLDER the developer uploads: bigTree_v04 is
// asset "bigTree", and the _v04 is their own labelling rather than the
// system's version. The system's upload version is a separate per-asset
// counter, shown as housekeeping in the version list.
//
// The rules live on the SERVER, so this asks rather than carrying its own copy
// of the regex. One source of truth, and this display cannot disagree with what
// the upload will actually do.
//
// Two modes, decided by the server's machine-readable code rather than by
// matching on wording:
//
//   derived  a folder was selected, so the server names the asset
//   pick     files with no folder — nothing to derive, so the developer
//            chooses an existing asset or names a new one
// ---------------------------------------------------------------------------

let nameCheck = null;      // last preflight response
let pickMode = false;      // this selection has no folder to take a name from
let assetChoice = '';      // explicit choice: a picked asset, a new name, or a
                           // near-match confirmation

// Existing asset name -> its category, from the last workspace load.
//
// Used to PREFILL the category when the developer picks an existing asset, so
// uploading a new version of a categorised asset does not present a blank field
// that looks like the category was lost. It is a convenience only: the server
// COALESCEs, so a blank field leaves the stored value alone either way.
const assetCategories = new Map();

function resetNameState() {
    nameCheck = null;
    pickMode = false;
    assetChoice = '';
}

async function checkUploadName() {
    if (selectedFiles.length === 0) {
        resetNameState();
        renderAssetNameArea();
        return;
    }

    const body = {
        file_paths: selectedFiles.map(item => item.originalPath)
    };

    // In pick mode there is no folder to derive from, so the developer's
    // choice IS the name — the server validates it exactly as it would a
    // folder name, which is why it goes through the same endpoint.
    if (pickMode && assetChoice) {
        body.upload_name = assetChoice;
    }

    try {
        const response = await fetch(`${API_URL}/assets/check-name`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
        });

        const result = await response.json();

        // The check made with no explicit name is what tells us there is no
        // folder. Once known, pickMode stays for this selection: after the
        // developer chooses, the server has a name and would no longer report
        // 'no_name', and the mode must not flip back.
        if (!pickMode && result.code === 'no_name') {
            pickMode = true;
        }

        nameCheck = result;

    } catch (err) {
        console.error('Upload name check failed:', err);
        nameCheck = null;
    }

    renderAssetNameArea();
}

function renderAssetNameArea() {
    const area = $('assetNameArea');

    if (!area) return;

    area.textContent = '';

    const hint = (text) => {
        const el = document.createElement('div');
        el.className = 'form-text';
        el.textContent = text;
        return el;
    };

    const label = (text, forId) => {
        const el = document.createElement('label');
        el.className = 'form-label';
        if (forId) el.setAttribute('for', forId);
        el.textContent = text;
        return el;
    };

    if (selectedFiles.length === 0) {
        area.appendChild(label('Asset name'));
        area.appendChild(hint('Select a folder — its name becomes the asset name.'));
        return;
    }

    if (!nameCheck) {
        area.appendChild(label('Asset name'));
        area.appendChild(hint('Checking…'));
        return;
    }

    // Nothing to derive, so the developer picks.
    if (pickMode) {
        renderAssetPicker(area, label);
    } else {
        renderDerivedName(area, label);
    }

    // Shared by both modes.

    // The near-match question. Parsing is fuzzy, and a forgotten capital or
    // underscore is exactly when a developer does NOT mean to create a new
    // asset, so ask rather than decide.
    if (nameCheck.match.tier === 'near') {
        area.appendChild(
            renderNearMatchPrompt(nameCheck, assetChoice, (choice) => {
                assetChoice = choice;
                renderAssetNameArea();
            })
        );
    }

    // Blocking and warning verdicts, explained rather than merely refused.
    // 'no_name' is excluded because the picker already says it, in context.
    if (nameCheck.verdict !== 'ok' &&
        nameCheck.reason &&
        nameCheck.code !== 'no_name') {
        const notice = document.createElement('div');
        notice.className = nameCheck.verdict === 'block'
            ? 'alert alert-danger mt-2 mb-0 py-2 small'
            : 'alert alert-warning mt-2 mb-0 py-2 small';
        notice.textContent = nameCheck.reason;
        area.appendChild(notice);
    }
}

// The common case: a folder was selected, so the server named the asset.
function renderDerivedName(area, label) {
    area.appendChild(label('Asset name'));

    const value = document.createElement('div');
    value.className = 'form-control bg-dark text-light border-secondary';
    value.textContent = nameCheck.asset_name || '—';
    area.appendChild(value);

    // Where it came from, so the derivation is visible rather than magic.
    const from = document.createElement('div');
    from.className = 'form-text';
    from.textContent =
        `From the folder "${nameCheck.upload_name}"` +
        (nameCheck.version_marker ? ` (your marker: ${nameCheck.version_marker})` : '');
    area.appendChild(from);

    // What the upload will do.
    const outcome = document.createElement('div');
    outcome.className = 'small mt-2';
    outcome.textContent = nameCheck.match.tier === 'exact'
        ? `Adds to your existing asset "${nameCheck.match.matched_name}" ` +
          `as upload v${nameCheck.next_upload_version}.`
        : `Creates a new asset as upload v${nameCheck.next_upload_version}.`;

    area.appendChild(outcome);
}

function renderNearMatchPrompt(check, current, onChoose) {
    const wrapper = document.createElement('div');
    wrapper.className = 'alert alert-warning mt-2 mb-0 py-2 small';

    const question = document.createElement('div');
    question.className = 'mb-2';
    question.textContent =
        `"${check.upload_name}" is not an exact match for "${check.match.matched_name}". ` +
        `Which did you mean?`;
    wrapper.appendChild(question);

    for (const option of [check.match.matched_name, check.asset_name]) {
        const id = `near-${option.replace(/[^A-Za-z0-9]/g, '-')}`;

        const row = document.createElement('div');
        row.className = 'form-check';

        const radio = document.createElement('input');
        radio.className = 'form-check-input';
        radio.type = 'radio';
        radio.name = 'nearMatchChoice';
        radio.id = id;
        radio.checked = current === option;
        radio.addEventListener('change', () => onChoose(option));

        const optionLabel = document.createElement('label');
        optionLabel.className = 'form-check-label';
        optionLabel.setAttribute('for', id);
        optionLabel.textContent =
            option === check.match.matched_name
                ? `${option} — the existing asset`
                : `${option} — a new asset`;

        row.appendChild(radio);
        row.appendChild(optionLabel);
        wrapper.appendChild(row);
    }

    return wrapper;
}

// Shows the category the chosen asset already has.
//
// Only ever FILLS a blank field — it will not overwrite something the developer
// has typed. Switching the picker between assets should not silently discard a
// category they just entered.
function prefillCategory(name) {
    // Only fills a blank field — it will not overwrite something the developer
    // has already entered.
    if (readCategory()) return;

    setCategoryValue(assetCategories.get(name) || '');
}

function renderAssetPicker(area, label) {
    area.appendChild(label('Asset', 'pickAssetSelect'));

    const select = document.createElement('select');
    select.className = 'form-select';
    select.id = 'pickAssetSelect';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Select an asset…';
    select.appendChild(none);

    for (const name of nameCheck.existing_asset_names || []) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.selected = assetChoice === name;
        select.appendChild(option);
    }

    const NEW = '__new__';

    // A choice that is not an existing asset is a new name. Recomputing this on
    // every render matters: the picker is rebuilt after each check, and without
    // it the developer's typed name would vanish the moment they tabbed away.
    const isExisting =
        (nameCheck.existing_asset_names || []).includes(assetChoice);
    const isNew = assetChoice !== '' && !isExisting;

    const newOption = document.createElement('option');
    newOption.value = NEW;
    newOption.textContent = '— new asset —';
    newOption.selected = isNew;
    select.appendChild(newOption);

    const newInput = document.createElement('input');
    newInput.type = 'text';
    newInput.className = 'form-control mt-2';
    newInput.placeholder = 'New asset name';
    newInput.autocomplete = 'off';
    newInput.value = isNew ? assetChoice : '';
    newInput.classList.toggle('d-none', !isNew);

    select.addEventListener('change', () => {
        const isNew = select.value === NEW;
        newInput.classList.toggle('d-none', !isNew);
        assetChoice = isNew ? newInput.value.trim() : select.value;
        prefillCategory(assetChoice);
        checkUploadName();
    });

    newInput.addEventListener('input', () => {
        assetChoice = newInput.value.trim();
    });

    newInput.addEventListener('change', () => checkUploadName());

    area.appendChild(select);
    area.appendChild(newInput);

    area.appendChild(Object.assign(document.createElement('div'), {
        className: 'form-text',
        textContent:
            'These files have no folder, so there is nothing to take a name ' +
            'from. Choose the asset they belong to, or name a new one.'
    }));
}

function renderUploadPreview() {

    const section =
        $('uploadPreviewSection');

    const body =
        $('uploadPreviewBody');

    const count =
        $('uploadFileCount');

    const uploadButton =
        $('uploadAssetBtn');


    if (!section || !body) {
        return;
    }


    body.innerHTML = '';


    if (selectedFiles.length === 0) {

        section.classList.add('d-none');

        if (uploadButton) {
            uploadButton.disabled = true;
        }

        updateUploadSizeSummary();

        return;
    }


    section.classList.remove('d-none');


    if (count) {
        count.textContent =
            `${selectedFiles.length} file` +
            (selectedFiles.length === 1 ? '' : 's');
    }

    updateUploadSizeSummary();


    const overrideEnabled =
        $('enablePathOverride')?.checked;

    const globalOverride =
        normalisePath(
            $('globalPathOverride')?.value
        );


    selectedFiles.forEach(
        (item, index) => {

            let destination =
                item.relativePath;


            if (
                overrideEnabled &&
                globalOverride
            ) {
                destination =
                    globalOverride;
            }


            const row =
                document.createElement('tr');


            // Original path
            const originalCell =
                document.createElement('td');

            originalCell.textContent =
                item.originalPath;


            // Filename
            const filenameCell =
                document.createElement('td');

            const filenameInput =
                document.createElement('input');

            filenameInput.type = 'text';
            filenameInput.className =
                'form-control form-control-sm';

            filenameInput.value =
                item.filename;

            filenameInput.addEventListener(
                'input',
                event => {

                    item.filename =
                        event.target.value;

                }
            );

            filenameCell.appendChild(
                filenameInput
            );


            // Destination
            const destinationCell =
                document.createElement('td');

            const destinationInput =
                document.createElement('input');

            destinationInput.type = 'text';
            destinationInput.className =
                'form-control form-control-sm';

            destinationInput.value =
                destination;

            destinationInput.disabled =
                Boolean(
                    overrideEnabled &&
                    globalOverride
                );

            destinationInput.addEventListener(
                'input',
                event => {

                    item.relativePath =
                        normalisePath(
                            event.target.value
                        );

                }
            );

            destinationCell.appendChild(
                destinationInput
            );


            // Size
            const sizeCell =
                document.createElement('td');

            sizeCell.className =
                'text-nowrap text-secondary';

            sizeCell.textContent =
                formatFileSize(
                    item.file.size
                );


            // Remove
            const removeCell =
                document.createElement('td');

            const removeButton =
                document.createElement('button');

            removeButton.type =
                'button';

            removeButton.className =
                'btn btn-sm btn-outline-danger';

            removeButton.innerHTML =
                '<i class="bi bi-x"></i>';

            removeButton.title =
                'Remove file';

            removeButton.addEventListener(
                'click',
                () => {

                    selectedFiles.splice(
                        index,
                        1
                    );

                    renderUploadPreview();
                }
            );

            removeCell.appendChild(
                removeButton
            );


            row.appendChild(originalCell);
            row.appendChild(filenameCell);
            row.appendChild(destinationCell);
            row.appendChild(sizeCell);
            row.appendChild(removeCell);

            body.appendChild(row);
        }
    );


    if (uploadButton) {
        uploadButton.disabled =
            selectedFiles.length === 0;
    }
}


// ============================================================
// Path override state
// ============================================================

function updatePathOverrideState() {

    const enabled =
        $('enablePathOverride')?.checked;

    const input =
        $('globalPathOverride');


    if (input) {
        input.disabled = !enabled;
    }


    renderUploadPreview();
}


// ============================================================
// Clear upload
// ============================================================

function clearUpload() {

    selectedFiles = [];
    skippedBackupCount = 0;

    // A new selection starts the naming over: the folder, and therefore the
    // asset and any choice made about it, are all different.
    resetNameState();

    $('uploadStatus').innerHTML = '';

    renderUploadPreview();
    renderAssetNameArea();
}


// ============================================================
// Upload
// ============================================================

async function uploadAsset() {

    if (selectedFiles.length === 0) {
        return;
    }


    const description =
        $('assetDescription')?.value.trim();

    const versionNote =
        $('versionNote')?.value.trim();


    // The asset name is not typed — the server derives it from the folder. So
    // the guard is on the name check, not on a form field.
    if (!nameCheck) {

        showUploadStatus(
            'Still working out what this upload should be called. Try again in a moment.',
            'warning'
        );

        return;
    }


    if (nameCheck.code === 'no_name' || nameCheck.verdict === 'block') {

        showUploadStatus(
            nameCheck.reason || 'That name cannot be used.',
            'danger'
        );

        $('pickAssetSelect')?.focus();

        return;
    }


    if (nameCheck.match.tier === 'near' && !assetChoice) {

        showUploadStatus(
            'Confirm whether this is a new asset or an existing one.',
            'danger'
        );

        return;
    }


    if (!versionNote) {

        showUploadStatus(
            'Version note is required.',
            'danger'
        );

        $('versionNote')?.focus();

        return;
    }


    const formData =
        new FormData();


    // The name is NOT sent in the normal case — the server derives it from the
    // folder, so sending one could only disagree with it. An explicit choice is
    // sent: in pick mode there is no folder, and a near-match confirmation is
    // the developer answering the question the server asked.
    if (pickMode) {
        formData.append('upload_name', assetChoice);
    } else if (nameCheck.match.tier === 'near') {
        formData.append('confirmed_asset_name', assetChoice);
    }

    // asset_type is NOT sent. That field asked the developer to choose between
    // content types and TOOLS, when the tool is a property of the file that a
    // verifier determines. The question worth asking a human is which part of
    // the game this belongs to, and that is what "category" is.
    //
    // Sent only when one was chosen. An empty value is not the same as "clear
    // it" — the server COALESCEs on update, so omitting it leaves an existing
    // category alone rather than wiping it on every subsequent upload into the
    // same asset.
    const category = readCategory();

    if (category) {
        formData.append('category', category);
    }

    formData.append(
        'description',
        description
    );

    formData.append(
        'version_note',
        versionNote
    );


    const filePaths = [];


    for (const item of selectedFiles) {

        formData.append(
            'files',
            item.file,
            item.file.name
        );


        let relativePath =
            normalisePath(
                item.relativePath
            );


        const overrideEnabled =
            $('enablePathOverride')?.checked;

        const globalOverride =
            normalisePath(
                $('globalPathOverride')?.value
            );


        if (
            overrideEnabled &&
            globalOverride
        ) {
            relativePath =
                globalOverride;
        }


        const filename =
            normalisePath(
                item.filename
            );


        filePaths.push(
            relativePath
                ? `${relativePath}/${filename}`
                : filename
        );
    }


    formData.append(
        'file_paths',
        JSON.stringify(filePaths)
    );


    // --------------------------------------------------------
    // Filename overrides
    // --------------------------------------------------------

    const filenameOverrides = {};


    selectedFiles.forEach(item => {

        if (
            item.filename !==
            getFilename(item.originalPath)
        ) {
            filenameOverrides[
                normalisePath(
                    item.originalPath
                )
            ] = item.filename;
        }
    });


    if (
        Object.keys(filenameOverrides).length
    ) {

        formData.append(
            'filename_overrides',
            JSON.stringify(
                filenameOverrides
            )
        );
    }


    // --------------------------------------------------------
    // UI state
    // --------------------------------------------------------

    const uploadButton =
        $('uploadAssetBtn');

    if (uploadButton) {
        uploadButton.disabled = true;
        uploadButton.innerHTML =
            '<span class="spinner-border spinner-border-sm me-1"></span> Uploading...';
    }


    showUploadStatus(
        'Uploading asset...',
        'info'
    );


    try {

        const response =
            await fetch(
                `${API_URL}/upload`,
                {
                    method: 'POST',
                    credentials: 'include',
                    body: formData
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.error ||
                'Upload failed'
            );
        }


        showUploadStatus(
            `Asset uploaded successfully — version ${data.version.version_number}.`,
            'success'
        );


        clearUpload();


        await loadDeveloperWorkspace();


    } catch (err) {

        console.error(
            'Developer asset upload failed:',
            err
        );


        showUploadStatus(
            err.message ||
            'Upload failed.',
            'danger'
        );

    } finally {

        if (uploadButton) {

            uploadButton.disabled =
                selectedFiles.length === 0;

            uploadButton.innerHTML =
                '<i class="bi bi-cloud-upload"></i> Upload Asset';
        }
    }
}


// ============================================================
// Status
// ============================================================

function showUploadStatus(
    message,
    type
) {

    const status =
        $('uploadStatus');

    if (!status) {
        return;
    }


    status.innerHTML = `
        <div class="alert alert-${type}" role="alert">
            ${escapeHtml(message)}
        </div>
    `;
}


// ============================================================
// Workspace
// ============================================================

// ---------------------------------------------------------------------------
// Workspace quota
//
// A workspace is a staging area, not a store. The figures come from the server,
// which counts distinct content and excludes anything already in the game
// store — the browser cannot work either of those out for itself.
// ---------------------------------------------------------------------------

let workspaceUsage = null;

function renderQuotaPanel() {
    const el = $('workspaceUsage');

    if (!el) return;

    el.textContent = '';

    if (!workspaceUsage) return;

    const variant =
        workspaceUsage.percent_used >= 95 ? 'danger' :
        workspaceUsage.percent_used >= 75 ? 'warning' :
        'success';

    const label = document.createElement('span');
    label.className = 'me-2';
    label.textContent =
        `${formatFileSize(workspaceUsage.bytes)} of ` +
        `${formatFileSize(workspaceUsage.limit_bytes)} used`;

    const bar = document.createElement('div');
    bar.className = 'progress d-inline-block align-middle';
    bar.style.height = '6px';
    bar.style.width = '120px';

    const fill = document.createElement('div');
    fill.className = `progress-bar bg-${variant}`;
    fill.style.width = `${Math.min(100, workspaceUsage.percent_used)}%`;
    fill.setAttribute('aria-valuenow', String(workspaceUsage.percent_used));
    fill.setAttribute('aria-valuemin', '0');
    fill.setAttribute('aria-valuemax', '100');

    bar.appendChild(fill);

    el.appendChild(label);
    el.appendChild(bar);
}

// Pre-flight for a pending upload.
//
// The browser cannot know which of the selected files the workspace already
// holds without hashing every one of them, which is far too slow at GB scale.
// So the estimate deliberately assumes EVERY file is new — an upper bound. If
// the bound fits, the upload definitely fits. If it does not, it may still be
// fine, because re-uploaded content costs nothing. Hence "may", and the server
// checks precisely and is the thing that actually refuses.
function updateUploadSizeSummary() {
    const summary = $('uploadSizeSummary');
    const warning = $('uploadQuotaWarning');

    if (!summary) return;

    if (selectedFiles.length === 0) {
        summary.textContent = '';
        if (warning) warning.classList.add('d-none');
        return;
    }

    const totalBytes = selectedFiles.reduce(
        (sum, item) => sum + (item.file?.size || 0),
        0
    );

    summary.textContent =
        `Total ${formatFileSize(totalBytes)} across ${selectedFiles.length} ` +
        `file${selectedFiles.length === 1 ? '' : 's'}.` +
        (skippedBackupCount > 0
            ? ` ${skippedBackupCount} backup file${skippedBackupCount === 1 ? '' : 's'} ` +
              `skipped — backups are not uploaded.`
            : '');

    if (!warning || !workspaceUsage) return;

    const projected = workspaceUsage.bytes + totalBytes;

    if (projected > workspaceUsage.limit_bytes) {
        warning.textContent =
            `This upload may exceed the workspace limit — up to ` +
            `${formatFileSize(projected)} against a ` +
            `${formatFileSize(workspaceUsage.limit_bytes)} limit. Content the ` +
            `workspace already holds does not count, so the real figure may be ` +
            `lower. The server checks exactly and will refuse if it would go over.`;
        warning.classList.remove('d-none');
    } else {
        warning.classList.add('d-none');
    }
}

async function loadDeveloperWorkspace() {

    try {

        const response =
            await fetch(
                `${API_URL}/assets`,
                {
                    method: 'GET',
                    credentials: 'include'
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.error ||
                'Failed to load workspace'
            );
        }


        console.log(
            'Developer workspace:',
            data.workspace
        );

        console.log(
            'Developer assets:',
            data.assets
        );


        workspaceUsage =
            data.usage || null;

        renderQuotaPanel();

        // The bin badge comes from the workspace payload, so it is right on
        // load. The tab's contents are still fetched only when it is opened —
        // the count is cheap, the list is not.
        setBinCount(
            (data.bin?.assets || 0) + (data.bin?.versions || 0)
        );


        renderWorkspaceAssets(
            data.assets || []
        );


        // Usage has just changed, so refresh the pending-upload estimate.
        renderUploadPreview();


    } catch (err) {

        console.error(
            'Failed to load developer workspace:',
            err
        );


        const list =
            $('workspaceAssetsList');

        if (list) {
            list.innerHTML = `
                <div class="alert alert-danger">
                    ${escapeHtml(err.message)}
                </div>
            `;
        }
    }
}


// ============================================================
// Workspace asset display
// ============================================================
// ---------------------------------------------------------------------------
// Version state
//
// A developer submits a version for Creative Approval and, until now, had no
// way to learn the outcome: the approval and technical-check records existed in
// the database but nothing ever read them back. These render that state.
//
// Everything is built with createElement/textContent, matching the rest of this
// renderer — none of it is user-controlled HTML.
// ---------------------------------------------------------------------------

function statusBadge(text, variant) {
    const badge = document.createElement('span');
    badge.className = `badge text-bg-${variant} me-2 mb-1`;
    badge.textContent = text;
    return badge;
}

function approvalBadge(approval) {
    switch (approval.status) {
        case 'pending':   return statusBadge('Awaiting review', 'warning');
        case 'approved':  return statusBadge('Approved', 'success');
        case 'rejected':  return statusBadge('Rejected', 'danger');
        case 'cancelled': return statusBadge('Cancelled', 'secondary');
        default:          return statusBadge(approval.status, 'secondary');
    }
}

function renderVersionState(version) {
    const wrapper = document.createElement('div');

    const badges = document.createElement('div');
    badges.className = 'd-flex flex-wrap align-items-center mb-1';

    if (version.creative_locked) {
        badges.appendChild(statusBadge('Locked', 'secondary'));
    }

    if (version.latest_approval) {
        badges.appendChild(approvalBadge(version.latest_approval));
    }

    if (version.latest_check) {
        const passed = version.latest_check.status === 'passed';
        badges.appendChild(statusBadge(
            passed ? 'Technical check passed' : 'Technical check failed',
            passed ? 'success' : 'danger'
        ));
    } else {
        badges.appendChild(statusBadge('Not yet checked', 'secondary'));
    }

    if (version.repository_version_id) {
        badges.appendChild(statusBadge('In game store', 'primary'));
    }

    if (badges.childElementCount) {
        wrapper.appendChild(badges);
    }

    // Why a check failed. technical_check_runs.summary is only ever
    // "Technical validation failed." — the actual reason is in the results,
    // one message per failing check.
    const reasons = version.latest_check?.reasons || [];

    if (reasons.length) {
        const list = document.createElement('ul');
        list.className = 'small text-danger mb-2';

        for (const reason of reasons) {
            const item = document.createElement('li');
            item.textContent = reason.message || reason.check_name;
            list.appendChild(item);
        }

        wrapper.appendChild(list);
    }

    // What the reviewer said, so a rejection carries its reason.
    const approval = version.latest_approval;

    if (approval?.decision_comment) {
        const decision = document.createElement('div');
        decision.className = 'small mb-2';

        const label = document.createElement('span');
        label.className = 'text-secondary';
        label.textContent = 'Reviewer: ';

        decision.appendChild(label);
        decision.appendChild(document.createTextNode(approval.decision_comment));
        wrapper.appendChild(decision);
    }

    // EVERY check that ran, not only the failures.
    //
    // The badges above say whether the version passed. They cannot say what was
    // checked, and "nothing failed" and "nothing was checked" look identical
    // from a badge — which are very different pieces of news. So the full list
    // is available, folded away until asked for.
    const allResults = version.latest_check?.results || [];

    if (allResults.length) {
        const details = document.createElement('details');
        details.className = 'small mb-2';

        const summary = document.createElement('summary');
        summary.className = 'text-secondary';
        summary.textContent =
            `${allResults.length} check${allResults.length === 1 ? '' : 's'} run`;
        details.appendChild(summary);

        const list = document.createElement('ul');
        list.className = 'list-unstyled mb-0 mt-1 ps-2';

        for (const result of allResults) {
            const item = document.createElement('li');
            item.className = 'mb-1';

            const passed = result.status === 'passed';

            const mark = document.createElement('i');
            mark.className = passed
                ? 'bi bi-check-circle text-success me-1'
                : 'bi bi-exclamation-circle text-danger me-1';
            item.appendChild(mark);

            const name = document.createElement('span');
            name.className = 'font-monospace';
            name.textContent = result.check_name || 'check';
            item.appendChild(name);

            item.appendChild(document.createTextNode(` — ${result.message || ''}`));

            list.appendChild(item);
        }

        details.appendChild(list);
        wrapper.appendChild(details);
    }

    return wrapper.childElementCount ? wrapper : null;
}

// ---------------------------------------------------------------------------
// Running the technical check
//
// On any version, whenever it is wanted — a check is a judgement of ONE
// submitted version, and re-running it after fixing something is the normal way
// to use it. So the control is per version, not per asset.
//
// The results are the point. A pass/fail badge is not the outcome: the check
// reports every check it ran with a message for each, including the ones that
// could not be verified. All of it is shown, because "nothing failed" and
// "nothing was checked" are very different news and a badge cannot tell them
// apart.
// ---------------------------------------------------------------------------

async function runTechnicalCheck(asset, version, button, block) {
    const originalLabel = button.textContent;

    button.disabled = true;
    button.textContent = 'Checking…';

    // Any error from a previous attempt goes before this one runs, so a stale
    // message cannot look like the result of the run that just happened.
    block?.querySelector('.check-error')?.remove();

    try {
        const response = await fetch(
            `${API_URL}/assets/${asset.id}/versions/${version.id}/technical-check`,
            { method: 'POST', credentials: 'include' }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'The technical check could not be run.');
        }

        // Reloads the workspace, which is what puts the new badges and the new
        // results on screen — the same rendering path as any other refresh,
        // rather than a second one that could disagree with it.
        await loadDeveloperWorkspace();

    } catch (err) {
        console.error('Technical check failed:', err);

        button.disabled = false;
        button.textContent = originalLabel;

        if (block) {
            const message = document.createElement('div');
            message.className = 'check-error alert alert-danger py-2 small mt-2 mb-0';
            message.textContent = `Could not run the check: ${err.message}`;
            block.appendChild(message);
        }
    }
}

// ---------------------------------------------------------------------------
// Deleting from the workspace
//
// A developer can delete anything in their own workspace. It is a soft delete:
// the content survives while anything else references it — the game store, or
// another workspace — and review history is kept. Only their workspace copy and
// their quota go. The confirmation says so, because "delete" is a word people
// reasonably expect to be final.
// ---------------------------------------------------------------------------

async function sendWorkspaceDelete(url, successMessage) {
    try {
        const response = await fetch(url, {
            method: 'DELETE',
            credentials: 'include'
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Delete failed');
        }

        await loadDeveloperWorkspace();
        showUploadStatus(successMessage, 'success');

    } catch (err) {
        console.error('Workspace delete failed:', err);
        showUploadStatus(err.message || 'Delete failed', 'danger');
    }
}

async function deleteWorkspaceVersion(asset, version) {
    const label = `${asset.name} version ${version.version_number}`;

    const confirmed = window.confirm(
        `Delete ${label} from your workspace?\n\n` +
        `The content stays in the store if anything else uses it — the game ` +
        `store, or another workspace — and review history is kept. Only your ` +
        `workspace copy is removed, which frees quota.`
    );

    if (!confirmed) return;

    await sendWorkspaceDelete(
        `/api/developer/workspace/assets/${asset.id}/versions/${version.id}`,
        `Deleted ${label}.`
    );
}

async function deleteWorkspaceAsset(asset) {
    const confirmed = window.confirm(
        `Delete "${asset.name}" and all of its versions from your workspace?\n\n` +
        `The content stays in the store if anything else uses it — the game ` +
        `store, or another workspace — and review history is kept. Only your ` +
        `workspace copy is removed, which frees quota.`
    );

    if (!confirmed) return;

    await sendWorkspaceDelete(
        `/api/developer/workspace/assets/${asset.id}`,
        `Deleted "${asset.name}".`
    );
}

function renderWorkspaceAssets(assets) {
    const list = $('workspaceAssetsList');
    if (!list) return;

    // Rebuilt from scratch each load rather than merged: an asset deleted in
    // another tab must not linger here and get prefilled onto a new upload.
    assetCategories.clear();

    for (const asset of assets) {
        if (asset.category) assetCategories.set(asset.name, asset.category);
    }

    if (assets.length === 0) {
        list.innerHTML = `<p class="mb-0">No assets have been uploaded yet.</p>`;
        return;
    }

    const container = document.createElement('div');
    container.className = 'accordion';

    for (const asset of assets) {
        const item = document.createElement('div');
        item.className = 'accordion-item bg-dark text-light border-secondary';

        const header = document.createElement('h2');
        header.className = 'accordion-header';

        const button = document.createElement('button');
        button.className = 'accordion-button collapsed bg-dark text-light';
        button.type = 'button';
        button.dataset.bsToggle = 'collapse';

        const collapseId = `asset-collapse-${asset.id}`;
        button.dataset.bsTarget = `#${collapseId}`;

        const assetTitle = document.createElement('span');
        assetTitle.className = 'fw-semibold';
        assetTitle.textContent = asset.name;

        button.appendChild(assetTitle);

        // Which part of the game this belongs to. Shown on the collapsed row
        // because it is the one thing that tells two similarly-named assets
        // apart at a glance — "BigTree_Env" and "BigTree_Prop" are the same
        // name to a reader skimming a list.
        //
        // Absent categories render as nothing rather than as "Uncategorised":
        // most assets will be uncategorised, and a badge on every row would be
        // noise that hides the rows that do have one.
        if (asset.category) {
            const badge = document.createElement('span');
            badge.className = 'badge text-bg-info ms-2';
            badge.textContent = asset.category;
            button.appendChild(badge);
        }

        // The whole asset is frozen while an approval is pending, so say so on
        // the collapsed row rather than only failing when a developer tries to
        // upload against it.
        if (asset.has_pending_approval) {
            const frozenBadge = document.createElement('span');
            frozenBadge.className = 'badge text-bg-warning ms-2';
            frozenBadge.textContent = 'Under review — frozen';
            button.appendChild(frozenBadge);
        }

        header.appendChild(button);

        const collapse = document.createElement('div');
        collapse.id = collapseId;
        collapse.className = 'accordion-collapse collapse';

        const body = document.createElement('div');
        body.className = 'accordion-body';

        // Deleting is soft: the content stays in the store while anything else
        // references it, and review history is preserved. The server refuses
        // while an approval is pending, so the button is disabled here rather
        // than letting the developer click straight into a 409.
        const assetActions = document.createElement('div');
        assetActions.className = 'd-flex justify-content-end mb-2';

        const deleteAssetButton = document.createElement('button');
        deleteAssetButton.type = 'button';
        deleteAssetButton.className = 'btn btn-sm btn-outline-danger';
        deleteAssetButton.innerHTML = '<i class="bi bi-trash"></i> Delete asset';

        if (asset.has_pending_approval) {
            deleteAssetButton.disabled = true;
            deleteAssetButton.title =
                'Under review — cannot be deleted until the approval is decided.';
        } else {
            deleteAssetButton.addEventListener('click', () => {
                deleteWorkspaceAsset(asset);
            });
        }

        assetActions.appendChild(deleteAssetButton);
        body.appendChild(assetActions);

        if (asset.description) {
            const description = document.createElement('p');
            description.className = 'small text-secondary mb-3';
            description.textContent = asset.description;
            body.appendChild(description);
        }

        if (!asset.versions || asset.versions.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'text-secondary mb-0';
            empty.textContent = 'No versions uploaded.';
            body.appendChild(empty);
        } else {
            for (const version of asset.versions) {
                const versionBlock = document.createElement('div');
                versionBlock.className = 'border border-secondary rounded p-3 mb-3';

                const versionHeader = document.createElement('div');
                versionHeader.className =
                    'd-flex justify-content-between align-items-center mb-2';

                const versionTitle = document.createElement('strong');
                versionTitle.textContent =
                    `Version ${version.version_number}`;

                const versionDate = document.createElement('span');
                versionDate.className = 'small text-secondary';
                versionDate.textContent =
                    formatWorkspaceDate(version.created_at);

                const versionMeta = document.createElement('div');
                versionMeta.className = 'd-flex align-items-center gap-2';

                versionMeta.appendChild(versionDate);

                // Declared once, used by both controls below. An asset under
                // review is frozen: no new versions, no metadata changes, and
                // no new check result — the reviewer must be looking at
                // something that cannot move underneath them.
                const versionUnderReview =
                    version.latest_approval?.status === 'pending';

                // RUN THE TECHNICAL CHECK, on any version, whenever wanted.
                // Per version rather than per asset, because a check is a
                // judgement of one submitted version — and re-running it after
                // fixing something is the normal way to use it.
                const checkButton = document.createElement('button');
                checkButton.type = 'button';
                checkButton.className = 'btn btn-sm btn-outline-info py-0 px-2';

                const hasBeenChecked = Boolean(version.latest_check);

                checkButton.textContent =
                    hasBeenChecked ? 'Re-run check' : 'Run check';
                checkButton.title = hasBeenChecked
                    ? 'Run the technical check again on this version'
                    : 'Run the technical check on this version';

                // Disabled while an approval is pending, matching the freeze:
                // the version being reviewed must not change underneath the
                // reviewer, and a new check result is a change.
                if (versionUnderReview) {
                    checkButton.disabled = true;
                    checkButton.title =
                        'Under review — the check cannot be re-run until the approval is decided.';
                } else {
                    checkButton.addEventListener('click', () => {
                        runTechnicalCheck(asset, version, checkButton, versionBlock);
                    });
                }

                versionMeta.appendChild(checkButton);

                const deleteVersionButton = document.createElement('button');
                deleteVersionButton.type = 'button';
                deleteVersionButton.className = 'btn btn-sm btn-outline-danger py-0 px-1';
                deleteVersionButton.innerHTML = '<i class="bi bi-trash"></i>';

                if (versionUnderReview) {
                    deleteVersionButton.disabled = true;
                    deleteVersionButton.title =
                        'Under review — cannot be deleted until the approval is decided.';
                } else {
                    deleteVersionButton.title =
                        'Delete this version from your workspace';
                    deleteVersionButton.addEventListener('click', () => {
                        deleteWorkspaceVersion(asset, version);
                    });
                }

                versionMeta.appendChild(deleteVersionButton);

                versionHeader.appendChild(versionTitle);
                versionHeader.appendChild(versionMeta);

                versionBlock.appendChild(versionHeader);

                const versionState = renderVersionState(version);
                if (versionState) {
                    versionBlock.appendChild(versionState);
                }

                if (version.version_note) {
                    const note = document.createElement('div');
                    note.className = 'small text-secondary mb-3';
                    note.textContent = version.version_note;
                    versionBlock.appendChild(note);
                }

                if (!version.files || version.files.length === 0) {
                    const noFiles = document.createElement('div');
                    noFiles.className = 'small text-secondary';
                    noFiles.textContent = 'No files in this version.';
                    versionBlock.appendChild(noFiles);
                } else {
                    const fileList = document.createElement('div');
                    fileList.className = 'list-group list-group-flush';

                    for (const file of version.files) {
                        const row = document.createElement('div');
                        row.className =
                            'list-group-item bg-dark text-light border-secondary px-0';

                        const path = file.relative_path
                            ? `${file.relative_path}/${file.filename}`
                            : file.filename;

                        const pathElement = document.createElement('div');
                        pathElement.className = 'font-monospace small';
                        pathElement.textContent = path;

                        const details = document.createElement('div');
                        details.className = 'small text-secondary mt-1';

                        const size = formatFileSize(file.file_size);

                        details.textContent =
                            `${size}${file.mime_type ? ` • ${file.mime_type}` : ''}`;

                        row.appendChild(pathElement);
                        row.appendChild(details);
                        fileList.appendChild(row);
                    }

                    versionBlock.appendChild(fileList);
                }

                body.appendChild(versionBlock);
            }
        }

        collapse.appendChild(body);
        item.appendChild(header);
        item.appendChild(collapse);
        container.appendChild(item);
    }

    list.innerHTML = '';
    list.appendChild(container);
}

function formatWorkspaceDate(value) {
    if (!value) return '';

    const date = new Date(value.replace(' ', 'T') + 'Z');

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toLocaleString();
}

// formatFileSize() and escapeHtml() moved to ./utils.js, where they are defined
// once for every client file rather than once each.


// ============================================================
// Asset history
// ============================================================
//
// Everything the developer has worked on, including versions that are no longer
// in the workspace.
//
// WHY IT IS A SEPARATE VIEW FROM "My Workspace". That card shows what is IN the
// workspace, which by definition cannot show anything that has left it. The
// moment a version is deleted or superseded it vanished from sight, and the
// record of what happened to it — the checks, the review, the reason — went
// with it. The record was never actually lost; it simply had nowhere to be
// seen. This is that place.
//
// Loaded lazily, when the tab is first opened. It is a second round trip, and
// most visits to this page are to upload something, not to look back.

let historyLoaded = false;

function historyAlert(message) {
    const box = $('historyAlert');
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.textContent = message;
    box.classList.remove('d-none');
}

function renderHistoryTotals(totals) {
    const el = $('historyTotals');
    if (!el || !totals) return;

    const parts = [
        `${totals.assets} asset${totals.assets === 1 ? '' : 's'}`,
        `${totals.versions} version${totals.versions === 1 ? '' : 's'}`,
    ];

    if (totals.in_game_store > 0) {
        parts.push(`${totals.in_game_store} in the game store`);
    }

    el.textContent = parts.join(' · ');
}

// One version of one asset, as a line in the history.
function renderHistoryVersion(asset, version) {
    const row = document.createElement('div');
    row.className = 'border-top border-secondary pt-2 mt-2';

    const heading = document.createElement('div');
    heading.className = 'd-flex flex-wrap align-items-baseline gap-2 mb-1';

    const number = document.createElement('span');
    number.className = 'fw-semibold';
    number.textContent = `v${version.version_number}`;
    heading.appendChild(number);

    const note = document.createElement('span');
    note.className = 'text-secondary small';
    note.textContent = version.version_note || '';
    heading.appendChild(note);

    const when = document.createElement('span');
    when.className = 'text-secondary small ms-auto';
    when.textContent = version.created_at
        ? formatWorkspaceDate(version.created_at)
        : '';
    heading.appendChild(when);

    row.appendChild(heading);

    // Same renderer the workspace uses, so a version reads identically in both
    // views and there is no second implementation to drift.
    row.appendChild(renderVersionState(version));

    // The reviewer's words, which the workspace shows while a decision is live
    // and this keeps afterwards — that is most of the point of the view.
    const approval = version.latest_approval;

    if (approval && approval.decision_comment) {
        const comment = document.createElement('p');
        comment.className = 'small mb-1';
        comment.textContent =
            `${approval.decided_by_username || 'A reviewer'} said: ` +
            approval.decision_comment;
        row.appendChild(comment);
    }

    // Where the finished work went. There is no download here yet — see TODO:
    // the manifest endpoint exists but nothing client-side calls it, and a
    // link that does nothing is worse than saying so.
    if (version.in_game_store) {
        const line = document.createElement('p');
        line.className = 'small text-info mb-0';
        line.textContent =
            'This version is in the game store. The files belong to the game ' +
            'now — download is not built yet.';
        row.appendChild(line);
    }

    row.appendChild(renderPurgeState(asset, version));

    return row;
}

// Removing the content of a version that has already been deleted.
//
// This is the second half of the wastebin. The first half — deleting, which is
// reversible — is on the workspace card where the version used to be. This is
// the part that cannot be undone, so it lives in the history, next to a record
// of what the version was made of.
function renderPurgeState(asset, version) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mt-2';

    // Already purged: say so, and say what it was. The manifest is the reason
    // the record survives the content, and showing it is the whole point of
    // having kept it.
    if (version.files_purged_at) {
        const when = document.createElement('p');
        when.className = 'small text-secondary mb-1';
        when.textContent =
            `Files removed ${formatWorkspaceDate(version.files_purged_at)}. ` +
            'The record above is all that is left of this version.';
        wrapper.appendChild(when);

        let manifest = [];

        try {
            manifest = JSON.parse(version.purged_file_manifest || '[]');
        } catch {
            manifest = [];
        }

        if (manifest.length) {
            const details = document.createElement('details');
            details.className = 'small';

            const summary = document.createElement('summary');
            summary.className = 'text-secondary';
            summary.textContent =
                `${manifest.length} file${manifest.length === 1 ? '' : 's'} removed`;
            details.appendChild(summary);

            const list = document.createElement('ul');
            list.className = 'list-unstyled mb-0 mt-1 ps-2';

            for (const file of manifest) {
                const item = document.createElement('li');
                item.className = 'font-monospace text-secondary';

                const path = file.path ? `${file.path}/${file.filename}` : file.filename;
                item.textContent = `${path} — ${formatFileSize(file.size)}`;
                item.title = file.sha256;

                list.appendChild(item);
            }

            details.appendChild(list);
            wrapper.appendChild(details);
        }

        return wrapper;
    }

    // Still in the workspace: purging is the wrong action, and offering it
    // would skip the reversible step. Deleting comes first.
    if (version.is_active) {
        return wrapper;
    }

    const line = document.createElement('p');
    line.className = 'small text-secondary mb-2';
    line.textContent = version.deleted_at
        ? `Deleted ${formatWorkspaceDate(version.deleted_at)}. The files are still here.`
        : 'Deleted. The files are still here.';
    wrapper.appendChild(line);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-danger py-0 px-2';
    button.textContent = 'Remove the files permanently';

    button.addEventListener('click', () => {
        const confirmed = window.confirm(
            'Remove the files for this version permanently?\n\n' +
            'The version and what happened to it are kept. The files are not, ' +
            'and this cannot be undone.'
        );

        if (confirmed) purgeVersion(asset, version, button, wrapper);
    });

    wrapper.appendChild(button);

    return wrapper;
}

async function purgeVersion(asset, version, button, wrapper) {
    button.disabled = true;
    button.textContent = 'Removing…';

    try {
        const response = await fetch(
            `${API_URL}/assets/${asset.id}/versions/${version.id}/purge`,
            { method: 'POST', credentials: 'include' }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not remove the files.');
        }

        // Reloads the history, which re-renders this version with what is left
        // of it — the same path any other refresh takes.
        await loadAssetHistory();

    } catch (err) {
        console.error('Purge failed:', err);

        button.disabled = false;
        button.textContent = 'Remove the files permanently';

        const message = document.createElement('div');
        message.className = 'small text-danger mt-1';
        message.textContent = err.message;
        wrapper.appendChild(message);
    }
}

function renderHistoryAsset(asset) {
    const item = document.createElement('div');
    item.className = 'border border-secondary rounded mb-3';

    const header = document.createElement('div');
    header.className = 'p-3 d-flex flex-wrap align-items-center gap-2';

    const name = document.createElement('span');
    name.className = 'fw-semibold';
    name.textContent = asset.name;
    header.appendChild(name);

    if (asset.category) {
        header.appendChild(statusBadge(asset.category, 'info'));
    }

    if (asset.in_game_store) {
        header.appendChild(statusBadge('In the game store', 'primary'));
    }

    // Work that has left the workspace is the whole reason this view exists, so
    // it is marked rather than merely listed alongside everything else.
    if (!asset.is_active) {
        header.appendChild(statusBadge('No longer in your workspace', 'secondary'));
    }

    const count = document.createElement('span');
    count.className = 'text-secondary small ms-auto';
    count.textContent =
        `${asset.versions.length} version${asset.versions.length === 1 ? '' : 's'}`;
    header.appendChild(count);

    item.appendChild(header);

    if (asset.description) {
        const description = document.createElement('p');
        description.className = 'text-secondary small px-3 mb-2';
        description.textContent = asset.description;
        item.appendChild(description);
    }

    const versions = document.createElement('div');
    versions.className = 'px-3 pb-3';

    if (asset.versions.length === 0) {
        const none = document.createElement('p');
        none.className = 'text-secondary small mb-0';
        none.textContent = 'No versions were recorded.';
        versions.appendChild(none);
    } else {
        for (const version of asset.versions) {
            versions.appendChild(renderHistoryVersion(asset, version));
        }
    }

    item.appendChild(versions);

    return item;
}

function renderAssetHistory(data) {
    const list = $('historyList');
    if (!list) return;

    renderHistoryTotals(data.totals);

    list.innerHTML = '';

    if (!data.assets || data.assets.length === 0) {
        list.className = 'text-secondary';
        list.textContent =
            'You have not uploaded anything yet. Work you upload will be ' +
            'recorded here, including versions no longer in your workspace.';
        return;
    }

    list.className = '';

    for (const asset of data.assets) {
        list.appendChild(renderHistoryAsset(asset));
    }
}

async function loadAssetHistory() {
    const list = $('historyList');
    historyAlert('');

    if (list) {
        list.className = 'text-secondary';
        list.textContent = 'Loading history...';
    }

    try {
        const response = await fetch(`${API_URL}/assets/history`, {
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load your history.');
        }

        // Set only on SUCCESS. A flag set before the request would mean a
        // failed first load locks the tab empty forever, with no way to try
        // again short of reloading the page.
        historyLoaded = true;

        renderAssetHistory(data);

    } catch (err) {
        console.error('Failed to load asset history:', err);
        historyAlert(err.message);

        // Left blank and re-loadable rather than left saying "Loading...".
        if (list) {
            list.className = 'text-secondary';
            list.textContent = 'Could not load your history. Switch tabs to try again.';
        }
    }
}

function initialiseHistoryTab() {
    const button = $('tab-history-btn');
    if (!button) return;

    // Fires on every open; loadAssetHistory() sets the flag itself once it has
    // actually succeeded, so a failure is retried the next time the tab is
    // opened rather than being remembered as done.
    button.addEventListener('shown.bs.tab', () => {
        if (historyLoaded) return;
        loadAssetHistory();
    });
}


// ============================================================
// The bin
// ============================================================
//
// Deleted work that can still be taken back.
//
// THE CLOCK IS THE POINT, so the countdown is shown per item rather than as a
// single line of explanation. "You have 14 days" is not useful when what you
// want to know is which of these is about to go.
//
// The server sends expires_at and days_remaining rather than the retention
// period for the browser to do arithmetic with: a countdown computed from the
// client's clock is a countdown that depends on a clock that may be wrong.
//
// Every tab reloads this, because a restore or a purge changes the count — and
// a badge that says 3 when the bin holds 2 is worse than no badge.

let binLoaded = false;

function binAlert(message) {
    const box = $('binAlert');
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.textContent = message;
    box.classList.remove('d-none');
}

function setBinCount(count) {
    const badge = $('binCount');
    if (!badge) return;

    badge.textContent = count;
    badge.classList.toggle('d-none', count === 0);
}

// How long is left, in words. Used on every row, because the difference
// between "13 days" and "1 day" is the whole reason someone opens this tab.
function binCountdown(item) {
    if (item.days_remaining === null) return '';

    if (item.days_remaining <= 0) {
        return 'Due to be emptied — the files go on the next clean-up.';
    }

    if (item.days_remaining === 1) {
        return 'Files removed tomorrow.';
    }

    return `Files removed in ${item.days_remaining} days.`;
}

function binRow({ title, subtitle, item, onRestore }) {
    const row = document.createElement('div');
    row.className = 'border-top border-secondary pt-3 mt-3';

    const heading = document.createElement('div');
    heading.className = 'd-flex flex-wrap align-items-baseline gap-2';

    const name = document.createElement('span');
    name.className = 'fw-semibold';
    name.textContent = title;
    heading.appendChild(name);

    if (subtitle) {
        const sub = document.createElement('span');
        sub.className = 'text-secondary small';
        sub.textContent = subtitle;
        heading.appendChild(sub);
    }

    const deleted = document.createElement('span');
    deleted.className = 'text-secondary small ms-auto';
    deleted.textContent = item.deleted_at
        ? `Deleted ${formatWorkspaceDate(item.deleted_at)}`
        : 'Deleted';
    heading.appendChild(deleted);

    row.appendChild(heading);

    // What is at stake, and what is left of it.
    const state = document.createElement('p');
    state.className = 'small mb-1';

    if (item.files_purged_at) {
        state.className += ' text-secondary';
        state.textContent =
            `Files removed ${formatWorkspaceDate(item.files_purged_at)}. ` +
            'This cannot be restored — the record of it stays in your History.';
    } else {
        state.textContent =
            `${item.file_count} file${item.file_count === 1 ? '' : 's'}, ` +
            `${formatFileSize(item.bytes)}. The files are still here. ` +
            binCountdown(item);
    }

    row.appendChild(state);

    if (item.can_restore && onRestore) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-sm btn-outline-success py-0 px-2';
        button.textContent = 'Restore';
        button.addEventListener('click', () => onRestore(button));
        row.appendChild(button);
    }

    return row;
}

function renderBin(data) {
    const list = $('binList');
    if (!list) return;

    setBinCount((data.totals?.assets || 0) + (data.totals?.versions || 0));

    const line = $('binRetentionLine');
    if (line) {
        line.textContent =
            `Deleting is reversible for ${data.retention_days} days. After that ` +
            'the files are removed and the record is all that stays.';
    }

    list.innerHTML = '';
    list.className = '';

    const empty = data.assets.length === 0 && data.versions.length === 0;

    if (empty) {
        list.className = 'text-secondary';
        list.textContent = 'The bin is empty.';
        return;
    }

    // Whole assets first — they are the bigger loss, and there is more to say
    // about them.
    for (const asset of data.assets) {
        const versions = asset.versions || [];

        const restorable = versions.filter(v => v.can_restore).length;

        list.appendChild(binRow({
            title: asset.name,
            subtitle:
                `${versions.length} version${versions.length === 1 ? '' : 's'}` +
                (asset.category ? ` · ${asset.category}` : ''),
            item: asset,
            onRestore: asset.can_restore
                ? (button) => restoreAsset(asset, button)
                : null,
        }));

        // Say which versions will not come back, before the button is pressed
        // rather than after.
        const lost = versions.length - restorable;
        if (lost > 0 && restorable > 0) {
            const warning = document.createElement('p');
            warning.className = 'small text-warning mb-0 ps-2';
            warning.textContent =
                `${lost} of these had their files removed and will not come back.`;
            list.appendChild(warning);
        }
    }

    // Then versions deleted on their own, whose asset is still live.
    for (const version of data.versions) {
        list.appendChild(binRow({
            title: `${version.asset_name} v${version.version_number}`,
            subtitle: version.version_note || '',
            item: version,
            onRestore: version.can_restore
                ? (button) => restoreVersion(version, button)
                : null,
        }));
    }
}

async function loadBin() {
    const list = $('binList');
    binAlert('');

    if (list) {
        list.className = 'text-secondary';
        list.textContent = 'Loading bin...';
    }

    try {
        const response = await fetch(`${API_URL}/assets/bin`, {
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load the bin.');
        }

        binLoaded = true;
        renderBin(data);

    } catch (err) {
        console.error('Failed to load the bin:', err);
        binAlert(err.message);

        if (list) {
            list.className = 'text-secondary';
            list.textContent = 'Could not load the bin. Switch tabs to try again.';
        }
    }
}

async function sendRestore(url, button, verb) {
    button.disabled = true;
    button.textContent = 'Restoring…';

    try {
        const response = await fetch(url, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || `Could not restore the ${verb}.`);
        }

        // The workspace has to be reloaded as well as the bin: a restored asset
        // reappears there, and its quota comes back with it.
        await loadDeveloperWorkspace();
        await loadBin();

    } catch (err) {
        console.error('Restore failed:', err);

        button.disabled = false;
        button.textContent = 'Restore';
        binAlert(err.message);
    }
}

function restoreAsset(asset, button) {
    sendRestore(`${API_URL}/assets/${asset.id}/restore`, button, 'asset');
}

function restoreVersion(version, button) {
    sendRestore(
        `${API_URL}/assets/${version.asset_id}/versions/${version.id}/restore`,
        button,
        'version'
    );
}

function initialiseBinTab() {
    const button = $('tab-bin-btn');
    if (!button) return;

    button.addEventListener('shown.bs.tab', () => {
        if (binLoaded) return;
        loadBin();
    });
}
