// backend/lib/assetArchive.js
//
// A VERSION'S FILES AS A ZIP, PLUS A MANIFEST SAYING WHAT THEY ARE.
//
// ============================================================
// THIS IS docs/assettypes01 §5B, WHICH WAS ALREADY SPECIFIED
// ============================================================
//
//   "ZIP preserving relative_path (which exists in the schema for exactly this)
//    plus a JSON manifest: per-file SHA-256, size, and target path. The approver
//    has a working copy of the game, so files must land in the right places."
//
// AND THE SPEC'S SECURITY NOTES ARE FOLLOWED HERE RATHER THAN REDISCOVERED:
//
//   * relative_path is RE-VALIDATED AT ZIP TIME. It was normalised on upload,
//     but it originated client-side and is now being used to build ENTRY NAMES —
//     which is the moment a '../' stops being a filename and starts being a
//     path out of the archive.
//   * the manifest carries SHA-256 and size, so what arrives can be checked
//     rather than trusted.
//
// ============================================================
// WHY THE ENTRIES ARE STORED AND NOT DEFLATED
// ============================================================
//
// GAME ASSETS ARE ALREADY COMPRESSED. A PNG, a JPEG, a .blend, a .uasset — none
// of them gets smaller, and deflating them costs CPU to produce a file the same
// size. So entries are written STORED (method 0).
//
// WHICH ALSO REMOVES THE WHOLE COMPRESSION PLUMBING, and with it the class of
// bug where an archive unzips to something subtly different from what went in.
// The only parts left are CRC-32, which detects exactly that, and the headers.
//
// ============================================================
// AND WHY IT STREAMS
// ============================================================
//
// A version can be hundreds of megabytes. Building the archive in memory would
// mean holding all of it at once, on a server that is also serving everybody
// else — so this is a Readable that yields the archive as it goes, holding ONE
// FILE at a time rather than all of them.

const fs = require('fs');
const { Readable } = require('stream');

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------
//
// The checksum a ZIP entry carries, and the only thing in the format that
// notices a byte changing on the way. Node has it in zlib, whose implementation
// is the same table below — one definition, from the platform, rather than a
// hand-rolled one that could be subtly wrong.
const zlib = require('zlib');

// The version's content identity. Same inputs as the value stored on
// asset_versions, so the two agreeing is a property of the code rather than of
// everybody remembering.
const { manifestHash: computeManifestHash } = require('./manifestHash');

// ---------------------------------------------------------------------------
// Paths inside the archive
// ---------------------------------------------------------------------------

/**
 * A relative_path turned into a safe ZIP entry name, or null if it cannot be.
 *
 * NULL RATHER THAN A SANITISED PATH. A path that had to be cleaned up is a path
 * that meant something else, and quietly rewriting it would put a file
 * somewhere other than where the schema says it goes. The caller refuses.
 */
function entryNameFor(relativePath, filename, stripRoot = null) {
    const parts = [relativePath, filename]
        .filter(part => part !== null && part !== undefined && String(part) !== '')
        .map(part => String(part).replace(/\\/g, '/'));

    if (parts.length === 0) return null;

    let segments = parts.join('/').split('/').filter(s => s !== '');

    // THE CONTAINER FOLDER, REMOVED WHEN THE CALLER KNOWS WHERE THESE ARE GOING.
    //
    // The full archive keeps it — a zip is a standalone thing and unzipping it
    // into a parent should produce the folder. A PARTIAL archive does not,
    // because the developer has just chosen the folder these belong in: entries
    // relative to it are what "unzip here" means.
    //
    // ONLY THE FIRST SEGMENT, and only if it IS the root. The rest is the tree,
    // and the tree is load-bearing (item 56).
    if (stripRoot && segments.length > 1 && segments[0] === stripRoot) {
        segments = segments.slice(1);
    }

    // Anything that could climb out, or that is absolute, or that is a drive
    // letter, is refused rather than repaired.
    for (const segment of segments) {
        if (segment === '.' || segment === '..') return null;
        if (segment.includes('\0')) return null;
    }

    if (/^[A-Za-z]:/.test(segments[0])) return null;
    if (parts.join('/').startsWith('/')) return null;

    return segments.join('/');
}

// ---------------------------------------------------------------------------
// The ZIP
// ---------------------------------------------------------------------------

