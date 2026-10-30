// backend/routes/library.js
//
// THE LIBRARY — the third space.
//
// ============================================================
// WHAT THIS IS, AND WHAT IT IS NOT
// ============================================================
//
// Source material: reference photographs, textures in waiting, scans, mood
// boards, PDFs of art books. NOT game assets. An image never goes into the game
// on its own — it goes here, and it is in the game only by being PART OF
// something a developer builds (TODO 57, 58).
//
// SO NOTHING HERE IS APPROVED INTO ANYTHING. There is no submission, no
// reviewer and no store write, because there is nothing to approve: nothing in
// a library "ships". What there is, is a GATE — a light one, described below.
//
// ============================================================
// AND A LIBRARY IS ONLY USEFUL IF THINGS CAN BE FOUND AGAIN
// ============================================================
//
// A folder of reference photographs arrives as IMG_4823, IMG_4824, IMG_4825. The
// point of keeping it is being able to ask for "the ones with trees and a river"
// six months later, so an item carries a NAME, a NOTE and TAGS, and the search
// looks at all three. This is item 54's labelling step and its content search —
// both of which item 57 says are LIBRARY concerns, because you search a library
// for material and you do not search a finished build.
//
// ============================================================
// THE THIRD REFERENCER, AND THE TWO PLACES THAT CARE
// ============================================================
//
// library_items points at stored_files, which makes it the THIRD thing that
// does — after workspace_version_files and asset_version_files. Two places
// enumerate what may reference a blob, and BOTH had to learn about this table:
//
//   backend/jobs/daily.js        the collector's NOT EXISTS pair — without it,
//                                every library blob is collected as garbage
//   backend/lib/workspaceUsage.js    the quota NOT IN — without it, pulling
//                                library material into a workspace is charged
//
// If a fourth referencer ever appears, those two are where to look.
//
// ============================================================
// THE GATE IS LIGHT, AND ITS FAILURE MODE IS PARTIAL
// ============================================================
//
// The check is the SAME verifier the workspace upload uses — checkFileContent()
// in shared/assetRules.mjs, one function deciding what a file is (item 34).
// There is no second list of formats here and there must not be.
//
// WHAT DIFFERS IS THE RESPONSE TO A FAILURE, and the difference is deliberate:
//
//   * THE WORKSPACE UPLOAD IS ALL-OR-NOTHING. A version is ONE deliverable, so
//     a bad file in it fails the whole thing.
//   * A LIBRARY UPLOAD IS A BATCH OF INDEPENDENT ITEMS. Dropping in 200
//     reference photographs and having one stray executable reject all 200 would
//     be a worse outcome than refusing the executable and filing the rest.
//
// SO: BLOCKED and EMPTY files are refused INDIVIDUALLY and reported back; the
// rest are added. The RULES are identical to everywhere else; only the blast
// radius differs. A contradiction is not even a refusal — a JPEG named .png is
// still a picture — it is RECORDED on the item as content_state.
//
// ============================================================
// AND WHY THE BYTES GO IN THROUGH ingestFiles
// ============================================================
//
// storeOne() in backend/lib/ingestFiles.js is the one implementation of "put a
// file in the store" — the lookup by SHA that makes the one-copy rule true, and
// the hard link that writes it. A second copy of those steps here would be a
// second chance to disagree about what a file is, which is precisely what the
// TODO warns about while discussing archives.

const express = require('express');
const fs = require('fs');
const multer = require('multer');
const { makePreview, previewKindOf } = require('../lib/thumbnails');

const db = require('../db');
const audit = require('../lib/audit');
const { authenticateToken, requireRole } = require('../middleware/auth');
// WHO MAY READ THE LIBRARY, named once (item 83). Upload, update and remove
// keep their own lists.
const { CONTENT_READERS } = require('../lib/capabilities');
const { TMP_DIR, THUMB_DIR, blobPath, thumbPath } = require('../lib/storagePaths');
const { sha256OfFile, storeOne } = require('../lib/ingestFiles');

const {
    assetTypeOf,
    extensionOf,
    checkFileContent,
    SIGNATURE_HEAD_BYTES
} = require('../../shared/assetRules.mjs');

const router = express.Router();

