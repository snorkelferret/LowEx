// frontend/src/storeDownload.js
//
// FETCHING A VERSION ONTO THE DEVELOPER'S MACHINE, NEGOTIATING BY HASH.
//
// ============================================================
// ONE PATH, EVERY BROWSER — WHICH IS WHAT IT SHOULD ALWAYS HAVE BEEN
// ============================================================
//
// THE FIRST VERSION OF THIS FILE USED THE FILE SYSTEM ACCESS API, which only
// Chromium has, so the negotiation was offered to Chrome and Edge and withheld
// from everybody else. That was wrong, and it was wrong for a reason worth
// writing down: THE NEGOTIATION ONLY NEEDS TO *READ* A FOLDER, AND EVERY BROWSER
// CAN. Only WRITING INTO one is Chromium-only, and writing is the part that is
// not needed here.
//
//   * READING a folder  `<input type="file" webkitdirectory>` — Chrome, Edge,
//                        Firefox 50+, Safari 11.1+. Effectively everywhere.
//   * WRITING into one  `showDirectoryPicker` — CHROMIUM ONLY. Firefox has a
//                        negative position and Safari opposes it outright.
//
// SO THE OUTPUT IS A ZIP, WHICH EVERY BROWSER CAN DOWNLOAD, and the folder
// writing is gone. The developer picks the folder these files belong in, the
// page hashes it, and what comes back is A ZIP CONTAINING ONLY WHAT THEY LACK —
// unzipped over that folder, it completes it.
//
// ============================================================
// THE SERVER IS TOLD NOTHING ABOUT THE DEVELOPER'S DISK
// ============================================================
//
// The comparison happens HERE. The manifest comes down whole, the hashes are
// computed locally, and only the missing hashes are sent — the server is asked
// for the files it was told about and learns nothing else.
//
// ============================================================
// AND NOTHING IS OVERWRITTEN WITHOUT BEING NAMED FIRST
// ============================================================
//
// `planDownload` separates files that are ABSENT from files that are PRESENT AND
// DIFFERENT. The first go in the zip; the second are shown to the developer by
// name and included only if they say so. Silently replacing somebody's work is
// the worst thing this file could do — and it is worse in a zip, because the
// developer unzips it later and does not see what it lands on.

import { planDownload, rootFolderOf } from './downloadPlan.mjs';

// ---------------------------------------------------------------------------
// Can this browser do it at all?
// ---------------------------------------------------------------------------

export function canNegotiate() {
    return typeof document !== 'undefined'
        && 'webkitdirectory' in document.createElement('input')
        // Hashing needs crypto.subtle, which needs a secure context. Over plain
        // http: on anything but localhost it is absent, and a negotiation that
        // cannot hash would call every file missing and download all of it —
        // which is worse than not offering it.
        && typeof crypto !== 'undefined'
        && Boolean(crypto.subtle);
}

// ---------------------------------------------------------------------------
// Reading the folder the developer chose
// ---------------------------------------------------------------------------

// EVERY BROWSER'S FOLDER PICKER. There is no handle and no permission prompt —
// the developer picks a folder and the page is handed its files, which is all
// the negotiation needs.
function pickFolder() {
    return new Promise((resolve) => {
        const input = document.createElement('input');

        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.style.display = 'none';

        document.body.appendChild(input);

        const finish = (files) => {
            input.remove();
            resolve(files);
        };

        input.addEventListener('change', () => finish(Array.from(input.files || [])));

        // Some browsers fire 'cancel' when the picker is dismissed; others fire
        // nothing at all, and the promise simply never settles. That is a
        // better outcome than it sounds — the caller is awaiting a choice the
        // developer has not made.
        input.addEventListener('cancel', () => finish([]));

        input.click();
    });
}

