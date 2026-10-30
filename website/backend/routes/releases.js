// backend/routes/releases.js
//
// NAMED GAME RELEASES, AND WHICH APPROVED VERSIONS ARE IN THEM.
//
// ============================================================
// THE QUESTION THIS ANSWERS
// ============================================================
//
// "This asset is approved. Which version of the game does it go into — and
// what is already in that version?" Until this existed, an admin could record
// a changelist against a store version (asset_integrations) and nothing could
// say which build it belonged to, or show what a build was made of.
//
// A RELEASE IS A NAME AND A DATE — "0.4 Experimental, 12 Nov" — not a channel.
// Item 53 settled that: a channel holds one value and a release has a history.
//
// ============================================================
// AND THE LIST OF CANDIDATES
// ============================================================
//
// A CANDIDATE IS AN APPROVED STORE VERSION THAT IS NOT IN THIS RELEASE. That
// is the admin's queue: everything the studio has approved, minus what this
// build already contains. A version that is in ANOTHER release is still a
// candidate here — the same version can ship in several builds — and the list
// says so, so "already in 0.3" is visible rather than discovered.
//
// ============================================================
// ADMIN, NOT PROD
// ============================================================
//
// Putting content into the game is engineering: it moves files and commits
// them (item 52's own test). Production decides what is GOOD; the admin puts
// it in and records where. The same split as asset_integrations.
//
// ============================================================
// ONE VERSION PER ASSET PER RELEASE
// ============================================================
//
// You cannot ship two versions of BigTree in one build. That rule is about the
// ASSET, and release_assets only knows asset_version_id — so it is enforced
// here, by name, rather than by a constraint that cannot see the asset.
// ============================================================

const express = require('express');

const db = require('../db');
const audit = require('../lib/audit');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

// `?` is the CALLER'S USER ID: how much of this release is their own work.
// It is the difference between "which builds exist" and "which of my assets
// have been accepted, and into what" — the question a developer asks.
const listReleases = db.prepare(`
    SELECT
        r.id, r.name, r.released_on, r.changelist, r.notes,
        r.created_at,
        u.username AS created_by_username,
        (SELECT COUNT(*) FROM release_assets ra WHERE ra.release_id = r.id)
            AS asset_count,
        (SELECT COUNT(*)
           FROM release_assets ra
           JOIN asset_versions av ON av.id = ra.asset_version_id
          WHERE ra.release_id = r.id
            AND av.uploaded_by = ?) AS mine_count
    FROM releases r
    LEFT JOIN users u ON u.id = r.created_by
    ORDER BY r.id DESC
`);

const releaseById = db.prepare(`
    SELECT r.*, u.username AS created_by_username
    FROM releases r
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.id = ?
`);

// WHAT THIS RELEASE HOLDS. The approval is joined because the useful line for
// an admin is not "BigTree v3" but "BigTree v3, approved by prod on the 12th".
const membersOf = db.prepare(`
    SELECT
        av.id           AS asset_version_id,
        av.version_number,
        a.id            AS asset_id,
        a.name          AS asset_name,
        ca.decided_at,
        u.username      AS approved_by,
        wu.username     AS uploaded_by,
        (SELECT MAX(ai.changelist) FROM asset_integrations ai
          WHERE ai.asset_version_id = av.id) AS changelist
    FROM release_assets ra
    JOIN asset_versions av ON av.id = ra.asset_version_id
    JOIN assets a ON a.id = av.asset_id
    LEFT JOIN creative_approvals ca
        ON ca.repository_version_id = av.id AND ca.status = 'approved'
    LEFT JOIN users u ON u.id = ca.decided_by
    -- WHO AUTHORED IT, from the store version itself since 2026-10-30. It
    -- used to be a link back through the approval to the workspace version;
    -- the column is recorded at approval, so the join is direct.
    LEFT JOIN users wu ON wu.id = av.uploaded_by
    WHERE ra.release_id = ?
    ORDER BY a.name COLLATE NOCASE, av.version_number
`);

