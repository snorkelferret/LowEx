// frontend/src/adminStorage.js
//
// The Storage panel, on both the admin and superuser dashboards — for the same
// reason adminUsers.js, adminReports.js and adminAudit.js are: the panel is
// built into both, and logic living in admin.js would leave it stuck on
// "Loading…" on the superuser dashboard.
//
// TWO FIGURES, DELIBERATELY NOT RECONCILED ON THE CLIENT. The server sends the
// disk reading and the per-developer charges; this renders both and prints the
// note explaining why they differ. It does NOT compute either one, and it does
// not subtract one from the other to show a "remaining" that would be
// meaningless — see backend/lib/hostStorage.js for why the two do not
// reconcile.
//
// NOTHING HERE DERIVES A NUMBER THE SERVER ALREADY DECIDED. Percentages, the
// status band and the remaining bytes all arrive ready to display. A client
// that recomputed them could disagree with the developer's own screen, which is
// the one thing this tab exists to prevent.

import { $ } from './utils.js';
import { formatBytes } from '../../shared/formatBytes.mjs';
import { apiFetch } from './api.js';

const API = '/api';

function showAlert(message) {
    const box = $('storageAlert');
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.textContent = message;
    box.classList.remove('d-none');
}

// The server's band, mapped to a fill class. The switch is exhaustive over what
// hostStorage can return, and anything else falls through to neutral rather
// than to a colour that would claim a status the server did not report.
function fillClass(status) {
    if (status === 'ok') return 'usage-bar-fill--ok';
    if (status === 'warning') return 'usage-bar-fill--warning';
    if (status === 'critical') return 'usage-bar-fill--critical';
    return '';
}

// Icon AND word, both from the server's status. The colour is the third signal,
// never the only one — see the reserved scale in styles.css.
function statusBadge(status) {
    const known = {
        ok:       { icon: 'bi-check-circle-fill',       word: 'Healthy',  colour: 'var(--status-ok)' },
        warning:  { icon: 'bi-exclamation-triangle-fill', word: 'Filling up', colour: 'var(--status-warning)' },
        critical: { icon: 'bi-exclamation-octagon-fill', word: 'Nearly full', colour: 'var(--status-critical)' }
    };

    const shown = known[status] || { icon: 'bi-question-circle', word: 'Unknown', colour: 'var(--bs-secondary-color)' };

    const badge = document.createElement('span');
    badge.className = 'fw-semibold';
    badge.style.color = shown.colour;

    const icon = document.createElement('i');
    icon.className = `bi ${shown.icon} me-1`;
    // Decorative: the word beside it already carries the meaning, and a screen
    // reader announcing "check circle fill, Healthy" says it twice.
    icon.setAttribute('aria-hidden', 'true');

    badge.appendChild(icon);
    badge.appendChild(document.createTextNode(shown.word));

    return badge;
}

function bar(percent, status) {
    const track = document.createElement('div');
    track.className = 'usage-bar';

    const fill = document.createElement('div');
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    fill.className = `usage-bar-fill ${fillClass(status)}`.trim();

    if (clamped <= 0) {
        fill.classList.add('usage-bar-fill--empty');
    } else {
        fill.style.width = `${clamped}%`;
    }

    track.appendChild(fill);
    return track;
}

function tile(label, value, extra) {
    const cell = document.createElement('div');
    cell.className = 'stat-tile';

    const labelEl = document.createElement('div');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('div');
    valueEl.className = 'stat-value';
    valueEl.textContent = value;

    cell.appendChild(labelEl);
    cell.appendChild(valueEl);

    if (extra) cell.appendChild(extra);

    return cell;
}

function line(text, className) {
    const p = document.createElement('div');
    p.className = className || 'text-secondary small';
    p.textContent = text;
    return p;
}

// Renders the disk, or says why it cannot.
function renderHost(host) {
    const box = $('storageHost');
    if (!box) return;

    box.innerHTML = '';
    box.className = '';

    // Not an error — the directory may simply not exist because nothing has
    // ever been uploaded. Saying so is the difference between "this is empty"
    // and "this is broken", and reporting zeros instead would look like a full
    // disk at 0% used.
    if (!host || !host.readable) {
        box.className = 'alert alert-secondary py-2 px-3 small mb-0';
        box.textContent = (host && host.error) || 'The filesystem could not be read.';
        return;
    }

    const header = document.createElement('div');
    header.className = 'd-flex flex-wrap justify-content-between align-items-center gap-2 mb-2';

    const heading = document.createElement('h3');
    heading.className = 'h6 mb-0';
    heading.textContent = 'The disk';

    header.appendChild(heading);
    header.appendChild(statusBadge(host.status));
    box.appendChild(header);

    // A bar per measurement, each labelled with its own percentage — the two
    // are different questions and must not share a scale.
    const tiles = document.createElement('div');
    tiles.className = 'd-flex flex-wrap gap-4 mb-2';

    tiles.appendChild(tile(
        'Space used',
        `${host.percent_used}%`,
        bar(host.percent_used, host.space_status)
    ));

    tiles.appendChild(tile(
        'Free',
        formatBytes(host.free_bytes),
        line(`of ${formatBytes(host.total_bytes)}`, 'stat-label')
    ));

    // Inodes are a separate way to run out and a store of many small files is
    // exactly how it happens, so they are shown even when healthy. A null
    // percentage means the filesystem does not keep a table to run out of.
    //
    // Both bands come from the server, including this one — see
    // shared/usageStatus.mjs for why the client is not asked to agree about
    // what "nearly full" means.
    if (host.inodes_used_percent === null || host.inodes_used_percent === undefined) {
        tiles.appendChild(tile('Files', `${host.inodes_total || 0} used`, null));
    } else {
        tiles.appendChild(tile(
            'File slots used',
            `${host.inodes_used_percent}%`,
            bar(host.inodes_used_percent, host.inode_status)
        ));
    }

    box.appendChild(tiles);

    box.appendChild(line(
        `Measured on ${host.path}. A content-addressed store holds one file per ` +
        `SHA, and game assets include a great many small ones, so the file slots ` +
        `can run out while terabytes of space remain — it fails the same way, and ` +
        `both are shown for that reason.`
    ));
}