// MS-DOS time and date, which is what a ZIP stores. The value is close to
// meaningless for our purposes — the files' real times are in the manifest — but
// the fields have to be present and legal, and a fixed stamp makes two archives
// of the same version byte-identical apart from the content, which is worth
// having.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;  // 2026-01-01
const DOS_TIME = 0;

function localHeader(name, crc, size) {
    const nameBuf = Buffer.from(name, 'utf8');

    const header = Buffer.alloc(30);

    header.writeUInt32LE(0x04034b50, 0);   // local file header signature
    header.writeUInt16LE(20, 4);           // version needed to extract: 2.0
    header.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filenames
    header.writeUInt16LE(0, 8);            // method: 0 = stored
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);        // compressed size   (stored: equal)
    header.writeUInt32LE(size, 22);        // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);           // extra field length

    return Buffer.concat([header, nameBuf]);
}

function centralHeader(entry) {
    const nameBuf = Buffer.from(entry.name, 'utf8');

    const header = Buffer.alloc(46);

    header.writeUInt32LE(0x02014b50, 0);   // central file header signature
    header.writeUInt16LE(20, 4);           // version made by
    header.writeUInt16LE(20, 6);           // version needed to extract
    header.writeUInt16LE(0x0800, 8);       // flags: UTF-8 filenames
    header.writeUInt16LE(0, 10);           // method: stored
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);           // extra field length
    header.writeUInt16LE(0, 32);           // comment length
    header.writeUInt16LE(0, 34);           // disk number start
    header.writeUInt16LE(0, 36);           // internal attributes
    header.writeUInt32LE(0o644 << 16, 38); // external attributes: a plain file
    header.writeUInt32LE(entry.offset, 42); // offset of the local header

    return Buffer.concat([header, nameBuf]);
}

function endOfCentralDirectory(count, size, offset) {
    const end = Buffer.alloc(22);

    end.writeUInt32LE(0x06054b50, 0);      // end of central directory
    end.writeUInt16LE(0, 4);               // this disk
    end.writeUInt16LE(0, 6);               // disk with the central directory
    end.writeUInt16LE(count, 8);           // entries on this disk
    end.writeUInt16LE(count, 10);          // entries in total
    end.writeUInt32LE(size, 12);           // size of the central directory
    end.writeUInt32LE(offset, 16);         // where it starts
    end.writeUInt16LE(0, 20);              // comment length

    return end;
}

/**
 * Build a version's files as a ZIP, as a stream.
 *
 * @param {Array} files  { absolutePath, relative_path, filename, sha256, file_size }
 * @returns {{ stream: Readable, manifest: object, refused: Array }}
 *
 * REFUSALS ARE RETURNED RATHER THAN THROWN, and the caller decides. A file whose
 * path cannot be made safe is a fact about that version, not a reason to fail
 * the request — but it must not be silently dropped either.
 */
