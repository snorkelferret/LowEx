// frontend/src/developerWorkspace.js


const API_URL = '/api/developer/workspace';


// ============================================================
// Upload state
// ============================================================

let selectedFiles = [];


// ============================================================
// DOM helpers
// ============================================================

const $ = id => document.getElementById(id);


// ============================================================
// Initialisation
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

    initialiseUploadUI();
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

function addSelectedFiles(files) {

    for (const file of files) {

        const relativePath =
            file.webkitRelativePath ||
            file.name;


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


    const assetType =
        $('assetType')?.value.trim();

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

    formData.append(
        'asset_type',
        assetType
    );

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
        `file${selectedFiles.length === 1 ? '' : 's'}.`;

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

    return wrapper.childElementCount ? wrapper : null;
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

        if (asset.asset_type) {
            const badge = document.createElement('span');
            badge.className = 'badge text-bg-secondary ms-2';
            badge.textContent = asset.asset_type;
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

                const deleteVersionButton = document.createElement('button');
                deleteVersionButton.type = 'button';
                deleteVersionButton.className = 'btn btn-sm btn-outline-danger py-0 px-1';
                deleteVersionButton.innerHTML = '<i class="bi bi-trash"></i>';

                const versionUnderReview =
                    version.latest_approval?.status === 'pending';

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

// ============================================================
// Formatting
// ============================================================

function formatFileSize(bytes) {

    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }


    const units = [
        'B',
        'KB',
        'MB',
        'GB',
        'TB'
    ];


    const exponent =
        Math.min(
            Math.floor(
                Math.log(bytes) /
                Math.log(1024)
            ),
            units.length - 1
        );


    const value =
        bytes /
        Math.pow(
            1024,
            exponent
        );


    return `${value.toFixed(
        exponent === 0 ? 0 : 2
    )} ${units[exponent]}`;
}


// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(value) {

    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
