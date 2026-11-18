#!/usr/bin/env node
/**
 * Checks the APPROVAL PATH over HTTP — submit, lock, approve, reject, unlock.
 *
 *   node tests/check-approval-path.js      # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * TODO 92 ended with "the next one should be the approval path: submit,
 * approve and reject are where state changes and where a mistake is
 * expensive." This is that check.
 *
 * THE FAILURES IT GUARDS AGAINST ARE NOT COSMETIC:
 *
 *   * a version approved WITHOUT a passing technical check on the same content
 *     — the receipt's whole job (TODO 87 E1)
 *   * a submission that does not LOCK, so what the reviewer sees can change
 *     underneath them
 *   * a rejection that does not UNLOCK, so the developer's work is stuck
 *   * approval that copies nothing into the store, or copies the wrong thing
 *   * approval by somebody who is not production
 *   * a decision with no audit record
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   submit     a passing check on the same content is required   201
 *              the version is locked                              creative_locked = 1
 *              a second submission is refused                     409
 *              no passing check                         409
 *              a check against different content        409
 *              prod cannot submit                       403
 *              another developer's asset                404
 *
 *   locked     the version cannot be deleted                  409
 *              the asset cannot be deleted                    409
 *
 *   approve    a developer cannot                       403
 *              an administrator cannot                  403
 *              prod can                                  200
 *              an asset_versions row exists, with the file references
 *              the workspace version records the repository version
 *              the version STAYS locked
 *              approving twice                          409
 *
 *   reject     the version is unlocked                         creative_locked = 0
 *              the developer may submit again                 201
 *              rejecting twice                          409
 *
 *   audit      submit x3, approve x1, reject x1, by the right actors
 *
 *   after      an approved version can be deleted by its developer, and the
 *              STORE's copy survives — a developer can never remove game
 *              content
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * tests/lib/check-harness.js copies the schema into a throwaway database,
 * mounts the REAL router on a throwaway Express app, and points the
 * application at throwaway directories. The technical check is SEEDED rather
 * than run: this check is about what happens after a check passes, and running
 * the real one would make it depend on the file formats it inspects.
 */

const { Reporter, startCheckServer, Database } = require('./lib/check-harness');
const { manifestHash } = require('../backend/lib/manifestHash');

const shaOf = label => require('crypto')
    .createHash('sha256')
    .update(`check-approval:${label}`)
    .digest('hex');

// A version's content identity, computed the way the application computes it,
// so a version and its check run agree for a real reason rather than because
// two constants were typed to match.
const hashOf = (sha, filename) => manifestHash([
    { relative_path: '', filename, sha256: sha, size: 30 }
]);