// Same temp directory as everything else, and made the same way. Uploads land
// here first, are hashed by streaming, and are then hard-linked into the store —
// TMP_DIR is never part of the store and is always cleaned up below.
const tempUploadDir = TMP_DIR;
fs.mkdirSync(tempUploadDir, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

const libraryUpload = multer({ dest: tempUploadDir });

// The thumbnail's longest edge. Small enough to list a screenful without a
// megabyte each, large enough to recognise a photograph in a grid.

// ============================================================
// Statements
// ============================================================

const insertItem = db.prepare(`
    INSERT INTO library_items (
        stored_file_id,
        display_name,
        original_name,
        content_state,
        added_by
    )
    VALUES (?, ?, ?, ?, ?)
`);

const itemByStoredFile = db.prepare(`
    SELECT
        li.id,
        li.stored_file_id,
        li.display_name,
        li.content_state,
        li.is_active
    FROM library_items li
    WHERE li.stored_file_id = ?
`);

const restoreItem = db.prepare(`
    UPDATE library_items
    SET is_active = 1,
        deleted_at = NULL
    WHERE id = ?
`);

const upsertThumbnail = db.prepare(`
    INSERT INTO file_thumbnails (
        stored_file_id,
        kind,
        storage_key,
        width,
        height
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (stored_file_id, kind)
    DO UPDATE SET
        storage_key = excluded.storage_key,
        width = excluded.width,
        height = excluded.height
`);

const itemForServing = db.prepare(`
    SELECT
        li.id,
        li.display_name,
        li.original_name,
        li.content_state,
        li.created_at,
        sf.sha256,
        sf.file_size,
        sf.storage_key,
        sf.mime_type
    FROM library_items li
    JOIN stored_files sf ON sf.id = li.stored_file_id
    WHERE li.id = ?
      AND li.is_active = 1
`);

const thumbForServing = db.prepare(`
    SELECT
        ft.kind,
        ft.storage_key
    FROM file_thumbnails ft
    JOIN library_items li ON li.stored_file_id = ft.stored_file_id
    WHERE li.id = ?
      AND ft.kind = ?
      AND li.is_active = 1
`);

const updateItem = db.prepare(`
    UPDATE library_items
    SET display_name = ?,
        note = ?
    WHERE id = ?
      AND is_active = 1
`);

// EVERY TAG OF EVERY ITEM, in one query rather than one per item. A page of a
// hundred tiles should not be a hundred round trips.
const allTags = db.prepare(`
    SELECT t.library_item_id, t.tag
    FROM library_item_tags t
    JOIN library_items li ON li.id = t.library_item_id
    WHERE li.is_active = 1
    ORDER BY t.library_item_id, t.tag
`);

const clearTags = db.prepare(`
    DELETE FROM library_item_tags WHERE library_item_id = ?
`);

const addTag = db.prepare(`
    INSERT OR IGNORE INTO library_item_tags (library_item_id, tag)
    VALUES (?, ?)
`);

const softDelete = db.prepare(`
    UPDATE library_items
    SET is_active = 0,
        deleted_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND is_active = 1
`);

// ============================================================
// Helpers
// ============================================================

// ============================================================
// Tags
// ============================================================
//
// FREE TEXT, NORMALISED, AND THE NORMALISATION IS THE WHOLE OF THE DESIGN.
// "Trees", "trees " and "TREES" are one tag, or the search silently misses
// two-thirds of what was filed — which is worse than having no tags, because it
// looks like it works.
//
// THERE IS NO CONTROLLED VOCABULARY YET, deliberately: a vocabulary is a
// decision about who owns the words, and it is better made once there are enough
// tags to see what people actually type. Recorded as TODO 76.
const MAX_TAGS = 40;
const MAX_TAG_LENGTH = 40;

function normaliseTag(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_TAG_LENGTH);
}

/**
 * The first SIGNATURE_HEAD_BYTES of a file, as a Buffer.
 *
 * Read rather than streamed because a signature is at the front by definition,
 * and the file may be a gigabyte. Short reads are normal — a 200-byte file has
 * 200 bytes to give — so the buffer is trimmed to what actually arrived.
 */