// THE QUEUE: approved versions this release does not hold yet. in_other_release
// says whether it already ships in another build, which is information, not an
// obstacle.
const candidatesFor = db.prepare(`
    SELECT
        av.id           AS asset_version_id,
        av.version_number,
        a.id            AS asset_id,
        a.name          AS asset_name,
        ca.decided_at,
        u.username      AS approved_by,
        wu.username     AS uploaded_by,
        EXISTS (
            SELECT 1 FROM release_assets x
            WHERE x.asset_version_id = av.id
        ) AS in_other_release
    FROM asset_versions av
    JOIN assets a ON a.id = av.asset_id AND a.is_active = 1
    JOIN creative_approvals ca
        ON ca.repository_version_id = av.id AND ca.status = 'approved'
    LEFT JOIN users u ON u.id = ca.decided_by
    LEFT JOIN users wu ON wu.id = av.uploaded_by
    WHERE NOT EXISTS (
        SELECT 1 FROM release_assets r2
        WHERE r2.release_id = ? AND r2.asset_version_id = av.id
    )
    ORDER BY a.name COLLATE NOCASE, av.version_number
`);

const versionInStore = db.prepare(`
    SELECT av.id, av.version_number, a.id AS asset_id, a.name AS asset_name
    FROM asset_versions av
    JOIN assets a ON a.id = av.asset_id AND a.is_active = 1
    WHERE av.id = ?
`);

// What else of this ASSET is already in the release — the one-version rule.
const otherVersionOfAssetInRelease = db.prepare(`
    SELECT av.id AS asset_version_id, av.version_number
    FROM release_assets ra
    JOIN asset_versions av ON av.id = ra.asset_version_id
    WHERE ra.release_id = ? AND av.asset_id = ?
`);

const filesOfVersion = db.prepare(`
    SELECT avf.relative_path, avf.filename, sf.sha256, sf.file_size
    FROM asset_version_files avf
    JOIN stored_files sf ON sf.id = avf.stored_file_id
    WHERE avf.asset_version_id = ?
    ORDER BY avf.relative_path, avf.filename
`);

const insertRelease = db.prepare(`
    INSERT INTO releases (name, released_on, changelist, notes, created_by)
    VALUES (?, ?, ?, ?, ?)
`);

const insertMembership = db.prepare(`
    INSERT INTO release_assets (release_id, asset_version_id, added_by)
    VALUES (?, ?, ?)
`);

// Deleting a release takes its membership with it (ON DELETE CASCADE on
// release_assets). The assets are untouched: a release is a statement about a
// build, not a copy of anything.
const deleteRelease = db.prepare('DELETE FROM releases WHERE id = ?');

const deleteMembership = db.prepare(`
    DELETE FROM release_assets WHERE release_id = ? AND asset_version_id = ?
`);