async function main() {
    const report = new Reporter();

    const A = shaOf('a');
    const B = shaOf('b');
    const C = shaOf('c');
    const D = shaOf('d');
    const E = shaOf('e');   // content nothing was tested against

    const H1 = hashOf(A, 'a.png');
    const H2 = hashOf(B, 'b.png');
    const H3 = hashOf(C, 'c.png');
    const H4 = hashOf(D, 'd.png');

    const server = await startCheckServer({
        prefix: 'lowex-approval-',
        route: 'backend/routes/developerWorkspace',
        mount: '/api/developer/workspace',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'prod-check',  'prod@check.invalid',  'x', 'prod', 1),
                    (2, 'dev-check',   'dev@check.invalid',   'x', 'developer', 1),
                    (3, 'admin-check', 'admin@check.invalid', 'x', 'admin', 1),
                    (4, 'dev2-check',  'dev2@check.invalid',  'x', 'developer', 1);

                INSERT INTO developer_workspaces (id, developer_id)
                VALUES (1, 2), (2, 4);

                INSERT INTO workspace_assets
                    (id, workspace_id, name, asset_type, category, description)
                VALUES
                    (1, 1, 'PendingWork', 'Model',   'Prop',    'the one that gets approved'),
                    (2, 1, 'Rework',      'Texture', NULL,      'the one that gets rejected'),
                    (3, 1, 'NoCheck',     NULL,      NULL,      'no technical run'),
                    (4, 1, 'StaleCheck',  NULL,      NULL,      'tested against other content');

                INSERT INTO stored_files (id, sha256, storage_key, file_size)
                VALUES
                    (1, '${A}', '${A}', 30),
                    (2, '${B}', '${B}', 30),
                    (3, '${C}', '${C}', 30),
                    (4, '${D}', '${D}', 30);

                INSERT INTO workspace_versions
                    (id, workspace_asset_id, version_number, created_by, version_note, manifest_hash)
                VALUES
                    (1, 1, 1, 2, 'first',  '${H1}'),
                    (2, 2, 1, 2, 'second', '${H2}'),
                    (3, 3, 1, 2, 'third',  '${H3}'),
                    (4, 4, 1, 2, 'fourth', '${H4}');

                INSERT INTO workspace_version_files
                    (workspace_version_id, stored_file_id, filename, relative_path)
                VALUES
                    (1, 1, 'a.png', ''),
                    (2, 2, 'b.png', ''),
                    (3, 3, 'c.png', ''),
                    (4, 4, 'd.png', '');

                INSERT INTO technical_check_runs
                    (workspace_asset_id, workspace_version_id, status, manifest_hash, completed_at)
                VALUES
                    (1, 1, 'passed', '${H1}', CURRENT_TIMESTAMP),
                    (2, 2, 'passed', '${H2}', CURRENT_TIMESTAMP),
                    -- v4's run passed, but against DIFFERENT content
                    (4, 4, 'passed', '${hashOf(E, 'd.png')}', CURRENT_TIMESTAMP);
            `);
        }
    });

    const db = new Database(server.dbPath, { readonly: true });

    const prod = server.tokenFor(1);
    const dev = server.tokenFor(2);
    const admin = server.tokenFor(3);
    const dev2 = server.tokenFor(4);

    const approvalRow = id => db.prepare('SELECT * FROM creative_approvals WHERE id = ?').get(id);
    const versionRow = id => db.prepare('SELECT * FROM workspace_versions WHERE id = ?').get(id);

    // -----------------------------------------------------------------
    // SUBMIT
    // -----------------------------------------------------------------

    const submitted = await server.post('/assets/1/versions/1/creative-approval',
        { request_comment: 'please review' }, dev);

    report.check('a version with a matching passing check can be submitted',
        submitted.status === 201, `expected 201, got ${submitted.status} — ${submitted.text}`);

    const approval1 = submitted.json?.approval?.id;

    report.check('the submission is pending', submitted.json?.status === 'pending',
        `body said ${submitted.text.slice(0, 120)}`);

    report.check('and it LOCKS the version', versionRow(1)?.creative_locked === 1,
        'creative_locked was not set — what the reviewer sees could change underneath them');

    const twice = await server.post('/assets/1/versions/1/creative-approval', {}, dev);

    report.check('submitting the same version twice is refused', twice.status === 409,
        `expected 409, got ${twice.status}`);

    const noCheck = await server.post('/assets/3/versions/3/creative-approval', {}, dev);

    report.check('a version with no passing technical check is refused', noCheck.status === 409,
        `expected 409, got ${noCheck.status}`);

    const stale = await server.post('/assets/4/versions/4/creative-approval', {}, dev);

    report.check('a check against DIFFERENT content is refused', stale.status === 409,
        `expected 409, got ${stale.status} — the receipt is not being compared`);

    const prodSubmit = await server.post('/assets/2/versions/2/creative-approval', {}, prod);

    report.check('production cannot submit', prodSubmit.status === 403,
        `expected 403, got ${prodSubmit.status}`);

    const otherDev = await server.post('/assets/1/versions/1/creative-approval', {}, dev2);

    report.check("another developer's asset is not found", otherDev.status === 404,
        `expected 404, got ${otherDev.status}`);

    // -----------------------------------------------------------------
    // LOCKED
    // -----------------------------------------------------------------

    const deleteVersion = await server.del('/assets/1/versions/1', dev);

    report.check('a version under review cannot be deleted', deleteVersion.status === 409,
        `expected 409, got ${deleteVersion.status}`);

    const deleteAsset = await server.del('/assets/1', dev);

    report.check('an asset under review cannot be deleted', deleteAsset.status === 409,
        `expected 409, got ${deleteAsset.status}`);

    // -----------------------------------------------------------------
    // APPROVE
    // -----------------------------------------------------------------

    const devApprove = await server.post(`/creative-approvals/${approval1}/approve`, {}, dev);

    report.check('a developer cannot approve', devApprove.status === 403,
        `expected 403, got ${devApprove.status}`);

    const adminApprove = await server.post(`/creative-approvals/${approval1}/approve`, {}, admin);

    report.check('an administrator cannot approve', adminApprove.status === 403,
        `expected 403, got ${adminApprove.status} — approving is production's job (RULES 6/7, TODO 51)`);

    const approved = await server.post(`/creative-approvals/${approval1}/approve`,
        { decision_comment: 'good' }, prod);

    report.check('production can approve', approved.status === 200,
        `expected 200, got ${approved.status} — ${approved.text.slice(0, 160)}`);

    const approvalAfter = approvalRow(approval1);
    const versionAfter = versionRow(1);

    report.check('the approval records the decision',
        approvalAfter?.status === 'approved'
        && approvalAfter?.decided_by === 1
        && approvalAfter?.decision_comment === 'good',
        `approval row: ${JSON.stringify(approvalAfter)}`);

    const storeAsset = db.prepare('SELECT * FROM assets WHERE name = ?').get('PendingWork');
    const storeVersion = storeAsset
        ? db.prepare('SELECT * FROM asset_versions WHERE id = ?').get(approvalAfter?.repository_version_id)
        : null;

    report.check('an asset appears in the store', !!storeAsset,
        'no assets row named PendingWork was created');

    report.check('with a version', !!storeVersion && storeVersion.version_number === 1,
        `store version: ${JSON.stringify(storeVersion)}`);

    const storeFiles = storeVersion
        ? db.prepare('SELECT * FROM asset_version_files WHERE asset_version_id = ?').all(storeVersion.id)
        : [];

    report.check('and the file references are copied', storeFiles.length === 1,
        `expected 1 file reference, found ${storeFiles.length}`);

    // TWO DIFFERENT PEOPLE, TWO COLUMNS. created_by is the decider; the
    // author comes from the workspace version. Before 2026-10-30 the store
    // recorded only the approver.
    report.check('the store version records who UPLOADED it as well as who approved',
        storeVersion?.uploaded_by === 2 && storeVersion?.created_by === 1,
        `uploaded_by=${storeVersion?.uploaded_by}, created_by=${storeVersion?.created_by}`);

    report.check('and the store version carries the same content identity',
        storeVersion?.manifest_hash === H1,
        `expected ${H1}, got ${storeVersion?.manifest_hash}`);

    report.check('the workspace version points at the store version',
        versionAfter?.repository_version_id === storeVersion?.id,
        `workspace version says ${versionAfter?.repository_version_id}, store made ${storeVersion?.id}`);

    report.check('and stays locked after approval', versionAfter?.creative_locked === 1,
        'the version was unlocked by approving it');

    const approveTwice = await server.post(`/creative-approvals/${approval1}/approve`, {}, prod);

    report.check('approving twice is refused', approveTwice.status === 409,
        `expected 409, got ${approveTwice.status}`);

    // -----------------------------------------------------------------
    // REJECT
    // -----------------------------------------------------------------

    const submit2 = await server.post('/assets/2/versions/2/creative-approval', {}, dev);

    report.check('a second asset can be submitted', submit2.status === 201,
        `expected 201, got ${submit2.status} — ${submit2.text.slice(0, 120)}`);

    const approval2 = submit2.json?.approval?.id;

    report.check('the second submission locks its version', versionRow(2)?.creative_locked === 1);

    const rejected = await server.post(`/creative-approvals/${approval2}/reject`,
        { decision_comment: 'the seams do not line up' }, prod);

    report.check('production can reject', rejected.status === 200,
        `expected 200, got ${rejected.status} — ${rejected.text.slice(0, 160)}`);

    const rejectedRow = approvalRow(approval2);

    report.check('the rejection records the reason',
        rejectedRow?.status === 'rejected'
        && rejectedRow?.decision_comment === 'the seams do not line up',
        `approval row: ${JSON.stringify(rejectedRow)}`);

    report.check('and UNLOCKS the version', versionRow(2)?.creative_locked === 0,
        'the developer cannot work on rejected work — the lock was not released');

    const resubmit = await server.post('/assets/2/versions/2/creative-approval', {}, dev);

    report.check('the developer can submit the rejected work again', resubmit.status === 201,
        `expected 201, got ${resubmit.status} — ${resubmit.text.slice(0, 120)}`);

    const rejectTwice = await server.post(`/creative-approvals/${approval2}/reject`, {}, prod);

    report.check('rejecting a decided approval is refused', rejectTwice.status === 409,
        `expected 409, got ${rejectTwice.status}`);

    // -----------------------------------------------------------------
    // AUDIT
    // -----------------------------------------------------------------

    const audits = action => db.prepare(
        'SELECT * FROM audit_logs WHERE action = ? ORDER BY id'
    ).all(action);

    report.check('every submission is recorded', audits('creative_approval.submit').length === 3,
        `found ${audits('creative_approval.submit').length} submit records, expected 3`);

    const approveAudit = audits('creative_approval.approve');
    const rejectAudit = audits('creative_approval.reject');

    report.check('the approval is recorded, with its actor',
        approveAudit.length === 1 && approveAudit[0].actor_id === 1,
        `approve records: ${JSON.stringify(approveAudit)}`);

    report.check('the rejection is recorded, with its actor',
        rejectAudit.length === 1 && rejectAudit[0].actor_id === 1,
        `reject records: ${JSON.stringify(rejectAudit)}`);

    // -----------------------------------------------------------------
    // AFTER APPROVAL
    // -----------------------------------------------------------------

    const deleteApproved = await server.del('/assets/1/versions/1', dev);

    report.check('an approved version may be deleted from the workspace',
        deleteApproved.status === 200,
        `expected 200, got ${deleteApproved.status} — ${deleteApproved.text.slice(0, 120)}`);

    const storeSurvives = db.prepare('SELECT * FROM asset_versions WHERE id = ?')
        .get(storeVersion?.id);

    report.check('and the STORE keeps its copy',
        !!storeSurvives,
        'deleting the workspace version removed game content');

    // -----------------------------------------------------------------

    db.close();
    await server.close();

    report.finish('the approval path locks, decides, records and unlocks as it says');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
