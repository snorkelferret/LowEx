// backend/routes/integration.js
//
// THE RECEIPT AND THE BUILD. WHAT RAN INSIDE THE GAME, AND WHAT WAS BUILT.
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

const buildByStreamAndChangelist = db.prepare(`
    SELECT *
    FROM builds
    WHERE stream = ? AND changelist = ?
`);

const insertBuild = db.prepare(`
    INSERT INTO builds (
        name,
        stream,
        changelist,
        released_on,
        build_id,
        built_at,
        base_stream,
        base_changelist,
        result,
        failed_stage,
        duration_seconds,
        output_bytes,
        warnings,
        errors,
        log_excerpt,
        notes,
        source,
        created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', NULL)
`);

const buildByIdRow = db.prepare('SELECT * FROM builds WHERE id = ?');


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


// ---------------------------------------------------------------------------
// POST /api/integration/builds — the build machine reports a build
// ---------------------------------------------------------------------------
//
// THE SECOND PUSH. A receipt says an asset was tested in a build; this says
// the build exists: which STREAM it came from, at which CHANGELIST, and what
// the machine calls it. With both, "built against" is answerable — a receipt's
// changelist matches a build whose stream is the destination.
//
// A CANDIDATE BUILD names the stream it was built OVER (base_stream and
// base_changelist), which is the build that tests a change in the game without
// changing the game (TODO 110, option b).
//
// IDEMPOTENT ON (stream, changelist): the same two facts say "this is the same
// build" to a machine that retries. A retry fills in anything missing and
// returns 200; it never overwrites a value already recorded.
//
// THE NAME DEFAULTS TO "<stream> @ CL <changelist>" so a caller that has no
// naming scheme still produces a row a person can read.

const ISO_8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

