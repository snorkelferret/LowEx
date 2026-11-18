#!/usr/bin/env node
/**
 * Checks the DESTINATION AND THE RECEIPT over HTTP.
 *
 *   node tests/check-integration-path.js      # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * TODO 110 added two gates that did not exist:
 *
 *   * a submission for a GAME VERSION needs an exchange file that a game can
 *     import, and a passing receipt from the in-editor tool inside that
 *     version;
 *   * a retarget by production is refused when the evidence does not cover the
 *     new version — "the check I ran was for somewhere else".
 *
 * Both are the kind of rule that is easy to write and easy to lose: the
 * submission route's own comments say the version id is not evidence, the hash
 * is. This makes the hash comparison, the receipt lookup and the retarget rule
 * fail loudly if somebody changes them.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   receipt    no key                                   401
 *              a wrong key                             401
 *              the tooling switch off                  403
 *              a valid receipt recorded                201
 *              the same receipt twice                  200, no second row
 *              an exchange file not in the version     409
 *              a changelist the trigger saw            trigger_confirmed = 1
 *              one it did not                         trigger_confirmed = 0
 *              a failed test is still recorded         201
 *
 *   submit     a game destination without an exchange file  409
 *              a game destination without a receipt        409
 *              a game destination with both                201
 *              a library destination needs neither         201
 *
 *   retarget   production to a version with no receipt       409
 *              production to the library                    200
 *              an administrator with no reason              400
 *              an administrator with one                    200, audited
 *              a developer                                  403
 *              a decided submission                         409
 *
 *   approve    the submission with a game destination still approves
 *
 *   streams    a content role reads the streams Perforce named
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * The harness mounts TWO routers — the submission and the receipt — because
 * the gate is the seam between them. The technical check is SEEDED rather than
 * run: this is about what happens after one passes.
 */

const crypto = require('crypto');
const { Reporter, startCheckServer, Database } = require('./lib/check-harness');
const { manifestHash } = require('../backend/lib/manifestHash');

const shaOf = label => crypto
    .createHash('sha256')
    .update(`check-integration:${label}`)
    .digest('hex');

const hashOf = entries => manifestHash(entries);

