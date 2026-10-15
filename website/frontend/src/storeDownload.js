// frontend/src/storeDownload.js
//
// FETCHING A VERSION ONTO THE DEVELOPER'S MACHINE, NEGOTIATING BY HASH.
//
// ============================================================
// THIS FILE CAN ONLY WORK IN CHROMIUM, AND THAT IS NOT A PREFERENCE
// ============================================================
//
// Reading and writing a folder the developer chose needs the File System Access
// API. Chrome and Edge have it. FIREFOX AND SAFARI HAVE NO EQUIVALENT, so on
// those the browser cannot see the disk, cannot hash anything, and there is
// nothing to negotiate with. The caller checks for it and offers the zip
// instead — see `canNegotiate()`.
//
// THE ALTERNATIVE FOR THOSE BROWSERS IS THE SMALL CLI the spec anticipates
// ("a small CLI later lets an artist sync by hash"). IT WOULD USE THE SAME
// ENDPOINTS: the manifest, and one file by hash. Nothing here is web-specific
// except the two places that touch the disk.
//
// ============================================================
// THE SERVER IS TOLD NOTHING ABOUT THE DEVELOPER'S DISK
// ============================================================
//
// The comparison happens HERE. The manifest comes down whole, the hashes are
// computed locally, and only the files that are actually missing are fetched.
// The server is asked "what does this version contain" and nothing else — it
// never learns what the developer has.
//
// ============================================================
// AND NOTHING IS OVERWRITTEN WITHOUT BEING NAMED FIRST
// ============================================================
//
// `planDownload` separates files that are ABSENT from files that are PRESENT AND
// DIFFERENT. The first are written; the second are shown to the developer by
// name and written only if they say so. Silently replacing somebody's work is
// the worst thing this file could do.

import { planDownload, rootFolderOf } from './downloadPlan.mjs';

// ---------------------------------------------------------------------------
// Can this browser do it at all?
// ---------------------------------------------------------------------------

export function canNegotiate() {
    return typeof window !== 'undefined'
        && typeof window.showDirectoryPicker === 'function'
        // The hashing needs crypto.subtle, which needs a secure context. On
        // plain http: that is NOT localhost it is absent, and a download that
        // half-works is worse than one that is not offered.
        && typeof crypto !== 'undefined'
        && Boolean(crypto.subtle);
}

// ---------------------------------------------------------------------------
// Reading the folder the developer chose
// ---------------------------------------------------------------------------

/**
 * Every file under a directory handle, keyed by its path relative to it.
 *
 * SIZE ONLY, AND THE HASH STARTS NULL. Hashing is the slow part — a developer's
 * project can be gigabytes — so it happens in a second pass, and only for files
 * that could possibly match.
 */
async function readTree(dirHandle, prefix = '') {
    const found = new Map();

    for await (const [name, handle] of dirHandle.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;

        if (handle.kind === 'file') {
            const file = await handle.getFile();
            found.set(path, { size: file.size, sha256: null, handle });

        } else if (handle.kind === 'directory') {
            for (const [p, entry] of await readTree(handle, path)) {
                found.set(p, entry);
            }
        }
    }

    return found;
}