router.post(
    '/builds',
    requireApiKey,

    (req, res) => {
        if (!getSetting('integration_tooling')) {
            return res.status(403).json({
                error:
                    'Integration tooling is off. An administrator must enable it ' +
                    'before the portal accepts build reports.'
            });
        }

        const body = req.body || {};

        const stream = String(body.stream || '').trim();

        if (!stream || stream.length > 200 || !STREAM.test(stream)) {
            return res.status(400).json({
                error: 'stream must be a Perforce stream path, such as //LowExpectations/main.'
            });
        }

        const changelist = Number(body.changelist);

        if (!Number.isInteger(changelist) || changelist < 1) {
            return res.status(400).json({
                error: 'changelist must be a positive integer — the changelist built.'
            });
        }

        const rawName = String(body.name || '').trim();

        if (rawName.length > 120) {
            return res.status(400).json({
                error: 'name is too long — 120 characters at most.'
            });
        }

        const name = rawName || `${stream} @ CL ${changelist}`;

        // WHEN A BUILD IS A RELEASE. Optional, and the build process is the
        // one that knows: a build that shipped, with its date.
        const releasedOn = String(body.released_on || '').trim() || null;

        if (releasedOn && !/^\d{4}-\d{2}-\d{2}$/.test(releasedOn)) {
            return res.status(400).json({
                error: 'released_on must be YYYY-MM-DD.'
            });
        }

        const rawBuildId = String(body.build_id || '').trim();

        if (rawBuildId.length > 120) {
            return res.status(400).json({
                error: 'build_id is too long — 120 characters at most.'
            });
        }

        const rawNotes = String(body.notes || '').trim();

        if (rawNotes.length > 2000) {
            return res.status(400).json({
                error: 'notes is too long — 2000 characters at most.'
            });
        }

        // WHEN THE MACHINE SAYS IT RAN, stored in UTC. created_at is when the
        // portal heard, which is a different fact if a report was queued.
        let builtAt = null;

        const rawBuiltAt = String(body.built_at || '').trim();

        if (rawBuiltAt) {
            if (!ISO_8601.test(rawBuiltAt)) {
                return res.status(400).json({
                    error: 'built_at must be an ISO 8601 date or date-time, such as 2026-11-18T17:30:00Z.'
                });
            }

            const parsed = new Date(rawBuiltAt);

            if (Number.isNaN(parsed.getTime())) {
                return res.status(400).json({
                    error: 'built_at is not a date this server can read.'
                });
            }

            builtAt = parsed.toISOString().slice(0, 19).replace('T', ' ');
        }

        // A CANDIDATE BUILD NAMES BOTH HALVES OR NEITHER: a base stream with
        // no changelist does not identify a state of the game, and a
        // changelist with no stream does not say which game.
        const baseStream = String(body.base_stream || '').trim();

        if (baseStream && (!STREAM.test(baseStream) || baseStream.length > 200)) {
            return res.status(400).json({
                error: 'base_stream, when given, must be a Perforce stream path.'
            });
        }

        const rawBaseChangelist = body.base_changelist;

        let baseChangelist = null;

        if (rawBaseChangelist !== undefined && rawBaseChangelist !== null && rawBaseChangelist !== '') {
            baseChangelist = Number(rawBaseChangelist);

            if (!Number.isInteger(baseChangelist) || baseChangelist < 1) {
                return res.status(400).json({
                    error: 'base_changelist must be a positive integer.'
                });
            }
        }

        if (Boolean(baseStream) !== Boolean(baseChangelist)) {
            return res.status(400).json({
                error:
                    'A candidate build needs both base_stream and base_changelist, ' +
                    'or neither.'
            });
        }

        // WHAT THE MACHINE MEASURED. All optional: a failed build has no
        // output size, and an earlier reporter sends none of them.
        const rawResult = String(body.result || '').trim();

        if (rawResult && rawResult !== 'succeeded' && rawResult !== 'failed') {
            return res.status(400).json({
                error: "result must be 'succeeded' or 'failed'."
            });
        }

        const result = rawResult || null;

        const failedStage = String(body.failed_stage || '').trim();

        if (failedStage.length > 120) {
            return res.status(400).json({
                error: 'failed_stage is too long — 120 characters at most.'
            });
        }

        const logExcerpt = String(body.log_excerpt || '').trim();

        if (logExcerpt.length > 2000) {
            return res.status(400).json({
                error: 'log_excerpt is too long — 2000 characters at most. Send the first errors, not the log.'
            });
        }

        // NON-NEGATIVE INTEGERS OR ABSENT. A negative size or duration is not
        // a measurement, and accepting one would put a nonsense number beside
        // a review.
        const statNumber = (value, field) => {
            if (value === undefined || value === null || value === '') {
                return { ok: true, value: null };
            }

            const number = Number(value);

            if (!Number.isInteger(number) || number < 0) {
                return { ok: false, field };
            }

            return { ok: true, value: number };
        };

        const duration = statNumber(body.duration_seconds, 'duration_seconds');
        const output = statNumber(body.output_bytes, 'output_bytes');
        const warningCount = statNumber(body.warnings, 'warnings');
        const errorCount = statNumber(body.errors, 'errors');

        for (const parsed of [duration, output, warningCount, errorCount]) {
            if (!parsed.ok) {
                return res.status(400).json({
                    error: `${parsed.field} must be a non-negative integer.`
                });
            }
        }

        try {
            const existing = buildByStreamAndChangelist.get(stream, changelist);

            if (existing) {
                // FILL ONLY WHAT IS MISSING. A retry, or a report queued while
                // the portal was down, must not overwrite a value somebody
                // else recorded.
                db.prepare(`
                    UPDATE builds
                    SET released_on = COALESCE(released_on, ?),
                        build_id = COALESCE(build_id, ?),
                        built_at = COALESCE(built_at, ?),
                        base_stream = COALESCE(base_stream, ?),
                        base_changelist = COALESCE(base_changelist, ?),
                        result = COALESCE(result, ?),
                        failed_stage = COALESCE(failed_stage, ?),
                        duration_seconds = COALESCE(duration_seconds, ?),
                        output_bytes = COALESCE(output_bytes, ?),
                        warnings = COALESCE(warnings, ?),
                        errors = COALESCE(errors, ?),
                        log_excerpt = COALESCE(log_excerpt, ?),
                        notes = COALESCE(notes, ?),
                        source = 'reported'
                    WHERE id = ?
                `).run(
                    releasedOn,
                    rawBuildId || null,
                    builtAt,
                    baseStream || null,
                    baseChangelist,
                    result,
                    failedStage || null,
                    duration.value,
                    output.value,
                    warningCount.value,
                    errorCount.value,
                    logExcerpt || null,
                    rawNotes || null,
                    existing.id
                );

                return res.status(200).json({
                    recorded: false,
                    duplicate: true,
                    build: buildByIdRow.get(existing.id)
                });
            }

            const inserted = insertBuild.run(
                name,
                stream,
                changelist,
                releasedOn,
                rawBuildId || null,
                builtAt,
                baseStream || null,
                baseChangelist,
                result,
                failedStage || null,
                duration.value,
                output.value,
                warningCount.value,
                errorCount.value,
                logExcerpt || null,
                rawNotes || null
            );

            audit.record(null, 'build.reported', name, {
                api_key: req.apiKey.name,
                build_id: inserted.lastInsertRowid,
                stream,
                changelist,
                machine_build_id: rawBuildId || null,
                base_stream: baseStream || null,
                base_changelist: baseChangelist
            });

            return res.status(201).json({
                recorded: true,
                duplicate: false,
                build: buildByIdRow.get(inserted.lastInsertRowid)
            });

        } catch (err) {
            if (/UNIQUE/i.test(err.message)) {
                return res.status(409).json({
                    error:
                        `A build called "${name}" already exists, or this stream and ` +
                        'changelist are already recorded under another name.'
                });
            }

            console.error('Could not record a build report:', err);
            return res.status(500).json({ error: 'Could not record that build' });
        }
    }
);

module.exports = router;
