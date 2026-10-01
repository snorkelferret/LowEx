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

    $('uploadStatus').innerHTML = '';

    renderUploadPreview();
}


// ============================================================
// Upload
// ============================================================

async function uploadAsset() {

    if (selectedFiles.length === 0) {
        return;
    }


    const assetName =
        $('assetName')?.value.trim();

    const assetType =
        $('assetType')?.value.trim();

    const description =
        $('assetDescription')?.value.trim();

    const versionNote =
        $('versionNote')?.value.trim();


    if (!assetName) {

        showUploadStatus(
            'Asset name is required.',
            'danger'
        );

        $('assetName')?.focus();

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


    formData.append(
        'asset_name',
        assetName
    );

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
