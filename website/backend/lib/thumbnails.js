// backend/lib/thumbnails.js
//
// PREVIEWS — a small picture of a file, so somebody can judge it without
// opening it, downloading it, or having the program that made it.
//
// ============================================================
// WHY THIS EXISTS, IN THE SPEC'S OWN WORDS
// ============================================================
//
// docs/assettypes01 §1 B:
//
//     "Preview — seeing the asset on the website, so an approver can judge it
//      without downloading."
//
// AND THAT IS THE AUDIENCE EXACTLY. Production decides approvals and does not
// have Blender, Nuke or Unreal — so a download is useless to them even when
// they are allowed one. They need to LOOK, and the portal has to do the looking.
//
// ============================================================
// EXTRACTED, NOT COPIED
// ============================================================
//
// The library had the only implementation, inline in its route, so the first
// temptation was to copy it for the store. That is item 84's failure with a
// picture attached: two copies that agree today and disagree the first time a
// JPEG fails differently, or the size changes in one place.
//
// So there is ONE function, here, and both spaces call it.
//
// ============================================================
// DERIVED CONTENT, AND NOT THE STORE
// ============================================================
//
// A preview is produced FROM a blob, the way a build is produced from a
// project. It gets no stored_files row, it is not counted against any quota,
// and it is never collected as if it were authored content — see the note on
// THUMB_DIR in storagePaths.js. DELETING EVERY PREVIEW COSTS REGENERATION, NOT
// DATA.
//
// AND THE FILENAME IS DERIVABLE: <sha>_<kind>.webp, built by thumbPath(). There
// is therefore no ambiguity about where a preview lives, which is what lets the
// table below be a CACHE of what has been made rather than the source of truth
// about it.

const { execFile } = require('child_process');
const { promisify } = require('util');

const sharp = require('sharp');

const { thumbPath } = require('./storagePaths');
const { assetTypeOf } = require('../../shared/assetRules.mjs');

const run = promisify(execFile);

// Big enough to judge a texture by, small enough that a page of them is cheap.
const THUMB_SIZE = 320;

// ---------------------------------------------------------------------------
// Which kinds of file get one
// ---------------------------------------------------------------------------

/**
 * The kind of preview a file gets, or null if it gets none.
 *
 * FROM THE SHARED RULES, not from a second extension list here. assetTypeOf()
 * is the one classifier in the project, and a private copy of "what counts as
 * an image" is how two answers start.
 *
 * 'model_preview' IS IN THE SCHEMA AND NOT HERE. A 3D preview needs a renderer —
 * Blender or Unreal, run headless — and that does not exist. Returning a kind
 * for it would produce rows with no picture behind them.
 */
function previewKindOf(filename) {
    const type = assetTypeOf(filename);

    if (type === 'Image') return 'image';
    if (type === 'Video') return 'video_frame';

    return null;
}

// ---------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------

/**
 * A preview of `sourcePath`, written to THUMB_DIR, or null.
 *
 * Returns { createdPath, width, height } or null when the file yields no
 * picture. NULL IS NOT AN ERROR: a damaged image, a video with no decodable
 * frame, or a kind we do not do all arrive here, and none of them is a reason
 * to fail the upload that brought the file.
 */
async function makePreview(sourcePath, storageKey, kind) {
    const destination = thumbPath(storageKey, kind);

    if (!destination) return null;

    if (kind === 'image') {
        try {
            return await toWebp(sourcePath, destination, kind);

        } catch (err) {
            // SHARP CANNOT DECODE EVERY IMAGE THE SYSTEM CALLS AN IMAGE. TGA and
            // EXR are ordinary texture and render formats in game art, and this
            // build of libvips reads neither — so the first attempt would throw
            // and the artist would get no picture for the most common kinds of
            // file they send.
            //
            // FFMPEG CAN READ BOTH, and the frame path the videos already use
            // is exactly the right tool: one still decoded to PNG, then the
            // same resize. The fallback is not a second preview system; it is
            // the same one, reaching the formats sharp cannot.
            // A STILL HAS NO SECOND TO SEEK TO: `-ss` before `-i` makes ffmpeg
            // discard the only frame an image demuxer has, so the fallback asks
            // for the picture without a seek. A video is a different question
            // and keeps the 1s-then-0s rule below.
            const frame = await firstFrame(sourcePath, [null]);

            // Nothing read it. Throw the ORIGINAL error rather than returning
            // null, so the caller logs the format that actually failed.
            if (!frame) throw err;

            return await toWebp(frame, destination, kind);
        }
    }

    if (kind === 'video_frame') {
        const frame = await firstFrame(sourcePath);

        if (!frame) return null;

        return await toWebp(frame, destination, kind);
    }

    return null;
}

/**
 * The one place a picture is resized, encoded and written.
 *
 * BOTH KINDS GO THROUGH HERE, so an image preview and a video poster are the
 * same format, the same size and the same code path. `rotate()` with no
 * argument applies EXIF orientation, so a photograph taken sideways appears the
 * right way up, and does nothing to a buffer that has no EXIF — which is every
 * frame ffmpeg hands over. `failOn: 'none'` lets a slightly damaged file yield
 * a picture rather than throwing; for a thumbnail that is the right trade.
 */
async function toWebp(input, destination, kind) {
    const info = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, {
            fit: 'inside',
            withoutEnlargement: true
        })
        .webp({ quality: 80 })
        .toFile(destination);

    return { kind, createdPath: destination, width: info.width, height: info.height };
}

/**
 * One frame of a video, as a PNG buffer, or null.
 *
 * A SECOND IN, because the first frame of a video is very often black — a fade,
 * a slate, or the encoder's first keyframe. Falling back to the very start
 * covers clips shorter than that, which would otherwise have no frame at or
 * after one second and produce nothing.
 *
 * `offsets` also serves the still-image fallback in makePreview(), which passes
 * [null] — no seek at all. `-ss` placed before `-i` drops a still's only frame,
 * so a seek is wrong for anything that is not a moving picture.
 */
async function firstFrame(sourcePath, offsets = ['1', '0']) {
    for (const offset of offsets) {
        const seek = offset === null ? [] : ['-ss', offset];

        try {
            const { stdout } = await run(
                'ffmpeg',
                [
                    '-v', 'error',
                    ...seek,
                    '-i', sourcePath,
                    '-frames:v', '1',
                    '-f', 'image2',
                    '-vcodec', 'png',
                    'pipe:1'
                ],
                {
                    encoding: 'buffer',
                    maxBuffer: 64 * 1024 * 1024,
                    // A TIME LIMIT, because this reads a file the studio did
                    // not write. ffmpeg on a malformed container can loop for
                    // as long as nobody stops it; the preview is worth ten
                    // seconds and not a wedged upload. On timeout execFile
                    // kills the child and rejects, which lands in the catch
                    // below — no preview, and the upload is unaffected.
                    timeout: 15000
                }
            );

            if (stdout && stdout.length > 0) return stdout;

        } catch {
            // No frame at this offset, or ffmpeg is not available. Either way
            // the next offset is worth trying, and then there is no preview.
        }
    }

    return null;
}

module.exports = { makePreview, previewKindOf, THUMB_SIZE };
