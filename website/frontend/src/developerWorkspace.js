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

        return;
    }


    section.classList.remove('d-none');


    if (count) {
        count.textContent =
            `${selectedFiles.length} file` +
            (selectedFiles.length === 1 ? '' : 's');
    }


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


        renderWorkspaceAssets(
            data.assets || []
        );


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

        header.appendChild(button);

        const collapse = document.createElement('div');
        collapse.id = collapseId;
        collapse.className = 'accordion-collapse collapse';

        const body = document.createElement('div');
        body.className = 'accordion-body';

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

                versionHeader.appendChild(versionTitle);
                versionHeader.appendChild(versionDate);

                versionBlock.appendChild(versionHeader);

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