// The two totals, side by side, with the reason they differ.
function renderReconcile(data) {
    const box = $('storageReconcile');
    if (!box) return;

    box.innerHTML = '';

    const store = data.store || { blob_count: 0, bytes: 0 };
    const charged = data.charged || { bytes: 0, developer_count: 0 };

    const tiles = document.createElement('div');
    tiles.className = 'd-flex flex-wrap gap-4';
    tiles.appendChild(tile('Stored once', formatBytes(store.bytes),
        line(`${store.blob_count} ${store.blob_count === 1 ? 'blob' : 'blobs'} on disk`, 'stat-label')));
    tiles.appendChild(tile('Charged to developers', formatBytes(charged.bytes),
        line(`across ${charged.developer_count} ${charged.developer_count === 1 ? 'account' : 'accounts'}`, 'stat-label')));

    box.appendChild(tiles);

    box.appendChild(line(
        'These do not match, and are not meant to. Charged bytes exclude the game ' +
        'store — shared content belongs to nobody — and count a blob once for each ' +
        'workspace holding it, so one stored file can be charged twice while ' +
        'occupying the disk once. The difference is the game store plus anything ' +
        'the collector has not reached yet, not a discrepancy to chase.', 'text-secondary small mt-2 mb-0'));
}

function renderDevelopers(developers) {
    const box = $('storageDevelopers');
    if (!box) return;

    const counts = $('storageDeveloperCount');

    box.className = '';
    box.innerHTML = '';

    if (counts) {
        counts.textContent = developers.length === 1
            ? '1 account'
            : `${developers.length} accounts`;
    }

    if (developers.length === 0) {
        box.className = 'text-secondary';
        box.textContent = 'No developer accounts yet.';
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'table-responsive';

    const table = document.createElement('table');
    table.className = 'table table-hover align-middle small mb-0';

    table.innerHTML = `
      <thead class="text-uppercase">
        <tr>
          <th>Developer</th>
          <th>State</th>
          <th class="text-end">Files</th>
          <th class="text-end">Charged</th>
          <th style="width: 30%">Of their ${formatBytes(developers[0].limit_bytes)}</th>
        </tr>
      </thead>
    `;

    const tbody = document.createElement('tbody');

    for (const dev of developers) {
        const tr = document.createElement('tr');

        // textContent throughout: a username and an email are things a person
        // wrote, and this table is read by the most privileged account.
        const who = document.createElement('td');
        const name = document.createElement('div');
        name.textContent = dev.username;
        const email = document.createElement('div');
        email.className = 'text-secondary';
        email.textContent = dev.email || '';
        who.appendChild(name);
        if (dev.email) who.appendChild(email);

        tr.appendChild(who);

        // A deactivated developer still holds their quota, so the row stays and
        // says so — dropping them from the list would hide bytes that are
        // genuinely still charged to somebody.
        const state = document.createElement('td');
        if (dev.is_active) {
            state.className = 'text-secondary';
            state.textContent = 'active';
        } else {
            const badge = document.createElement('span');
            badge.className = 'badge text-bg-secondary';
            badge.textContent = 'deactivated';
            state.appendChild(badge);
        }
        tr.appendChild(state);

        const files = document.createElement('td');
        files.className = 'text-end';
        files.textContent = String(dev.file_count);

        const charged = document.createElement('td');
        charged.className = 'text-end';
        charged.textContent = formatBytes(dev.bytes);

        const usage = document.createElement('td');
        const row = document.createElement('div');
        row.className = 'd-flex align-items-center gap-2';

        const percent = document.createElement('span');
        percent.className = 'text-secondary text-nowrap';
        percent.textContent = `${dev.percent_used}%`;

        const fill = document.createElement('div');
        fill.className = 'flex-grow-1';
        // dev.status, sent by workspaceUsage() — the same function and so the
        // same band the developer sees on their own panel.
        fill.appendChild(bar(dev.percent_used, dev.status));

        row.appendChild(fill);
        row.appendChild(percent);
        usage.appendChild(row);

        tr.appendChild(files);
        tr.appendChild(charged);
        tr.appendChild(usage);
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
}

async function loadStorage() {
    const box = $('storageDevelopers');
    if (!box) return;

    showAlert('');

    box.className = 'text-secondary';
    box.textContent = 'Loading storage figures...';

    try {
        const response = await apiFetch(`${API}/admin/storage`, { credentials: 'include' });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load storage figures.');
        }

        renderHost(data.host);
        renderReconcile(data);
        renderDevelopers(data.developers || []);

    } catch (err) {
        console.error('Could not load storage figures:', err.message);

        box.className = 'text-secondary';
        box.textContent = '';
        showAlert(err.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Only present on the admin and superuser dashboards.
    if (!$('storageDevelopers')) return;

    loadStorage();
});
