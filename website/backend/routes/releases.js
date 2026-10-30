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

const listReleases = db.prepare(`
    SELECT
        r.id, r.name, r.released_on, r.changelist, r.notes,
        r.created_at,
        u.username AS created_by_username,
        (SELECT COUNT(*) FROM release_assets ra WHERE ra.release_id = r.id)
            AS asset_count
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
        (SELECT MAX(ai.changelist) FROM asset_integrations ai
          WHERE ai.asset_version_id = av.id) AS changelist
    FROM release_assets ra
    JOIN asset_versions av ON av.id = ra.asset_version_id
    JOIN assets a ON a.id = av.asset_id
    LEFT JOIN creative_approvals ca
        ON ca.repository_version_id = av.id AND ca.status = 'approved'
    LEFT JOIN users u ON u.id = ca.decided_by
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
        EXISTS (
            SELECT 1 FROM release_assets x
            WHERE x.asset_version_id = av.id
        ) AS in_other_release
    FROM asset_versions av
    JOIN assets a ON a.id = av.asset_id AND a.is_active = 1
    JOIN creative_approvals ca
        ON ca.repository_version_id = av.id AND ca.status = 'approved'
    LEFT JOIN users u ON u.id = ca.decided_by
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
            decided_at: row.decided_at,
            changelist: row.changelist
        })),
        candidates: candidatesFor.all(releaseId).map(row => ({
            asset_version_id: row.asset_version_id,
            version_number: row.version_number,
            asset_id: row.asset_id,
            asset_name: row.asset_name,
            approved_by: row.approved_by,
            decided_at: row.decided_at,
            in_other_release: Boolean(row.in_other_release)
        }))
    };
}

const isPositiveInteger = value => Number.isInteger(value) && value >= 1;

// ---------------------------------------------------------------------------
// GET /api/releases — every named release, newest first
// ---------------------------------------------------------------------------

router.get('/', authenticateToken, requireRole('admin'), (req, res) => {
    return res.json({ releases: listReleases.all() });
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

router.get('/:id', authenticateToken, requireRole('admin'), (req, res) => {
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

module.exports = router;