const recordIntegration = db.prepare(`
    INSERT INTO asset_integrations (asset_version_id, changelist, note, integrated_by)
    VALUES (?, ?, ?, ?)
`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detailOf(releaseId) {
    const release = releaseById.get(releaseId);

    if (!release) return null;

    return {
        release: {
            id: release.id,
            name: release.name,
            released_on: release.released_on,
            changelist: release.changelist,
            notes: release.notes,
            created_by: release.created_by_username,
            created_at: release.created_at
        },
        members: membersOf.all(releaseId).map(row => ({
            asset_version_id: row.asset_version_id,
            version_number: row.version_number,
            asset_id: row.asset_id,
            asset_name: row.asset_name,
            approved_by: row.approved_by,
            uploaded_by: row.uploaded_by,
            decided_at: row.decided_at,
            changelist: row.changelist
        })),
        candidates: candidatesFor.all(releaseId).map(row => ({
            asset_version_id: row.asset_version_id,
            version_number: row.version_number,
            asset_id: row.asset_id,
            asset_name: row.asset_name,
            approved_by: row.approved_by,
            uploaded_by: row.uploaded_by,
            decided_at: row.decided_at,
            in_other_release: Boolean(row.in_other_release)
        }))
    };
}

const isPositiveInteger = value => Number.isInteger(value) && value >= 1;

// ---------------------------------------------------------------------------
// GET /api/releases — every named release, newest first
// ---------------------------------------------------------------------------

// READ BY DEVELOPERS AND BY PRODUCTION. "Which of my assets were accepted, and
// into which release" is a developer's question; "what is actually shipping"
// is production's — a reviewer deciding what is good should be able to see
// where the good work ended up. WRITES BELOW STAY ADMIN: putting content into
// the game is engineering.
router.get('/', authenticateToken, requireRole('developer', 'prod', 'admin'), (req, res) => {
    return res.json({ releases: listReleases.all(req.user.id) });
});

// ---------------------------------------------------------------------------
// POST /api/releases — name it
// ---------------------------------------------------------------------------

router.post('/', authenticateToken, requireRole('admin'), (req, res) => {
    const actor = req.user?.id;

    if (!actor) return res.status(401).json({ error: 'Authenticated user ID not found' });

    const name = String(req.body?.name || '').trim();

    if (!name) {
        return res.status(400).json({ error: 'A release needs a name — "0.4 Experimental, 12 Nov".' });
    }

    if (name.length > 120) {
        return res.status(400).json({ error: 'That name is too long — 120 characters at most.' });
    }

    // OPTIONAL, AND VALIDATED WHEN PRESENT. A release may be planned before it
    // has a date; a date that is present must be one.
    const releasedOn = String(req.body?.released_on || '').trim() || null;

    if (releasedOn && !/^\d{4}-\d{2}-\d{2}$/.test(releasedOn)) {
        return res.status(400).json({ error: 'released_on must be YYYY-MM-DD.' });
    }

    // THE BUILD'S CHANGELIST, WHEN KNOWN. An assertion, like asset_integrations.
    const rawChangelist = req.body?.changelist;

    let changelist = null;

    if (rawChangelist !== undefined && rawChangelist !== null && rawChangelist !== '') {
        changelist = Number(rawChangelist);

        if (!isPositiveInteger(changelist)) {
            return res.status(400).json({
                error: 'changelist must be a positive integer — the Perforce changelist number.'
            });
        }
    }

    const notes = String(req.body?.notes || '').trim() || null;

    try {
        const result = insertRelease.run(name, releasedOn, changelist, notes, actor);

        audit.record(actor, 'release.create', name, {
            release_id: result.lastInsertRowid,
            released_on: releasedOn,
            changelist
        });

        return res.status(201).json(detailOf(result.lastInsertRowid));

    } catch (err) {
        if (/UNIQUE/i.test(err.message)) {
            return res.status(409).json({
                error: `A release called "${name}" already exists.`
            });
        }

        console.error('Could not create a release:', err);
        return res.status(500).json({ error: 'Could not create that release' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/releases/:id — what it holds, and what it could hold
// ---------------------------------------------------------------------------

router.get('/:id', authenticateToken, requireRole('developer', 'prod', 'admin'), (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid release ID' });

    const detail = detailOf(id);

    if (!detail) return res.status(404).json({ error: 'Release not found' });

    return res.json(detail);
});

// ---------------------------------------------------------------------------
// POST /api/releases/:id/assets — put an approved version into this release
// ---------------------------------------------------------------------------

router.post('/:id/assets', authenticateToken, requireRole('admin'), (req, res) => {
    const actor = req.user?.id;
    const releaseId = Number(req.params.id);
    const versionId = Number(req.body?.asset_version_id);

    if (!actor) return res.status(401).json({ error: 'Authenticated user ID not found' });
    if (!Number.isInteger(releaseId)) return res.status(400).json({ error: 'Invalid release ID' });
    if (!Number.isInteger(versionId)) return res.status(400).json({ error: 'Invalid asset version ID' });

    const release = releaseById.get(releaseId);

    if (!release) return res.status(404).json({ error: 'Release not found' });

    const version = versionInStore.get(versionId);

    if (!version) {
        return res.status(404).json({ error: 'That version is not in the game store' });
    }

    // One version per asset per release, and the refusal names the one in the
    // way rather than saying "conflict".
    const other = otherVersionOfAssetInRelease.get(releaseId, version.asset_id);

    if (other) {
        if (other.asset_version_id === versionId) {
            return res.status(409).json({
                error: `"${version.asset_name}" v${version.version_number} is already in ${release.name}.`
            });
        }

        return res.status(409).json({
            error: `"${version.asset_name}" is already in ${release.name} at v${other.version_number}. ` +
                   `Remove that one first — a release cannot ship two versions of the same asset.`
        });
    }

    const changelist = req.body?.changelist === undefined || req.body?.changelist === ''
        ? null
        : Number(req.body.changelist);

    if (changelist !== null && !isPositiveInteger(changelist)) {
        return res.status(400).json({
            error: 'changelist must be a positive integer — the Perforce changelist number.'
        });
    }

    const note = String(req.body?.note || '').trim() || null;

    const add = db.transaction(() => {
        insertMembership.run(releaseId, versionId, actor);

        // THE IMPORT AND THE MEMBERSHIP ARE RECORDED TOGETHER when a changelist
        // is given: the same act, so the two cannot disagree about whether this
        // version reached the game.
        if (changelist !== null) {
            recordIntegration.run(versionId, changelist, note, actor);
        }

        audit.record(actor, 'release.asset_add', version.asset_name, {
            release_id: releaseId,
            release_name: release.name,
            asset_version_id: versionId,
            version_number: version.version_number,
            changelist,
            note
        });
    });

    add();

    return res.status(201).json(detailOf(releaseId));
});

// ---------------------------------------------------------------------------
// DELETE /api/releases/:id/assets/:assetVersionId — take it back out
// ---------------------------------------------------------------------------

router.delete('/:id/assets/:assetVersionId', authenticateToken, requireRole('admin'), (req, res) => {
    const actor = req.user?.id;
    const releaseId = Number(req.params.id);
    const versionId = Number(req.params.assetVersionId);

    if (!actor) return res.status(401).json({ error: 'Authenticated user ID not found' });
    if (!Number.isInteger(releaseId) || !Number.isInteger(versionId)) {
        return res.status(400).json({ error: 'Invalid release or asset version ID' });
    }

    const release = releaseById.get(releaseId);

    if (!release) return res.status(404).json({ error: 'Release not found' });

    const version = versionInStore.get(versionId);

    const result = deleteMembership.run(releaseId, versionId);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'That version is not in this release' });
    }

    audit.record(actor, 'release.asset_remove', version?.asset_name || null, {
        release_id: releaseId,
        release_name: release.name,
        asset_version_id: versionId,
        version_number: version?.version_number ?? null
    });

    return res.json(detailOf(releaseId));
});

// ---------------------------------------------------------------------------
// DELETE /api/releases/:id — remove the release, not its content
// ---------------------------------------------------------------------------

router.delete('/:id', authenticateToken, requireRole('admin'), (req, res) => {
    const actor = req.user?.id;
    const id = Number(req.params.id);

    if (!actor) return res.status(401).json({ error: 'Authenticated user ID not found' });
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid release ID' });

    const release = releaseById.get(id);

    if (!release) return res.status(404).json({ error: 'Release not found' });

    deleteRelease.run(id);

    audit.record(actor, 'release.delete', release.name, {
        release_id: id,
        released_on: release.released_on,
        changelist: release.changelist
    });

    return res.json({ status: 'deleted', release_id: id });
});

// ---------------------------------------------------------------------------
// GET /api/releases/:id/diff?against=:otherId — what changed between builds
// ---------------------------------------------------------------------------
//
// COMPARED BY ASSET AND BY FILE, which are the two questions people ask:
// "which assets changed in 0.4" and "what changed inside BigTree".
//
//   added      an asset in this release and not in the other
//   removed    the reverse
//   changed    the same asset at a different version — and for those, the
//              files added, removed and modified by PATH AND CONTENT HASH
//   unchanged  the same version in both
//
// FILES ARE COMPARED BY HASH, not by date or size: the store is
// content-addressed, so two files with the same SHA are the same file however
// they got there, and a file that changed identity is exactly a changed hash.

const fileKey = file =>
    `${file.relative_path || ''}/${file.filename}`.replace(/^\/+/, '');

const describeFile = file => ({
    path: fileKey(file),
    sha256: file.sha256,
    size: file.file_size
});

function filesByKey(versionId) {
    return new Map(filesOfVersion.all(versionId).map(file => [fileKey(file), file]));
}

router.get('/:id/diff', authenticateToken, requireRole('developer', 'prod', 'admin'), (req, res) => {
    const toId = Number(req.params.id);
    const fromId = Number(req.query.against);

    if (!Number.isInteger(toId) || !Number.isInteger(fromId)) {
        return res.status(400).json({
            error: 'Two release IDs are needed: /api/releases/:id/diff?against=:other'
        });
    }

    const to = releaseById.get(toId);
    const from = releaseById.get(fromId);

    if (!to || !from) {
        return res.status(404).json({ error: 'Release not found' });
    }

    const toMap = new Map(membersOf.all(toId).map(m => [m.asset_id, m]));
    const fromMap = new Map(membersOf.all(fromId).map(m => [m.asset_id, m]));

    const assets = [];

    for (const assetId of new Set([...toMap.keys(), ...fromMap.keys()])) {
        const before = fromMap.get(assetId);
        const after = toMap.get(assetId);

        if (!before) {
            assets.push({
                asset_id: assetId,
                asset_name: after.asset_name,
                status: 'added',
                from_version: null,
                to_version: after.version_number,
                files: {
                    added: filesOfVersion.all(after.asset_version_id).map(describeFile),
                    removed: [],
                    changed: []
                }
            });
            continue;
        }

        if (!after) {
            assets.push({
                asset_id: assetId,
                asset_name: before.asset_name,
                status: 'removed',
                from_version: before.version_number,
                to_version: null,
                files: {
                    added: [],
                    removed: filesOfVersion.all(before.asset_version_id).map(describeFile),
                    changed: []
                }
            });
            continue;
        }

        if (before.asset_version_id === after.asset_version_id) {
            assets.push({
                asset_id: assetId,
                asset_name: after.asset_name,
                status: 'unchanged',
                from_version: before.version_number,
                to_version: after.version_number,
                files: { added: [], removed: [], changed: [] }
            });
            continue;
        }

        const oldFiles = filesByKey(before.asset_version_id);
        const newFiles = filesByKey(after.asset_version_id);

        assets.push({
            asset_id: assetId,
            asset_name: after.asset_name,
            status: 'changed',
            from_version: before.version_number,
            to_version: after.version_number,
            files: {
                added: [...newFiles.keys()]
                    .filter(key => !oldFiles.has(key))
                    .map(key => describeFile(newFiles.get(key))),

                removed: [...oldFiles.keys()]
                    .filter(key => !newFiles.has(key))
                    .map(key => describeFile(oldFiles.get(key))),

                changed: [...newFiles.keys()]
                    .filter(key => oldFiles.has(key)
                        && oldFiles.get(key).sha256 !== newFiles.get(key).sha256)
                    .map(key => ({
                        path: key,
                        from_sha256: oldFiles.get(key).sha256,
                        to_sha256: newFiles.get(key).sha256,
                        size: newFiles.get(key).file_size
                    }))
            }
        });
    }

    assets.sort((a, b) =>
        a.asset_name.localeCompare(b.asset_name, undefined, { sensitivity: 'base' }));

    const count = status => assets.filter(asset => asset.status === status).length;

    return res.json({
        from: { id: from.id, name: from.name, released_on: from.released_on },
        to: { id: to.id, name: to.name, released_on: to.released_on },
        summary: {
            added: count('added'),
            removed: count('removed'),
            changed: count('changed'),
            unchanged: count('unchanged')
        },
        assets
    });
});

module.exports = router;
