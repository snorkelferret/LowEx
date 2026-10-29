#!/usr/bin/env node
/**
 * Checks that an asset UNDER REVIEW cannot be changed by uploading to it.
 *
 *   node scripts/check-upload-pending.js     # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * TODO 93 ended with it: "the other half of the freeze, and the one a
 * developer would hit." The approval check proves the submitted VERSION is
 * locked — it cannot be deleted, and the reviewer's preview cannot change.
 * It does not prove the ASSET is frozen, and that is the path a developer
 * actually takes: they carry on working, upload a new version, and if the
 * freeze does not hold, the asset an approver is looking at grows a newer
 * version underneath them.
 *
 * The freeze is asset-wide on purpose (the upload route's own note): a pending
 * approval holds the whole asset, not only the version that was submitted.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   1. an upload to a pending asset               409, and the message says why
 *   2. NO PARTIAL STATE from the refusal          no version, no stored file,
 *                                                 no blob, no temp file
 *   3. the pending approval is untouched          still pending, still locked
 *   4. a DIFFERENT asset still accepts work       201 — the freeze is scoped
 *   5. after a rejection, the frozen asset takes
 *      the same upload                            201 — the freeze lifts
 *
 * The "no partial state" assertions are the point of doing this over HTTP
 * rather than reading the query: the refusal happens INSIDE the write
 * transaction, after the files have been hashed and stored, so the interesting
 * question is whether the rollback actually rolls back.
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * scripts/lib/check-harness.js provides the throwaway server and database. The
 * upload is a real multipart request through the real multer middleware — the
 * first check to send one — because nothing else would exercise the field
 * names, the temp files or the transaction.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Reporter, startCheckServer, Database } = require('./lib/check-harness');

const shaOf = label => crypto.createHash('sha256')
    .update(`check-upload:${label}`)
    .digest('hex');

async function main() {
    const report = new Reporter();

    const A = shaOf('a');
    const B = shaOf('b');

    const sharp = require('sharp');

    // Real PNGs, so the upload is realistic and preview generation has
    // something to make a picture from.
    const FIRST_UPLOAD = await sharp({
        create: { width: 9, height: 9, channels: 3, background: '#aa2222' }
    }).png().toBuffer();

    const SECOND_UPLOAD = await sharp({
        create: { width: 10, height: 10, channels: 3, background: '#2222aa' }
    }).png().toBuffer();

    const server = await startCheckServer({
        prefix: 'lowex-upload-pending-',
        route: 'backend/routes/developerWorkspace',
        mount: '/api/developer/workspace',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'prod-check', 'prod@check.invalid', 'x', 'prod', 1),
                    (2, 'dev-check',  'dev@check.invalid',  'x', 'developer', 1);

                INSERT INTO developer_workspaces (id, developer_id) VALUES (1, 2);

                INSERT INTO workspace_assets (id, workspace_id, name)
                VALUES
                    (1, 1, 'PendingWork'),
                    (2, 1, 'OtherWork');

                INSERT INTO stored_files (id, sha256, storage_key, file_size)
                VALUES
                    (1, '${A}', '${A}', 30),
                    (2, '${B}', '${B}', 30);

                -- The version that is about to be submitted.
                INSERT INTO workspace_versions
                    (id, workspace_asset_id, version_number, created_by, version_note, manifest_hash)
                VALUES (1, 1, 1, 2, 'first', 'hash-of-a');

                INSERT INTO workspace_version_files
                    (workspace_version_id, stored_file_id, filename, relative_path)
                VALUES (1, 1, 'a.png', '');

                -- A passing check, so the submission is accepted and the
                -- freeze is what this check is testing.
                INSERT INTO technical_check_runs
                    (workspace_asset_id, workspace_version_id, status, manifest_hash, completed_at)
                VALUES (1, 1, 'passed', 'hash-of-a', CURRENT_TIMESTAMP);

                -- The other asset, with a version of its own.
                INSERT INTO workspace_versions
                    (id, workspace_asset_id, version_number, created_by, version_note, manifest_hash)
                VALUES (2, 2, 1, 2, 'other', 'hash-of-b');

                INSERT INTO workspace_version_files
                    (workspace_version_id, stored_file_id, filename, relative_path)
                VALUES (2, 2, 'b.png', '');
            `);
        }
    });

    const db = new Database(server.dbPath, { readonly: true });
    const dev = server.tokenFor(2);
    const prod = server.tokenFor(1);

    const upload = (assetName, bytes, filename, note) => {
        const form = new FormData();

        form.append('upload_name', assetName);
        form.append('version_note', note);
        form.append('files', new Blob([bytes], { type: 'image/png' }), filename);

        return server.postForm('/upload', form, dev);
    };

    const versionsOf = assetId => db.prepare(
        'SELECT COUNT(*) AS n FROM workspace_versions WHERE workspace_asset_id = ?'
    ).get(assetId).n;

    const storedCount = () => db.prepare('SELECT COUNT(*) AS n FROM stored_files').get().n;
    const blobCount = () => fs.readdirSync(server.dirs.blobs).length;
    const tempCount = () => fs.readdirSync(server.dirs.temp).length;

    // -----------------------------------------------------------------
    // Put the asset under review, through the real route.
    // -----------------------------------------------------------------

    const submitted = await server.post('/assets/1/versions/1/creative-approval', {}, dev);

    report.check('the asset is under review', submitted.status === 201,
        `expected 201, got ${submitted.status} — ${submitted.text.slice(0, 140)}`);

    const approvalId = submitted.json?.approval?.id;

    const versionsBefore = versionsOf(1);
    const storedBefore = storedCount();
    const blobsBefore = blobCount();

    // -----------------------------------------------------------------
    // The upload to a frozen asset
    // -----------------------------------------------------------------

    const frozen = await upload('PendingWork', FIRST_UPLOAD, 'new.png', 'while pending');

    report.check('an upload to a pending asset is refused', frozen.status === 409,
        `expected 409, got ${frozen.status} — ${frozen.text.slice(0, 160)}`);

    report.check('the refusal says why',
        /under review/i.test(frozen.text),
        `the message was: ${frozen.text.slice(0, 160)}`);

    report.check('no version was created', versionsOf(1) === versionsBefore,
        `${versionsOf(1)} versions, expected ${versionsBefore}`);

    report.check('no stored file was left behind', storedCount() === storedBefore,
        `${storedCount()} stored files, expected ${storedBefore} — the rollback did not remove the new row`);

    report.check('no blob was left behind', blobCount() === blobsBefore,
        `${blobCount()} blobs, expected ${blobsBefore} — a refused upload left content on disk`);

    report.check('no temporary file was left behind', tempCount() === 0,
        `${tempCount()} files in the temp directory after a refused upload`);

    const approvalStill = db.prepare('SELECT * FROM creative_approvals WHERE id = ?').get(approvalId);
    const versionStill = db.prepare('SELECT * FROM workspace_versions WHERE id = 1').get();

    report.check('the approval is still pending', approvalStill?.status === 'pending',
        `approval status is ${approvalStill?.status}`);

    report.check('and the submitted version is still locked', versionStill?.creative_locked === 1);

    // -----------------------------------------------------------------
    // The freeze is scoped to the asset
    // -----------------------------------------------------------------

    const otherAsset = await upload('OtherWork', FIRST_UPLOAD, 'other.png', 'unrelated work');

    report.check('a different asset still accepts an upload', otherAsset.status === 201,
        `expected 201, got ${otherAsset.status} — ${otherAsset.text.slice(0, 160)}`);

    report.check('and the version was created', versionsOf(2) === 2,
        `${versionsOf(2)} versions of OtherWork, expected 2`);

    // -----------------------------------------------------------------
    // The freeze lifts on rejection
    // -----------------------------------------------------------------

    const rejected = await server.post(`/creative-approvals/${approvalId}/reject`,
        { decision_comment: 'not these colours' }, prod);

    report.check('production rejects it', rejected.status === 200,
        `expected 200, got ${rejected.status} — ${rejected.text.slice(0, 140)}`);

    const afterReject = await upload('PendingWork', SECOND_UPLOAD, 'newer.png', 'now it may change');

    report.check('the rejected asset accepts the upload', afterReject.status === 201,
        `expected 201, got ${afterReject.status} — ${afterReject.text.slice(0, 160)}`);

    report.check('and the new version exists', versionsOf(1) === 2,
        `${versionsOf(1)} versions of PendingWork, expected 2`);

    // -----------------------------------------------------------------

    db.close();
    await server.close();

    report.finish('a pending asset refuses changes, completely, and only that asset');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
