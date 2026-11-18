// backend/routes/integration.js
//
// THE RECEIPT. WHAT RAN INSIDE THE GAME, AND WHERE.
//
// ============================================================
// WHY THIS ROUTE EXISTS
// ============================================================
//
// The spec is emphatic: "You cannot simply type: 'Tested against Development.'
// The system knows exactly which build was used." (TODO 86, SPEC §5).
//
// The portal cannot know that. It has no game content, and by rule it never
// asks Perforce (RULES 8). The one process that can know is the one inside the
// editor: it has the client's stream, the synced changelist and the level the
// asset was placed in.
//
// So the tool reports, and the portal records. This is the same one-way shape
// as the change-commit trigger, and the same reasoning: the portal is TOLD.
//
// ============================================================
// WHAT THE RECEIPT IS BOUND TO
// ============================================================
//
// The content. A receipt carries the version's manifest hash at the moment of
// testing, and the hash of the exchange file the tool actually imported. The
// server compares that file hash against the version's own file set, so:
//
//   * the bytes the tool imported are bytes the developer uploaded;
//   * the receipt is evidence for ONE set of content and no other;
//   * changing the FBX after uploading invalidates the receipt by itself.
//
// This is the same principle as the technical-check receipt (TODO 87 E1), one
// layer out: the version id is not evidence, the hash is.
//
// ============================================================
// A FAILED RECEIPT IS STILL A RECEIPT
// ============================================================
//
// `result: 'failed'` is recorded rather than refused. "It did not work" is a
// fact production should see, and throwing it away would make the only visible
// tests the passing ones.
//
// ============================================================
// AND THE SAME RECEIPT TWICE IS HARMLESS
// ============================================================
//
// UNIQUE (workspace_version_id, changelist), insert does nothing on a
// conflict. A tool retrying after a timeout leaves one row.

const express = require('express');
const db = require('../db');
const audit = require('../lib/audit');
const { requireApiKey } = require('../middleware/apiKey');
const { getSetting } = require('../lib/settings');
const { isExchangeFile } = require('../../shared/assetRules.mjs');

const router = express.Router();

const HEX_64 = /^[0-9a-f]{64}$/;
const STREAM = /^\/\/[^\s]{1,198}$/;

const versionRow = db.prepare(`
    SELECT
        wv.id,
        wv.workspace_asset_id,
        wv.manifest_hash,
        wv.is_active,
        wa.is_active AS asset_active,
        wa.name AS asset_name
    FROM workspace_versions wv
    JOIN workspace_assets wa ON wa.id = wv.workspace_asset_id
    WHERE wv.id = ?
`);

const versionFile = db.prepare(`
    SELECT
        wvf.filename,
        wvf.relative_path,
        sf.sha256
    FROM workspace_version_files wvf
    JOIN stored_files sf ON sf.id = wvf.stored_file_id
    WHERE wvf.workspace_version_id = ?
      AND sf.sha256 = ?
      AND wvf.filename = ?
`);

const changelistKnown = db.prepare(`
    SELECT 1 FROM perforce_changes WHERE changelist = ?
`);

const insertReceipt = db.prepare(`
    INSERT INTO integration_receipts (
        workspace_version_id,
        manifest_hash,
        stream,
        parent_stream,
        changelist,
        levels,
        exchange_filename,
        exchange_sha256,
        result,
        checks,
        tool_account,
        editor_build,
        trigger_confirmed
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_version_id, changelist) DO NOTHING
`);

const receiptRow = db.prepare(`
    SELECT *
    FROM integration_receipts
    WHERE workspace_version_id = ? AND changelist = ?
`);

function text(value, max) {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

function validLevels(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
        return null;
    }

    const levels = value.map(level => String(level ?? '').trim());

    if (levels.some(level => !level || level.length > 512)) {
        return null;
    }

    return [...new Set(levels)];
}

function validChecks(value) {
    if (value === undefined) return [];

    if (!Array.isArray(value) || value.length > 100) {
        return null;
    }

    const statuses = new Set(['passed', 'failed', 'warning', 'skipped', 'error']);
    const checks = [];

    for (const item of value) {
        const name = text(item?.name, 120);
        const status = text(item?.status, 20);

        if (!name || !statuses.has(status)) return null;

        checks.push({
            name,
            status,
            message: text(item?.message, 2000)
        });
    }

    return checks;
}

// ---------------------------------------------------------------------------
// POST /api/integration/receipts — the tool reports a test
// ---------------------------------------------------------------------------