const HEX = (buffer) =>
    [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hashOf(file) {
    return HEX(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// THE FIRST SEGMENT, REMOVED. Both sides of the comparison have one and neither
// is the other: the manifest's paths begin with the folder the files were
// uploaded in, and the picked folder's files begin with the name the developer
// gave it. WHAT MATTERS IS THE STRUCTURE INSIDE — the tree is load-bearing and
// the container is transport (item 54).
function stripRoot(path, root) {
    if (!root) return path;

    const segments = String(path).split('/').filter(Boolean);

    return segments.length > 1 && segments[0] === root
        ? segments.slice(1).join('/')
        : path;
}

// ---------------------------------------------------------------------------
// Saving the zip
// ---------------------------------------------------------------------------

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();
    link.remove();

    // Revoked LATER rather than at once: some browsers cancel a download whose
    // object URL is revoked in the same tick.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Negotiate, then fetch only what is missing.
 *
 * @param {Object} opts
 * @param {number} opts.assetId
 * @param {number} opts.versionId
 * @param {string} opts.assetName
 * @param {function} opts.fetchJson   async (url, options) => parsed JSON, or the
 *                                    raw Response when asked
 * @param {function} opts.onReport    what was found, before anything is fetched
 * @param {function} opts.confirmReplacements
 *
 * @returns {{ written, kept, replaced, failed }}
 */
export async function downloadVersion({
    assetId,
    versionId,
    assetName,
    fetchJson,
    apiBase = '/api/game',
    onReport = () => {},
    confirmReplacements = () => false
}) {
    if (!canNegotiate()) {
        throw new Error(
            'This browser cannot read a folder, so there is nothing to compare ' +
            'against. Use the zip instead.'
        );
    }

    // FIRST, BECAUSE IT IS THE DEVELOPER'S CHOICE AND NOTHING IS FETCHED BEFORE
    // IT. The folder they pick is the one these files belong in.
    const picked = await pickFolder();

    if (picked.length === 0) {
        onReport({ phase: 'cancelled' });
        return { written: 0, kept: 0, replaced: 0, failed: 0, cancelled: true };
    }

    const manifest = await fetchJson(`${apiBase}/${assetId}/versions/${versionId}/manifest`);
    const files = manifest.files || [];

    if (files.length === 0) throw new Error('That version has no files in it.');

    const manifestRoot = rootFolderOf(files.map(f => f.path));
    const pickedRoot = rootFolderOf(picked.map(f => f.webkitRelativePath));

    // BOTH SIDES REDUCED TO THE STRUCTURE BENEATH THEIR CONTAINER, so a folder
    // called anything at all can be compared against a version.
    const wanted = files.map(f => ({
        path: stripRoot(f.path, manifestRoot),
        sha256: f.sha256,
        size: f.size
    }));

    const local = new Map();

    for (const file of picked) {
        local.set(stripRoot(file.webkitRelativePath, pickedRoot), {
            size: file.size,
            sha256: null,
            file
        });
    }

    // HASH ONLY THE CANDIDATES. A file whose size differs is already known to
    // differ, and reading it would be work for an answer we have.
    const wantedSize = new Map(wanted.map(f => [f.path, f.size]));

    for (const [path, entry] of local) {
        if (wantedSize.get(path) === entry.size) {
            entry.sha256 = await hashOf(entry.file);
        }
    }

    const plan = planDownload(wanted, local);

    onReport({ phase: 'planned', plan });

    // NAMED BEFORE ANYTHING IS REPLACED. Never silently — and worse in a zip,
    // because the developer unzips it later and does not see what it lands on.
    const replace = plan.replace.length > 0 && confirmReplacements(plan.replace)
        ? plan.replace
        : [];

    const toFetch = [...plan.write, ...replace];

    if (toFetch.length === 0) {
        onReport({ phase: 'done', plan, summary: { written: 0, kept: plan.keep.length, replaced: 0, failed: 0 }, assetName });
        return { written: 0, kept: plan.keep.length, replaced: 0, failed: 0 };
    }

    // THE ZIP, AND ONLY THE DIFFERENCE IN IT. The entries are relative to the
    // folder the developer picked, so "unzip here" is the whole instruction.
    let failed = 0;

    try {
        const response = await fetchJson(`${apiBase}/${assetId}/versions/${versionId}/archive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ only: toFetch.map(f => f.sha256) }),
            raw: true
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `The server said ${response.status}`);
        }

        saveBlob(
            await response.blob(),
            `${String(assetName).replace(/[^A-Za-z0-9._-]+/g, '_')}_${toFetch.length}files.zip`
        );

    } catch (err) {
        console.error('Could not fetch the difference:', err);
        failed = toFetch.length;
    }

    const summary = {
        written: failed ? 0 : toFetch.length,
        kept: plan.keep.length,
        replaced: failed ? 0 : replace.length,
        failed
    };

    // WHAT THE DEVELOPER TOOK IS RECORDED, so it is in their history. An
    // assertion — the server cannot see this disk — which is why it is typed
    // rather than observed, and why it is reported AFTER the download.
    try {
        await fetchJson(`${apiBase}/${assetId}/versions/${versionId}/downloaded`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files_written: summary.written,
                files_unchanged: summary.kept,
                files_failed: summary.failed,
                target_folder: pickedRoot || null
            })
        });
    } catch (err) {
        // A history entry that failed to write is not a failed download.
        console.error('Could not record the download:', err);
    }

    onReport({ phase: 'done', plan, summary, assetName });

    return summary;
}
