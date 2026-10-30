#!/usr/bin/env node
/**
 * Checks the RELEASES PATH — naming a build, putting approved work into it,
 * taking it out, and the one-version-per-asset rule.
 *
 *   node scripts/check-releases.js       # exit 0 = clean
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   create     a name and a date are stored; the changelist is optional and
 *              validated when present; a duplicate name is refused
 *   candidates approved store versions this release does not hold — BOTH
 *              versions of an asset are candidates until one is chosen
 *   add        the version becomes a member; the changelist recorded with it
 *              is written as an integration too
 *   the rule   a second version of the SAME asset is refused, and the refusal
 *              NAMES the version already in the way
 *   remove     the membership goes, the version returns to the candidates
 *   role       a developer is refused
 *   audit      create, add and remove are each recorded, with the actor
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * scripts/lib/check-harness.js. The store is seeded with one asset, two
 * approved versions and their approvals — the release path reads approvals
 * rather than performing them, and the approval path has its own check.
 */

const { Reporter, startCheckServer, Database } = require('./lib/check-harness');

async function main() {
    const report = new Reporter();

    const server = await startCheckServer({
        prefix: 'lowex-releases-',
        route: 'backend/routes/releases',
        mount: '/api/releases',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'admin-check', 'admin@check.invalid', 'x', 'admin', 1),
                    (2, 'dev-check',   'dev@check.invalid',   'x', 'developer', 1),
                    (3, 'prod-check',  'prod@check.invalid',  'x', 'prod', 1);

                INSERT INTO developer_workspaces (id, developer_id) VALUES (1, 2);
                INSERT INTO workspace_assets (id, workspace_id, name) VALUES (1, 1, 'BigTree');

                INSERT INTO workspace_versions
                    (id, workspace_asset_id, version_number, created_by, version_note)
                VALUES
                    (1, 1, 1, 2, 'first'),
                    (2, 1, 2, 2, 'second');

                INSERT INTO assets (id, name) VALUES (1, 'BigTree');

                INSERT INTO asset_versions
                    (id, asset_id, version_number, created_by, version_note)
                VALUES
                    (1, 1, 1, 3, 'first'),
                    (2, 1, 2, 3, 'second');

                -- Approved, which is what makes them candidates.
                INSERT INTO creative_approvals
                    (id, workspace_asset_id, workspace_version_id, requested_by,
                     status, decided_by, decided_at, repository_asset_id, repository_version_id)
                VALUES
                    (1, 1, 1, 2, 'approved', 3, '2026-10-01 10:00:00', 1, 1),
                    (2, 1, 2, 2, 'approved', 3, '2026-10-02 10:00:00', 1, 2);
            `);
        }
    });

    const db = new Database(server.dbPath, { readonly: true });
    const admin = server.tokenFor(1);
    const dev = server.tokenFor(2);

    const candidateIds = json => (json.candidates || []).map(c => c.asset_version_id).sort();
    const memberIds = json => (json.members || []).map(m => m.asset_version_id).sort();

    // -----------------------------------------------------------------
    // CREATE
    // -----------------------------------------------------------------

    const created = await server.post('/', {
        name: '0.1 Sandbox, 30 Oct',
        released_on: '2026-10-30',
        changelist: 15407,
        notes: 'first'
    }, admin);

    report.check('a release can be named', created.status === 201,
        `expected 201, got ${created.status} — ${created.text.slice(0, 140)}`);

    const releaseId = created.json?.release?.id;

    report.check('with its date and changelist stored',
        created.json?.release?.released_on === '2026-10-30'
        && created.json?.release?.changelist === 15407,
        `release: ${JSON.stringify(created.json?.release)}`);

    const duplicate = await server.post('/', { name: '0.1 Sandbox, 30 Oct' }, admin);

    report.check('a duplicate name is refused', duplicate.status === 409,
        `expected 409, got ${duplicate.status}`);

    const badDate = await server.post('/', { name: 'bad date', released_on: '30/10/2026' }, admin);

    report.check('a malformed date is a 400', badDate.status === 400,
        `expected 400, got ${badDate.status}`);

    const badCl = await server.post('/', { name: 'bad cl', changelist: 'abcd' }, admin);

    report.check('a malformed changelist is a 400', badCl.status === 400,
        `expected 400, got ${badCl.status}`);

    // -----------------------------------------------------------------
    // CANDIDATES
    // -----------------------------------------------------------------

    report.check('both approved versions are candidates',
        JSON.stringify(candidateIds(created.json)) === JSON.stringify([1, 2]),
        `candidates: ${JSON.stringify(candidateIds(created.json))}`);

    report.check('and the release is empty', memberIds(created.json).length === 0);

    // -----------------------------------------------------------------
    // ADD, AND THE ONE-VERSION RULE
    // -----------------------------------------------------------------

    const added = await server.post(`/${releaseId}/assets`, {
        asset_version_id: 2,
        changelist: 15407,
        note: 'imported'
    }, admin);

    report.check('an approved version can be added', added.status === 201,
        `expected 201, got ${added.status} — ${added.text.slice(0, 160)}`);

    report.check('and becomes a member', JSON.stringify(memberIds(added.json)) === JSON.stringify([2]),
        `members: ${JSON.stringify(memberIds(added.json))}`);

    report.check('with the changelist recorded', added.json?.members?.[0]?.changelist === 15407,
        `member: ${JSON.stringify(added.json?.members?.[0])}`);

    const integration = db.prepare(
        'SELECT * FROM asset_integrations WHERE asset_version_id = 2 ORDER BY id DESC LIMIT 1'
    ).get();

    report.check('the changelist is also recorded as an integration',
        integration?.changelist === 15407 && integration?.integrated_by === 1,
        `integration row: ${JSON.stringify(integration)}`);

    const otherVersion = await server.post(`/${releaseId}/assets`, { asset_version_id: 1 }, admin);

    report.check('a second version of the same asset is refused', otherVersion.status === 409,
        `expected 409, got ${otherVersion.status}`);

    report.check('and the refusal names the version in the way',
        /v2/.test(otherVersion.text) && /already in/.test(otherVersion.text),
        `message: ${otherVersion.text}`);

    report.check('the other version is still a candidate',
        JSON.stringify(candidateIds(added.json)) === JSON.stringify([1]),
        `candidates: ${JSON.stringify(candidateIds(added.json))}`);

    // -----------------------------------------------------------------
    // ROLE
    // -----------------------------------------------------------------

    const asDeveloper = await server.get('/', dev);

    report.check('a developer is refused', asDeveloper.status === 403,
        `expected 403, got ${asDeveloper.status}`);

    // -----------------------------------------------------------------
    // REMOVE
    // -----------------------------------------------------------------

    const removed = await server.del(`/${releaseId}/assets/2`, admin);

    report.check('a version can be taken back out', removed.status === 200,
        `expected 200, got ${removed.status} — ${removed.text.slice(0, 120)}`);

    report.check('and it returns to the candidates',
        JSON.stringify(candidateIds(removed.json)) === JSON.stringify([1, 2]),
        `candidates: ${JSON.stringify(candidateIds(removed.json))}`);

    // -----------------------------------------------------------------
    // AUDIT
    // -----------------------------------------------------------------

    const audits = action => db.prepare('SELECT * FROM audit_logs WHERE action = ?').all(action);

    report.check('the release creation is recorded',
        audits('release.create').length === 1 && audits('release.create')[0].actor_id === 1);

    report.check('the addition is recorded',
        audits('release.asset_add').length === 1 && audits('release.asset_add')[0].actor_id === 1);

    report.check('the removal is recorded',
        audits('release.asset_remove').length === 1 && audits('release.asset_remove')[0].actor_id === 1);

    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // DELETE
    // -----------------------------------------------------------------

    const deleted = await server.del(`/${releaseId}`, admin);

    report.check('a release can be deleted', deleted.status === 200,
        `expected 200, got ${deleted.status}`);

    const gone = await server.get(`/${releaseId}`, admin);

    report.check('and is gone afterwards', gone.status === 404,
        `expected 404, got ${gone.status}`);

    report.check('the assets survive the release',
        db.prepare('SELECT COUNT(*) AS n FROM asset_versions').get().n === 2,
        'deleting a release removed store content');

    report.check('the deletion is recorded',
        audits('release.delete').length === 1 && audits('release.delete')[0].actor_id === 1);

    // -----------------------------------------------------------------

    db.close();
    await server.close();

    report.finish('releases hold what they say, one version per asset, and record who did it');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