async function readHead(filePath) {
    const handle = await fs.promises.open(filePath, 'r');

    try {
        const buffer = Buffer.alloc(SIGNATURE_HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_HEAD_BYTES, 0);

        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

// THUMBNAILS COME FROM backend/lib/thumbnails.js NOW.
//
// The generation used to live here, and the store needed the same thing — so it
// moved rather than being copied. This route keeps only the parts that are the
// library's: deciding WHICH entries get one, and recording them.

// ============================================================
// GET /api/library
// ============================================================
//
// Everything in the library, newest first.
//
// FLAT, WITH A NAME SEARCH, and that is deliberate for a first version: labels
// and content search are steps 6 and 8 of item 54, and they land once there is
// something to look at. Nothing here prevents them.
// ============================================================

router.get(
    '/',
    authenticateToken,
    requireRole(...CONTENT_READERS),

    async (req, res) => {
        try {
            const rows = db.prepare(`
                SELECT
                    li.id,
                    li.display_name,
                    li.original_name,
                    li.note,
                    li.content_state,
                    li.created_at,
                    sf.sha256,
                    sf.file_size,
                    sf.mime_type,
                    u.username AS added_by_username,
                    (SELECT ft.kind
                       FROM file_thumbnails ft
                      WHERE ft.stored_file_id = li.stored_file_id
                      LIMIT 1) AS thumbnail_kind
                FROM library_items li
                JOIN stored_files sf ON sf.id = li.stored_file_id
                LEFT JOIN users u ON u.id = li.added_by
                WHERE li.is_active = 1
                ORDER BY li.created_at DESC, li.id DESC
            `).all();

            // Tags in ONE query for the whole page, then grouped. Doing it per
            // item would be a round trip per tile.
            const tagsByItem = new Map();

            for (const row of allTags.all()) {
                if (!tagsByItem.has(row.library_item_id)) {
                    tagsByItem.set(row.library_item_id, []);
                }

                tagsByItem.get(row.library_item_id).push(row.tag);
            }

            return res.json({
                items: rows.map(row => ({
                    ...row,
                    tags: tagsByItem.get(row.id) || [],
                    // The TYPE, from the same function that decides it
                    // everywhere else — not from the stored mime_type, which is
                    // whatever the browser guessed at upload and is metadata for
                    // display rather than a fact about the file.
                    asset_type: assetTypeOf(row.original_name || row.display_name)
                }))
            });

        } catch (err) {
            console.error('Could not list the library:', err);

            return res.status(500).json({
                error: 'Could not list the library'
            });
        }
    }
);

// ============================================================
// POST /api/library/upload
// ============================================================
//
// One or many files. Each becomes its own item — a library item is a FILE, not
// a set, which is the difference between this and a workspace upload where a
// version is a whole tree.
// ============================================================

router.post(
    '/upload',
    authenticateToken,
    requireRole('developer', 'admin'),

    libraryUpload.fields([
        { name: 'files', maxCount: 1000 }
    ]),

    async (req, res) => {

        const actorId = req.user?.id;

        if (!actorId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        const uploaded = req.files?.files || [];
        const tempPaths = uploaded.map(file => file.path);

        // Physical files this request created, so a failure can remove them.
        // The store's blobs and the thumbnails are cleaned separately because
        // they are cleaned for different reasons.
        const createdBlobs = [];
        const createdThumbs = [];

        async function cleanUpTemp() {
            for (const tempPath of tempPaths) {
                try {
                    await fs.promises.unlink(tempPath);
                } catch {
                    // Already gone. Not a problem, and never a reason to fail.
                }
            }
        }

        function cleanUpCreated() {
            for (const filePath of [...createdBlobs, ...createdThumbs]) {
                try {
                    fs.unlinkSync(filePath);
                } catch {
                    // Already gone.
                }
            }
        }

        if (uploaded.length === 0) {
            return res.status(400).json({
                error: 'No files were uploaded.'
            });
        }

        try {

            // ------------------------------------------------------
            // Hash and check every file BEFORE the transaction.
            //
            // The transaction below is synchronous — better-sqlite3 has
            // no async transactions — so anything that awaits has to
            // happen outside it. Hashing and thumbnailing both do.
            // ------------------------------------------------------

            const prepared = [];
            const refused = [];

            for (const file of uploaded) {
                const sha256 = await sha256OfFile(file.path);
                const name = String(file.originalname || '').trim() || sha256;
                const extension = extensionOf(name);
                const head = await readHead(file.path);
                const verdict = checkFileContent(extension, head);

                // NOTHING UPLOADED EVER RUNS — item 35. A file whose
                // content is blocked does not enter the library, and it
                // is refused HERE rather than stored and flagged, because
                // storing it at all is the thing the rule forbids.
                if (verdict.outcome === 'blocked') {
                    refused.push({
                        filename: name,
                        reason: `Refused: this file's contents are blocked (${verdict.actual}).`
                    });
                    continue;
                }

                if (file.size === 0) {
                    refused.push({
                        filename: name,
                        reason: 'Refused: the file is empty.'
                    });
                    continue;
                }

                prepared.push({ file, sha256, name, verdict });
            }

            if (prepared.length === 0) {
                await cleanUpTemp();

                // THE SAME SHAPE AS A SUCCESSFUL UPLOAD, plus an error, WITH ALL
                // THREE LISTS PRESENT even though two of them are empty. A client
                // that reads body.added.length should not have to know which case
                // it is in first — an absent key and an empty one are different
                // things to write code against, and the absent one crashes. The
                // STATUS is what says nothing got in.
                return res.status(422).json({
                    error: 'None of those files could be added.',
                    added: [],
                    existing: [],
                    refused
                });
            }

            // ------------------------------------------------------
            // Thumbnails, before the transaction, for images only.
            //
            // assetTypeOf() decides what a file is, and 'Image' is the
            // only kind with an encoder today. Everything else keeps
            // its type and size and shows an icon — the table is ready
            // for a video_frame or a model_preview when one exists.
            // ------------------------------------------------------

            // THIS ONE WAITS, AND THE APPROVAL UPLOAD DOES NOT. The library
            // writes the thumbnail row with the item and reports whether there
            // is one in the response, so the picture has to exist first. The
            // approval upload has its file rows committed already, so it
            // replies and makes the pictures afterwards. Both go through the
            // same queue in lib/thumbnails.js — two at a time — which is what
            // keeps either from taking the server's thread pool.
            for (const entry of prepared) {
                entry.thumbnail = null;

                // THE SHARED RULES DECIDE, not a private list here: image or
                // video, or nothing. The library takes both now, because the
                // implementation does.
                const kind = previewKindOf(entry.name);

                if (!kind) continue;

                try {
                    entry.thumbnail = await makePreview(
                        entry.file.path,
                        entry.sha256,
                        kind
                    );

                    if (entry.thumbnail) {
                        createdThumbs.push(entry.thumbnail.createdPath);
                    }
                } catch (err) {
                    // A thumbnail that cannot be made is not a reason to
                    // refuse a file. The item is still worth having.
                    console.error(
                        `Could not make a thumbnail for ${entry.name}:`,
                        err.message
                    );
                }
            }

            // ------------------------------------------------------
            // The write.
            // ------------------------------------------------------

            const added = [];
            const existing = [];

            const write = db.transaction(() => {

                for (const entry of prepared) {

                    const { storedFile, createdBlobPath } = storeOne({
                        sha256: entry.sha256,
                        tempPath: entry.file.path,
                        size: entry.file.size,
                        mimeType: entry.file.mimetype
                    });

                    if (createdBlobPath) createdBlobs.push(createdBlobPath);

                    // ----------------------------------------------
                    // Already in the library.
                    //
                    // UNIQUE (stored_file_id) makes this true by
                    // construction rather than by this check: the
                    // same content CANNOT produce two items. So
                    // there is nothing to add — the honest answer
                    // is that it is already here, and the caller
                    // is told so rather than being given a
                    // duplicate or an error.
                    // ----------------------------------------------

                    const known = itemByStoredFile.get(storedFile.id);

                    if (known && known.is_active) {
                        existing.push({
                            id: known.id,
                            display_name: known.display_name,
                            original_name: entry.name
                        });
                        continue;
                    }

                    // Removed once, back now. Reusing the row keeps the
                    // item's history and avoids fighting the UNIQUE.
                    if (known) {
                        restoreItem.run(known.id);

                        added.push({
                            id: known.id,
                            display_name: known.display_name,
                            original_name: entry.name,
                            restored: true
                        });

                        continue;
                    }

                    const result = insertItem.run(
                        storedFile.id,
                        entry.name,
                        entry.name,
                        entry.verdict.outcome === 'contradicted'
                            ? 'contradicted'
                            : entry.verdict.outcome === 'confirmed'
                                ? 'confirmed'
                                : 'unverifiable',
                        actorId
                    );

                    const itemId = result.lastInsertRowid;

                    if (entry.thumbnail) {
                        upsertThumbnail.run(
                            storedFile.id,
                            entry.thumbnail.kind,
                            entry.sha256,
                            entry.thumbnail.width,
                            entry.thumbnail.height
                        );
                    }

                    added.push({
                        id: itemId,
                        display_name: entry.name,
                        original_name: entry.name
                    });

                    audit.record(
                        actorId,
                        'library.add',
                        entry.name,
                        {
                            library_item_id: itemId,
                            sha256: entry.sha256,
                            file_size: entry.file.size,
                            content_state: entry.verdict.outcome,
                            thumbnail: Boolean(entry.thumbnail)
                        }
                    );
                }
            });

            write();

            await cleanUpTemp();

            return res.status(201).json({
                added,
                existing,
                refused
            });

        } catch (err) {
            console.error('Library upload error:', err);

            // Both kinds of created file go, in the reverse order to the one
            // they were made: the transaction has already rolled back its rows.
            cleanUpCreated();
            await cleanUpTemp();

            return res.status(err.status || 400).json({
                error: err.message || 'Failed to add those files to the library',
                ...(err.details ? { details: err.details } : {})
            });
        }
    }
);

// ============================================================
// GET /api/library/:id/thumbnail
// ============================================================
//
// The cached thumbnail, or 404 — which the page reads as "show the type icon".
// A missing thumbnail is never an error worth showing anybody: it is a cache
// miss, and it is regenerated the next time that file is uploaded.
// ============================================================

router.get(
    '/:id/thumbnail',
    authenticateToken,
    requireRole(...CONTENT_READERS),

    async (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isInteger(id)) {
            return res.status(400).json({ error: 'Invalid library item ID' });
        }

        try {
            const item = itemForServing.get(id);

            if (!item) {
                return res.status(404).json({ error: 'Library item not found' });
            }

            const kind = req.query.kind === 'video_frame' || req.query.kind === 'model_preview'
                ? String(req.query.kind)
                : 'image';

            const thumb = thumbForServing.get(id, kind);

            if (!thumb) {
                return res.status(404).json({ error: 'No thumbnail for this item' });
            }

            const thumbnailPath = thumbPath(thumb.storage_key, thumb.kind);

            if (!thumbnailPath || !fs.existsSync(thumbnailPath)) {
                return res.status(404).json({ error: 'No thumbnail for this item' });
            }

            // A thumbnail we generated, so the type is known rather than
            // guessed — unlike the content route below.
            res.type('image/webp');

            return fs.createReadStream(thumbnailPath).pipe(res);

        } catch (err) {
            console.error('Could not serve a library thumbnail:', err);

            return res.status(500).json({
                error: 'Could not serve that thumbnail'
            });
        }
    }
);

// ============================================================
// GET /api/library/:id/content
// ============================================================
//
// The file itself.
//
// SERVED AS application/octet-stream, NEVER the stored mime_type — the same
// decision the workspace download route makes, and for the same reason: the
// mime_type column is whatever the uploading browser claimed, and a browser that
// claims text/html for something it made up is how a file becomes a script. The
// type is a hint for display; the download is bytes.
// ============================================================

router.get(
    '/:id/content',
    authenticateToken,
    requireRole(...CONTENT_READERS),

    async (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isInteger(id)) {
            return res.status(400).json({ error: 'Invalid library item ID' });
        }

        try {
            const item = itemForServing.get(id);

            if (!item) {
                return res.status(404).json({ error: 'Library item not found' });
            }

            // blobPath() refuses a key that is not a plain SHA-256, so a null is
            // a corrupt row rather than a bad request.
            const absolutePath = blobPath(item.storage_key);

            if (!absolutePath || !fs.existsSync(absolutePath)) {
                return res.status(404).json({
                    error: 'The stored file is missing from the store'
                });
            }

            res.type('application/octet-stream');
            res.setHeader('Content-Length', String(item.file_size));

            return fs.createReadStream(absolutePath).pipe(res);

        } catch (err) {
            console.error('Could not serve a library file:', err);

            return res.status(500).json({
                error: 'Could not serve that file'
            });
        }
    }
);

// ============================================================
// POST /api/library/:id/update
// ============================================================
//
// THE LABELLING STEP. A name, a note, and what the thing depicts.
//
// ALL THREE ARE OPTIONAL EXCEPT THE NAME, and they are sent together rather than
// one at a time: the page holds the whole edit and saves it, so a partial write
// would be a state the form never showed anybody.
//
// TAGS ARE REPLACED, NOT MERGED. The form shows every tag an item has, so what
// comes back is the whole set the person chose — merging would make a tag
// impossible to remove.
// ============================================================

router.post(
    '/:id/update',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const id = Number(req.params.id);
        const actorId = req.user?.id;

        if (!Number.isInteger(id)) {
            return res.status(400).json({ error: 'Invalid library item ID' });
        }

        if (!actorId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        const displayName = String(req.body?.display_name ?? '').trim();
        const note = String(req.body?.note ?? '').trim();

        // An item with no name is unfindable, which is the one thing a library
        // cannot afford. The ORIGINAL filename is always kept regardless, so
        // nothing is lost by insisting on this.
        if (!displayName) {
            return res.status(422).json({
                error: 'An item needs a name.'
            });
        }

        const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : [];

        // Deduplicated AFTER normalising, so "Trees" and "trees" sent together
        // become one tag rather than fighting over the UNIQUE.
        //
        // SORTED, so that this response and the listing agree about the order.
        // The listing reads tags back with ORDER BY tag — that is the canonical
        // order, because a set of badges that reshuffles is worse than one that
        // does not — and returning them in submission order here would mean a
        // client seeing two different answers to the same question.
        const tags = [...new Set(rawTags.map(normaliseTag).filter(Boolean))]
            .sort()
            .slice(0, MAX_TAGS);

        try {
            const item = itemForServing.get(id);

            if (!item) {
                return res.status(404).json({ error: 'Library item not found' });
            }

            const save = db.transaction(() => {
                updateItem.run(displayName, note || null, id);

                clearTags.run(id);

                for (const tag of tags) addTag.run(id, tag);

                audit.record(actorId, 'library.update', displayName, {
                    library_item_id: id,
                    from: item.display_name,
                    to: displayName,
                    tags
                });
            });

            save();

            return res.json({
                status: 'updated',
                id,
                display_name: displayName,
                note: note || null,
                tags
            });

        } catch (err) {
            console.error('Could not update a library item:', err);

            return res.status(500).json({
                error: 'Could not save those changes'
            });
        }
    }
);

// ============================================================
// POST /api/library/:id/remove
// ============================================================
//
// SOFT DELETE. The item stops being listed and stops protecting its blob, so the
// collector can free the bytes — but the row survives to say it was there, which
// is the same arrangement the workspace bin uses.
//
// POST rather than DELETE, following the house verb for mutations.
// ============================================================

router.post(
    '/:id/remove',
    authenticateToken,
    requireRole('developer', 'admin'),

    async (req, res) => {
        const id = Number(req.params.id);
        const actorId = req.user?.id;

        if (!Number.isInteger(id)) {
            return res.status(400).json({ error: 'Invalid library item ID' });
        }

        if (!actorId) {
            return res.status(401).json({
                error: 'Authenticated user ID not found'
            });
        }

        try {
            const item = itemForServing.get(id);

            if (!item) {
                return res.status(404).json({ error: 'Library item not found' });
            }

            const remove = db.transaction(() => {
                softDelete.run(id);

                audit.record(actorId, 'library.remove', item.display_name, {
                    library_item_id: id,
                    sha256: item.sha256
                });
            });

            remove();

            return res.json({ status: 'removed', id });

        } catch (err) {
            console.error('Could not remove a library item:', err);

            return res.status(500).json({
                error: 'Could not remove that item'
            });
        }
    }
);

module.exports = router;