async function main() {
    const report = new Reporter();

    const F1 = shaOf('fbx-factory');
    const T1 = shaOf('texture-rust');
    const F3 = shaOf('fbx-tree');
    const P2 = shaOf('png-only');

    const H1 = hashOf([
        { relative_path: 'export', filename: 'factory.fbx', sha256: F1, size: 100 },
        { relative_path: 'textures', filename: 'rust.png', sha256: T1, size: 50 }
    ]);

    const H2 = hashOf([
        { relative_path: 'textures', filename: 'rust.png', sha256: P2, size: 50 }
    ]);

    const H3 = hashOf([
        { relative_path: 'export', filename: 'tree.fbx', sha256: F3, size: 100 }
    ]);

    // A key the check can present. The real script generates one and prints it
    // once; here it is a constant so the request can be made at all.
    const KEY = `lxk_${'b'.repeat(40)}`;
    const KEY_HASH = crypto.createHash('sha256').update(KEY).digest('hex');

    const server = await startCheckServer({
        prefix: 'lowex-integration-',

        routes: [
            { route: 'backend/routes/developerWorkspace', mount: '/api/developer/workspace' },
            { route: 'backend/routes/integration', mount: '/api/integration' },
            { route: 'backend/routes/perforce', mount: '/api/perforce' }
        ],

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'prod-check',  'prod@check.invalid',  'x', 'prod', 1),
                    (2, 'dev-check',   'dev@check.invalid',   'x', 'developer', 1),
                    (3, 'admin-check', 'admin@check.invalid', 'x', 'admin', 1);

                INSERT INTO developer_workspaces (id, developer_id)
                VALUES (1, 2);

                INSERT INTO workspace_assets
                    (id, workspace_id, name, asset_type, category, description)
                VALUES (1, 1, 'Factory', 'Model', 'Prop', 'a factory');

                INSERT INTO stored_files (id, sha256, storage_key, file_size)
                VALUES
                    (1, '${F1}', '${F1}', 100),
                    (2, '${T1}', '${T1}', 50),
                    (3, '${F3}', '${F3}', 100),
                    (4, '${P2}', '${P2}', 50);

                INSERT INTO workspace_versions
                    (id, workspace_asset_id, version_number, created_by, version_note, manifest_hash)
                VALUES
                    (1, 1, 1, 2, 'with an FBX',        '${H1}'),
                    (2, 1, 2, 2, 'textures only',      '${H2}'),
                    (3, 1, 3, 2, 'tested elsewhere',   '${H3}');

                INSERT INTO workspace_version_files
                    (workspace_version_id, stored_file_id, filename, relative_path)
                VALUES
                    (1, 1, 'factory.fbx', 'export'),
                    (1, 2, 'rust.png',    'textures'),
                    (2, 4, 'rust.png',    'textures'),
                    (3, 3, 'tree.fbx',    'export');

                INSERT INTO technical_check_runs
                    (workspace_asset_id, workspace_version_id, status, manifest_hash, completed_at)
                VALUES
                    (1, 1, 'passed', '${H1}', CURRENT_TIMESTAMP),
                    (1, 2, 'passed', '${H2}', CURRENT_TIMESTAMP),
                    (1, 3, 'passed', '${H3}', CURRENT_TIMESTAMP);

                INSERT INTO api_keys (name, key_prefix, key_hash)
                VALUES ('check-tool', '${KEY.slice(0, 12)}', '${KEY_HASH}');

                INSERT INTO perforce_changes
                    (changelist, username, client, stream, description, submitted_at, files)
                VALUES
                    (200, 'val', 'val-main', '//LE/main', 'a commit the trigger saw',
                     '2026-11-18 10:00:00', '[]'),
                    (300, 'val', 'val-exp', '//LE/exp', 'another',
                     '2026-11-18 10:05:00', '[]');

                INSERT INTO app_settings (key, value)
                VALUES ('integration_tooling', '1');
            `);
        }
    });

    const db = new Database(server.dbPath, { readonly: true });

    const prod = server.tokenFor(1);
    const dev = server.tokenFor(2);
    const admin = server.tokenFor(3);

    const auth = { Authorization: `Bearer ${KEY}` };

    const receipt = (body) => server.call('POST', '/api/integration/receipts', {
        headers: auth,
        body
    });

    const validReceipt = (overrides = {}) => ({
        workspace_version_id: 1,
        changelist: 200,
        stream: '//LE/task-val-1',
        parent_stream: '//LE/main',
        levels: ['/Game/Levels/LE_Forest_01'],
        exchange_filename: 'factory.fbx',
        exchange_sha256: F1,
        result: 'passed',
        p4_user: 'val',
        editor_build: 'UE 5.5',
        ...overrides
    });

    // -----------------------------------------------------------------
    // RECEIPT
    // -----------------------------------------------------------------

    const noKey = await server.post('/api/integration/receipts', validReceipt());

    report.check('a receipt with no key is refused', noKey.status === 401,
        `expected 401, got ${noKey.status}`);

    const wrongKey = await server.call('POST', '/api/integration/receipts', {
        headers: { Authorization: `Bearer lxk_${'c'.repeat(40)}` },
        body: validReceipt()
    });

    report.check('a receipt with a wrong key is refused', wrongKey.status === 401,
        `expected 401, got ${wrongKey.status}`);

    // THE SWITCH. Off must refuse even with a valid key, and on again must
    // accept: the setting is the exception RULES 2 was granted.
    db.close();

    const writable = new Database(server.dbPath);
    writable.prepare(`UPDATE app_settings SET value = '0' WHERE key = 'integration_tooling'`).run();
    writable.close();

    const off = await receipt(validReceipt({ changelist: 201 }));

    report.check('with tooling off, a valid key is still refused', off.status === 403,
        `expected 403, got ${off.status}`);

    const writableAgain = new Database(server.dbPath);
    writableAgain.prepare(`UPDATE app_settings SET value = '1' WHERE key = 'integration_tooling'`).run();
    writableAgain.close();

    const first = await receipt(validReceipt());

    report.check('a valid receipt is recorded', first.status === 201 && first.json?.recorded === true,
        `expected 201 recorded, got ${first.status} — ${first.text.slice(0, 160)}`);

    report.check('and the changelist the trigger saw is marked confirmed',
        first.json?.trigger_confirmed === true,
        `trigger_confirmed was ${first.json?.trigger_confirmed}`);

    const duplicate = await receipt(validReceipt());

    report.check('the same receipt twice is harmless', duplicate.status === 200
        && duplicate.json?.duplicate === true,
        `expected 200 duplicate, got ${duplicate.status}`);

    const receiptCount = new Database(server.dbPath, { readonly: true })
        .prepare('SELECT COUNT(*) AS n FROM integration_receipts WHERE workspace_version_id = 1 AND changelist = 200')
        .get();

    report.check('and leaves exactly one row', receiptCount.n === 1,
        `found ${receiptCount.n} rows`);

    const badFile = await receipt(validReceipt({ changelist: 202, exchange_sha256: shaOf('not-in-the-version') }));

    report.check('a receipt naming a file the version does not hold is refused',
        badFile.status === 409,
        `expected 409, got ${badFile.status}`);

    const unconfirmed = await receipt(validReceipt({ changelist: 999 }));

    report.check('a changelist the trigger did not see is recorded as unconfirmed',
        unconfirmed.status === 201 && unconfirmed.json?.trigger_confirmed === false,
        `expected 201 unconfirmed, got ${unconfirmed.status} — ${unconfirmed.text.slice(0, 120)}`);

    const failed = await receipt(validReceipt({
        workspace_version_id: 3,
        changelist: 300,
        stream: '//LE/exp',
        parent_stream: null,
        exchange_filename: 'tree.fbx',
        exchange_sha256: F3,
        result: 'failed'
    }));

    report.check('a failed test is recorded rather than thrown away', failed.status === 201,
        `expected 201, got ${failed.status} — ${failed.text.slice(0, 160)}`);

    // -----------------------------------------------------------------
    // SUBMIT
    // -----------------------------------------------------------------

    const noExchange = await server.post('/api/developer/workspace/assets/1/versions/2/creative-approval', {
        destination_kind: 'game',
        destination_stream: '//LE/main'
    }, dev);

    report.check('a game destination without an exchange file is refused',
        noExchange.status === 409,
        `expected 409, got ${noExchange.status} — ${noExchange.text.slice(0, 160)}`);

    const libraryOnly = await server.post('/api/developer/workspace/assets/1/versions/2/creative-approval', {
        destination_kind: 'library'
    }, dev);

    report.check('the same version may go to the library', libraryOnly.status === 201,
        `expected 201, got ${libraryOnly.status} — ${libraryOnly.text.slice(0, 160)}`);

    // v3's only receipt is a FAILED one, and it was in //LE/exp. It must not
    // open a game destination.
    const failedReceiptNoGood = await server.post('/api/developer/workspace/assets/1/versions/3/creative-approval', {
        destination_kind: 'game',
        destination_stream: '//LE/exp'
    }, dev);

    report.check('a failed receipt does not license a game destination',
        failedReceiptNoGood.status === 409,
        `expected 409, got ${failedReceiptNoGood.status}`);

    const wrongStream = await server.post('/api/developer/workspace/assets/1/versions/1/creative-approval', {
        destination_kind: 'game',
        destination_stream: '//LE/exp'
    }, dev);

    report.check('a receipt for another stream does not license this one',
        wrongStream.status === 409,
        `expected 409, got ${wrongStream.status} — ${wrongStream.text.slice(0, 160)}`);

    const submitted = await server.post('/api/developer/workspace/assets/1/versions/1/creative-approval', {
        destination_kind: 'game',
        destination_stream: '//LE/main'
    }, dev);

    report.check('a matching receipt and an exchange file admit the submission',
        submitted.status === 201,
        `expected 201, got ${submitted.status} — ${submitted.text.slice(0, 200)}`);

    const gameApproval = submitted.json?.approval?.id;

    report.check('and the destination is recorded',
        submitted.json?.approval?.destination_kind === 'game'
        && submitted.json?.approval?.destination_stream === '//LE/main',
        `approval said ${submitted.text.slice(0, 160)}`);

    // -----------------------------------------------------------------
    // RETARGET
    // -----------------------------------------------------------------

    const devRetarget = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'library'
    }, dev);

    report.check('a developer cannot retarget a submission', devRetarget.status === 403,
        `expected 403, got ${devRetarget.status}`);

    const noEvidence = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'game',
        destination_stream: '//LE/exp'
    }, prod);

    report.check('production cannot move it to a version nothing was tested in',
        noEvidence.status === 409,
        `expected 409, got ${noEvidence.status} — ${noEvidence.text.slice(0, 200)}`);

    const toLibrary = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'library'
    }, prod);

    report.check('production can move it to the library', toLibrary.status === 200,
        `expected 200, got ${toLibrary.status} — ${toLibrary.text.slice(0, 160)}`);

    const backToGame = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'game',
        destination_stream: '//LE/main'
    }, prod);

    report.check('and back to the version it was tested in', backToGame.status === 200,
        `expected 200, got ${backToGame.status} — ${backToGame.text.slice(0, 160)}`);

    const adminNoReason = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'library'
    }, admin);

    report.check('an administrator without a reason is refused', adminNoReason.status === 400,
        `expected 400, got ${adminNoReason.status}`);

    const adminShort = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'library',
        reason: 'no'
    }, admin);

    report.check('a short reason is not a reason', adminShort.status === 400,
        `expected 400, got ${adminShort.status}`);

    const adminReason = 'Production left this on the wrong build; it belongs in the library.';

    const adminOverride = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'game',
        destination_stream: '//LE/main',
        reason: adminReason
    }, admin);

    report.check('an administrator with a reason can overrule production',
        adminOverride.status === 200,
        `expected 200, got ${adminOverride.status} — ${adminOverride.text.slice(0, 160)}`);

    const afterOverride = new Database(server.dbPath, { readonly: true })
        .prepare('SELECT destination_source, destination_reason FROM creative_approvals WHERE id = ?')
        .get(gameApproval);

    report.check('and the change records who made it and why',
        afterOverride?.destination_source === 'admin'
        && afterOverride?.destination_reason === adminReason,
        `row: ${JSON.stringify(afterOverride)}`);

    const audited = new Database(server.dbPath, { readonly: true })
        .prepare(`
            SELECT * FROM audit_logs
            WHERE action = 'creative_approval.destination' AND actor_id = 3
            ORDER BY id DESC LIMIT 1
        `).get();

    report.check('and the override is in the audit log', Boolean(audited)
        && String(audited.details).includes('wrong build'),
        `audit row: ${JSON.stringify(audited)}`);

    // -----------------------------------------------------------------
    // APPROVE
    // -----------------------------------------------------------------

    const approved = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/approve`,
        { decision_comment: 'good' }, prod);

    report.check('a game-destination submission still approves', approved.status === 200,
        `expected 200, got ${approved.status} — ${approved.text.slice(0, 200)}`);

    const decidedRetarget = await server.post(`/api/developer/workspace/creative-approvals/${gameApproval}/destination`, {
        destination_kind: 'library'
    }, prod);

    report.check('a decided submission is not retargeted', decidedRetarget.status === 409,
        `expected 409, got ${decidedRetarget.status}`);

    // -----------------------------------------------------------------
    // STREAMS
    // -----------------------------------------------------------------

    const streams = await server.get('/api/perforce/streams', dev);

    report.check('a developer can read the streams Perforce named',
        streams.status === 200
        && streams.json?.streams?.some(row => row.stream === '//LE/main'),
        `expected //LE/main, got ${streams.text.slice(0, 160)}`);

    const anonymous = await server.get('/api/perforce/streams');

    report.check('and nobody can', anonymous.status === 401 || anonymous.status === 403,
        `expected a refusal, got ${anonymous.status}`);

    await server.close();
    report.finish('the destination gate and the receipt behave as recorded in TODO 110.');
}

main().catch(err => {
    console.error('\n  FAIL — the check could not run:', err.message, '\n');
    process.exit(1);
});