function buildVersionArchive(files, {
    assetName,
    versionNumber,
    stripRoot = null,
    manifestHash = null,
    unknown = []
} = {}) {

    const refused = [];
    const entries = [];
    let offset = 0;

    // Everything except the bytes is settled BEFORE the stream starts, so a
    // refusal is known before a single byte of response has been sent. A
    // response that turns out to be an error halfway through is worse than one
    // that never starts.
    const planned = [];

    for (const file of files) {
        const name = entryNameFor(file.relative_path, file.filename, stripRoot);

        if (!name) {
            refused.push({
                filename: file.filename,
                relative_path: file.relative_path,
                reason: 'its path could not be made safe inside an archive'
            });
            continue;
        }

        planned.push({ file, name });
    }

    const manifest = {
        // NAMED IN FULL, BECAUSE `asset` AND `version` ARE AMBIGUOUS AND COLLIDED.
        // An API response wrapping this manifest also has an `asset` and a
        // `version` — objects, with ids and names in them — and spreading the
        // manifest over them silently replaced both with a string and a number,
        // so `manifest.asset.name` was undefined and nothing said why.
        //
        // `asset_name` and `version_number` cannot mean two things. AND THE
        // FORMAT IS BETTER FOR IT: "asset": "bigTree" never said whether it was
        // a name or a thing.
        asset_name: assetName ?? null,
        version_number: versionNumber ?? null,

        // THE VERSION'S CONTENT IDENTITY — always, whatever this archive
        // holds. Computed from the ORIGINAL relative_path and filename, NOT
        // from the entry names above, because the entry names have the
        // container folder stripped for the download while the version's
        // identity does not.
        //
        // THE CALLER SUPPLIES IT when it has it, so the value here is the same
        // one stored on the version rather than an independent recomputation
        // that could disagree. When it is not supplied — an archive built from
        // a bare list of files — it is computed from those files.
        manifest_hash: manifestHash || computeManifestHash(planned.map(({ file }) => ({
            relative_path: file.relative_path,
            filename: file.filename,
            sha256: file.sha256,
            size: file.file_size
        }))),

        // THE IDENTITY OF WHAT IS ACTUALLY IN THIS ZIP.
        //
        // A VERSION HAS ONE HASH AND A ZIP MAY HOLD ONLY PART OF IT. The
        // negotiation routinely sends a developer only the files they lack, so
        // an archive is often a subset. manifest_hash names the VERSION and
        // never changes with that; this names the delivery.
        //
        // THE TWO ARE COMPUTED THE SAME WAY over the same canonical paths, so
        // they are directly comparable and no separate flag is needed:
        //
        //     archive_hash === manifest_hash   this zip is the whole version
        //     they differ                      it is a subset
        //
        // A receiver can hash what they unpacked and check this. Checking
        // manifest_hash instead would fail on every partial download, which is
        // exactly the trap a single hash set.
        archive_hash: computeManifestHash(planned.map(({ file }) => ({
            relative_path: file.relative_path,
            filename: file.filename,
            sha256: file.sha256,
            size: file.file_size
        }))),

        generated_at: new Date().toISOString(),
        // WHAT THE RECEIVER SHOULD END UP WITH. The paths are relative to the
        // project root the developer unpacks into, which is what §5B means by
        // "files must land in the right places". The ZIP is flat-ish and the
        // MANIFEST is what says where things go, so a developer can check an
        // archive without unpacking it.
        // HASHES THE CALLER ASKED FOR THAT ARE NOT IN THIS VERSION.
        //
        // THE CALLER'S OWN LIST IS THE ONLY PLACE THIS IS KNOWN, which is why
        // it arrives as an argument rather than being derived here. A client
        // working from a manifest it fetched a moment ago can be slightly out
        // of date; the download goes ahead with what it can, and this says what
        // was left out — otherwise the subset is silently incomplete and the
        // receiver has no way to tell a stale manifest from a corrupt one.
        unknown: (unknown || []).map(String),

        files: planned.map(({ file, name }) => ({
            path: name,
            sha256: file.sha256,
            size: file.file_size,
            // The name it had in the version, which can differ from the path it
            // sits at — a file renamed on upload keeps both.
            filename: file.filename,
            relative_path: file.relative_path ?? null
        })),
        total_bytes: planned.reduce((sum, { file }) => sum + (file.file_size || 0), 0),
        refused
    };

    async function* generate() {
        // The manifest FIRST, so it is the first thing anybody sees when they
        // open the archive and it is readable without unpacking anything else.
        const manifestBuf = Buffer.from(
            JSON.stringify(manifest, null, 2), 'utf8'
        );
        const manifestCrc = zlib.crc32(manifestBuf);

        yield localHeader('manifest.json', manifestCrc, manifestBuf.length);
        yield manifestBuf;

        entries.push({
            name: 'manifest.json',
            crc: manifestCrc,
            size: manifestBuf.length,
            offset
        });
        offset += 30 + Buffer.byteLength('manifest.json') + manifestBuf.length;

        for (const { file, name } of planned) {
            // ONE FILE IN MEMORY AT A TIME. `zlib.crc32` needs the whole buffer,
            // and the header needs the CRC before the data — so the alternative
            // is a data descriptor, which is more moving parts for a saving that
            // only matters on files far larger than an asset version.
            const data = await fs.promises.readFile(file.absolutePath);
            const crc = zlib.crc32(data);

            const header = localHeader(name, crc, data.length);

            yield header;
            yield data;

            entries.push({ name, crc, size: data.length, offset });
            offset += header.length + data.length;
        }

        const centralOffset = offset;

        let centralSize = 0;
        for (const entry of entries) {
            const header = centralHeader(entry);
            centralSize += header.length;
            yield header;
        }

        yield endOfCentralDirectory(entries.length, centralSize, centralOffset);
    }

    return { stream: Readable.from(generate()), manifest, refused };
}

module.exports = { buildVersionArchive, entryNameFor };