router.post(
    '/receipts',
    requireApiKey,

    (req, res) => {
        // THE SWITCH, NOT A PERMISSION. `integration_tooling` is the one
        // recorded exception to RULES 2, default off, and every change to it
        // is audited. Off means the portal does not accept receipts at all.
        if (!getSetting('integration_tooling')) {
            return res.status(403).json({
                error:
                    'Integration tooling is off. An administrator must enable it ' +
                    'before the portal accepts receipts from the editor tool.'
            });
        }

        const body = req.body || {};

        const versionId = Number(body.workspace_version_id);

        if (!Number.isInteger(versionId) || versionId < 1) {
            return res.status(400).json({
                error: 'workspace_version_id must be a positive integer.'
            });
        }

        const changelist = Number(body.changelist);

        if (!Number.isInteger(changelist) || changelist < 1) {
            return res.status(400).json({
                error: 'changelist must be a positive integer — the game changelist tested.'
            });
        }

        const stream = text(body.stream, 200);

        if (!stream || !STREAM.test(stream)) {
            return res.status(400).json({
                error: 'stream must be a Perforce stream path, such as //LowExpectations/dev.'
            });
        }

        const parentStream = text(body.parent_stream, 200);

        if (parentStream && !STREAM.test(parentStream)) {
            return res.status(400).json({
                error: 'parent_stream, when given, must be a Perforce stream path.'
            });
        }

        const levels = validLevels(body.levels);

        if (!levels) {
            return res.status(400).json({
                error: 'levels must be a non-empty array of level paths — what the asset was placed in.'
            });
        }

        const exchangeFilename = text(body.exchange_filename, 512);
        const exchangeSha256 = String(body.exchange_sha256 || '').toLowerCase();

        if (!exchangeFilename || !isExchangeFile(exchangeFilename)) {
            return res.status(400).json({
                error:
                    'exchange_filename must name the interchange file the tool imported ' +
                    '(FBX, glTF or USD).'
            });
        }

        if (!HEX_64.test(exchangeSha256)) {
            return res.status(400).json({
                error: 'exchange_sha256 must be a lowercase SHA-256.'
            });
        }

        const result = String(body.result || '');

        if (result !== 'passed' && result !== 'failed') {
            return res.status(400).json({
                error: "result must be 'passed' or 'failed'."
            });
        }

        const checks = validChecks(body.checks);

        if (!checks) {
            return res.status(400).json({
                error: 'checks must be a list of { name, status, message }.'
            });
        }

        try {
            const version = versionRow.get(versionId);

            if (!version || !version.is_active || !version.asset_active) {
                return res.status(404).json({
                    error: 'That workspace version does not exist.'
                });
            }

            if (!version.manifest_hash) {
                return res.status(409).json({
                    error: 'That version has no content identity, so a receipt cannot be bound to it.'
                });
            }

            // THE BINDING. The file the tool says it imported must be a file in
            // the version, under that name and that hash. A receipt for
            // something the developer did not upload is not a receipt for this
            // submission.
            const file = versionFile.get(versionId, exchangeSha256, exchangeFilename);

            if (!file) {
                return res.status(409).json({
                    error:
                        'The exchange file this receipt names is not in that version. ' +
                        'Upload the same file the tool imported.'
                });
            }

            const confirmed = changelistKnown.get(changelist) ? 1 : 0;

            const inserted = insertReceipt.run(
                versionId,
                version.manifest_hash,
                stream,
                parentStream,
                changelist,
                JSON.stringify(levels),
                exchangeFilename,
                exchangeSha256,
                result,
                checks.length ? JSON.stringify(checks) : null,
                text(body.p4_user, 100),
                text(body.editor_build, 200),
                confirmed
            );

            const recorded = Boolean(inserted.changes);

            if (recorded) {
                // A PROGRAM'S ACT, SO THERE IS NO PERSON TO NAME. The key is
                // recorded instead — that is the identity the portal actually
                // has, and writing a developer id here would be inventing one.
                audit.record(null, 'integration.receipt', version.asset_name, {
                    api_key: req.apiKey.name,
                    workspace_version_id: versionId,
                    changelist,
                    stream,
                    parent_stream: parentStream,
                    result,
                    trigger_confirmed: Boolean(confirmed)
                });
            }

            return res.status(recorded ? 201 : 200).json({
                recorded,
                duplicate: !recorded,
                trigger_confirmed: Boolean(confirmed),
                receipt: receiptRow.get(versionId, changelist)
            });

        } catch (err) {
            console.error('Could not record an integration receipt:', err);
            return res.status(500).json({
                error: 'Could not record that receipt'
            });
        }
    }
);

module.exports = router;