const HEX = (buffer) =>
    [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hashOf(handle) {
    const file = await handle.getFile();
    return HEX(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write one file at `path` under `rootHandle`, creating the directories it needs.
 *
 * EVERY SEGMENT IS REFUSED IF IT IS '.' OR '..'. The paths come from the server,
 * which built them from `relative_path`, which originated client-side — so they
 * are checked here rather than trusted, the same way the archive checks them
 * before writing entry names. This one WRITES, so the check matters more.
 */
async function writeFile(rootHandle, path, blob) {
    const segments = String(path).split('/').filter(Boolean);
    const filename = segments.pop();

    if (!filename) throw new Error(`refusing to write an empty path: ${path}`);

    if (segments.some(s => s === '.' || s === '..')) {
        throw new Error(`refusing a path that climbs out: ${path}`);
    }

    let dir = rootHandle;

    for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();

    await writable.write(blob);
    await writable.close();
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Negotiate, then fetch only what is missing.
 *
 * THE ORDER MATTERS AND IS NOT ARBITRARY:
 *
 *   1  pick a folder      — MUST be first: a browser will not show the picker
 *                           once an await has broken the click's gesture chain
 *   2  fetch the manifest
 *   3  read the tree      — sizes only, which is fast
 *   4  ask which folder name to write under — BEFORE hashing, because the
 *                           comparison is made against the TARGET paths, and
 *                           hashing the wrong files is work for nothing
 *   5  hash what could match — sizes first, so only candidates are read
 *   6  plan               — pure, and the only place that decides anything
 *   7  report, then confirm replacements
 *   8  write what is missing
 *   9  record it, so it is in the developer's history
 *
 * @returns {{ written, kept, replaced, failed, targetFolder }}
 */
export async function downloadVersion({
    assetId,
    versionId,
    assetName,
    fetchJson,
    apiBase = '/api/game',
    onReport = () => {},
    confirmReplacements = () => false,
    chooseRootFolder = (root) => root
}) {
    if (!canNegotiate()) {
        throw new Error(
            'This browser cannot write to a folder. Chrome or Edge can; ' +
            'Firefox and Safari cannot — use the zip instead.'
        );
    }

    const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    const manifest = await fetchJson(`${apiBase}/${assetId}/versions/${versionId}/manifest`);
    const files = manifest.files || [];

    if (files.length === 0) {
        throw new Error('That version has no files in it.');
    }

    const fromRoot = rootFolderOf(files.map(f => f.path));
    const local = await readTree(rootHandle);

    // WHERE THE FILES GO, WHICH IS THE DEVELOPER'S CHOICE. The manifest's paths
    // carry the folder they were uploaded in — item 54 calls that transport, and
    // item 81 records that the code keeps it anyway. So it is offered, defaulted
    // to what the server says.
    const toRoot = chooseRootFolder(fromRoot) || fromRoot;

    // THE TARGET PATH OF EVERY FILE, resolved once, so the hash pass and the
    // plan cannot disagree about where something is meant to land.
    const targetOf = (path) => {
        if (!fromRoot || !toRoot || toRoot === fromRoot) return path;

        const segments = String(path).split('/').filter(Boolean);

        return segments.length > 1 && segments[0] === fromRoot
            ? [toRoot, ...segments.slice(1)].join('/')
            : path;
    };

    // HASH ONLY THE CANDIDATES: a file whose size differs is already known to
    // differ, and reading it would be work for an answer we have.
    const wantedSize = new Map(files.map(f => [targetOf(f.path), f.size]));

    for (const [path, entry] of local) {
        const wanted = wantedSize.get(path);
        if (wanted !== undefined && wanted === entry.size) {
            entry.sha256 = await hashOf(entry.handle);
        }
    }

    let plan = planDownload(files, local, { fromRoot, toRoot });

    onReport({ phase: 'planned', plan, fromRoot, toRoot });

    // NAMED BEFORE ANYTHING IS REPLACED. Never silently.
    let replace = plan.replace;

    if (replace.length > 0 && !confirmReplacements(replace)) {
        replace = [];
    }

    let written = 0;
    let failed = 0;

    for (const file of [...plan.write, ...replace]) {
        try {
            const response = await fetchJson(
                `${apiBase}/${assetId}/versions/${versionId}/files/${file.sha256}`,
                { raw: true }
            );

            if (!response.ok) throw new Error(`the server said ${response.status}`);

            await writeFile(rootHandle, file.target, await response.blob());
            written++;

        } catch (err) {
            console.error(`Could not write ${file.target}:`, err);
            failed++;
        }
    }

    const summary = {
        written,
        kept: plan.keep.length,
        replaced: replace.length,
        failed,
        targetFolder: toRoot
    };

    // WHAT THE DEVELOPER TOOK IS RECORDED, so it is in their history. An
    // assertion — the server cannot see this disk — which is why it is typed
    // rather than observed, and why it is reported AFTER the writing rather than
    // before it.
    try {
        await fetchJson(`${apiBase}/${assetId}/versions/${versionId}/downloaded`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files_written: summary.written,
                files_unchanged: summary.kept,
                files_failed: summary.failed,
                target_folder: summary.targetFolder
            })
        });
    } catch (err) {
        // A history entry that failed to write is not a failed download.
        console.error('Could not record the download:', err);
    }

    onReport({ phase: 'done', plan, summary, assetName });

    return summary;
}
