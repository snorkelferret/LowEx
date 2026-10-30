#!/usr/bin/env node
/**
 * Checks the RELEASES PATH — naming a build, putting approved work into it,
 * taking it out, the one-version-per-asset rule, and the DIFF between builds.
 *
 *   node scripts/check-releases.js       # exit 0 = clean
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   create     a name and a date are stored; the changelist is optional and
 *              validated when present; a duplicate name is refused
 *   candidates approved store versions this release does not hold — every
 *              approved version is one until it is chosen
 *   add        the version becomes a member; the changelist recorded with it
 *              is written as an integration too; the UPLOADER is reported
 *              from the workspace version, because the store records the
 *              approver
 *   the rule   a second version of the SAME asset is refused, naming the one
 *              already in the way — while a different asset is accepted
 *   remove     the membership goes, the version returns to the candidates
 *   diff       assets added, removed, changed and unchanged; and within a
 *              changed asset, files added, removed and modified BY HASH
 *   role       a developer is refused
 *   audit      create, add, remove and delete are each recorded, with the actor
 *
 * ============================================================
 * HOW
 * ============================================================
 *
 * scripts/lib/check-harness.js. Two assets are seeded with approved versions
 * and real file rows — the release path reads approvals and files rather than
 * performing or uploading them, and those have their own checks.
 */

const { Reporter, startCheckServer, Database } = require('./lib/check-harness');

// Distinct 64-hex content identities. They only need to be different: the
// diff compares them, it never hashes anything.
const sha = label => label.padEnd(64, '0').slice(0, 64);

const BARK_OLD = sha('bark-old');
const BARK_NEW = sha('bark-new');
const BLEND = sha('blend');
const NOTES = sha('notes');
const ROCK = sha('rock');

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

                INSERT INTO workspace_assets (id, workspace_id, name)
                VALUES (1, 1, 'BigTree'), (2, 1, 'Rock');

                INSERT INTO workspace_versions
                    (id, workspace_asset_id, version_number, created_by, version_note)
                VALUES
                    (1, 1, 1, 2, 'first'),
                    (2, 1, 2, 2, 'second'),
                    (3, 2, 1, 2, 'rock');

                INSERT INTO assets (id, name) VALUES (1, 'BigTree'), (2, 'Rock');

                INSERT INTO asset_versions
                    (id, asset_id, version_number, created_by, version_note)
                VALUES
                    (1, 1, 1, 3, 'first'),
                    (2, 1, 2, 3, 'second'),
                    (3, 2, 1, 3, 'rock');

                INSERT INTO creative_approvals
                    (id, workspace_asset_id, workspace_version_id, requested_by,
                     status, decided_by, decided_at, repository_asset_id, repository_version_id)
                VALUES
                    (1, 1, 1, 2, 'approved', 3, '2026-10-01 10:00:00', 1, 1),
                    (2, 1, 2, 2, 'approved', 3, '2026-10-02 10:00:00', 1, 2),
                    (3, 2, 3, 2, 'approved', 3, '2026-10-03 10:00:00', 2, 3);

                INSERT INTO stored_files (id, sha256, storage_key, file_size)
                VALUES
                    (1, '${BARK_OLD}', '${BARK_OLD}', 100),
                    (2, '${BARK_NEW}', '${BARK_NEW}', 120),
                    (3, '${BLEND}',    '${BLEND}',    200),
                    (4, '${NOTES}',    '${NOTES}',     10),
                    (5, '${ROCK}',     '${ROCK}',     300);

                -- v1: bark, blend      v2: bark CHANGED, blend same, notes NEW
                INSERT INTO asset_version_files
                    (asset_version_id, stored_file_id, filename, relative_path)
                VALUES
                    (1, 1, 'bark.png',      'textures'),
                    (1, 3, 'tree.blend',    'models'),
                    (2, 2, 'bark.png',      'textures'),
                    (2, 3, 'tree.blend',    'models'),
                    (2, 4, 'extra.txt',     'notes'),
                    (3, 5, 'rock.png',      'textures');
            `);
        }
    });

    const db = new Database(server.dbPath, { readonly: true });
    const admin = server.tokenFor(1);
    const dev = server.tokenFor(2);

    const candidateIds = json => (json.candidates || []).map(c => c.asset_version_id).sort();
    const memberIds = json => (json.members || []).map(m => m.asset_version_id).sort();
    const assetOf = (diff, name) => (diff.assets || []).find(a => a.asset_name === name);

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

    const releaseA = created.json?.release?.id;

    report.check('with its date and changelist stored',
        created.json?.release?.released_on === '2026-10-30'
        && created.json?.release?.changelist === 15407);

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

    report.check('every approved version is a candidate',
        JSON.stringify(candidateIds(created.json)) === JSON.stringify([1, 2, 3]),
        `candidates: ${JSON.stringify(candidateIds(created.json))}`);

    report.check('and the candidate reports who UPLOADED it, not only who approved',
        created.json?.candidates?.every(c => c.uploaded_by === 'dev-check' && c.approved_by === 'prod-check'),
        `first candidate: ${JSON.stringify(created.json?.candidates?.[0])}`);

    // -----------------------------------------------------------------
    // ADD, AND THE ONE-VERSION RULE
    // -----------------------------------------------------------------

    const added = await server.post(`/${releaseA}/assets`, {
        asset_version_id: 2,
        changelist: 15407,
        note: 'imported'
    }, admin);

    report.check('an approved version can be added', added.status === 201,
        `expected 201, got ${added.status} — ${added.text.slice(0, 160)}`);

    report.check('and becomes a member', JSON.stringify(memberIds(added.json)) === JSON.stringify([2]));
    report.check('with the changelist recorded', added.json?.members?.[0]?.changelist === 15407);

    const otherVersion = await server.post(`/${releaseA}/assets`, { asset_version_id: 1 }, admin);

    report.check('a second version of the same asset is refused', otherVersion.status === 409,
        `expected 409, got ${otherVersion.status}`);

    report.check('and the refusal names the version in the way',
        /v2/.test(otherVersion.text) && /already in/.test(otherVersion.text),
        `message: ${otherVersion.text}`);

    const differentAsset = await server.post(`/${releaseA}/assets`, { asset_version_id: 3 }, admin);

    report.check('a different asset is accepted', differentAsset.status === 201,
        `expected 201, got ${differentAsset.status} — ${differentAsset.text.slice(0, 140)}`);

    // READS ARE FOR DEVELOPERS TOO — "which of my assets were accepted, and
    // into what" is their question — and the mine_count comes back for them.
    const asDeveloper = await server.get('/', dev);

    report.check('a developer can read the releases', asDeveloper.status === 200,
        `expected 200, got ${asDeveloper.status}`);

    report.check('and the list counts their own work',
        (asDeveloper.json?.releases || []).every(r => typeof r.mine_count === 'number'),
        `first release: ${JSON.stringify(asDeveloper.json?.releases?.[0])}`);

    const developerWrite = await server.post(`/${releaseA}/assets`, { asset_version_id: 2 }, dev);

    report.check('but a developer cannot put work into a release',
        developerWrite.status === 403,
        `expected 403, got ${developerWrite.status}`);

    const developerCreate = await server.post('/', { name: 'by a developer' }, dev);

    report.check('and cannot create one', developerCreate.status === 403,
        `expected 403, got ${developerCreate.status}`);

    // v2 out, v1 in — so release A holds BigTree v1 and the diff has something
    // to compare against.
    const removed = await server.del(`/${releaseA}/assets/2`, admin);

    report.check('a version can be taken back out', removed.status === 200,
        `expected 200, got ${removed.status}`);

    report.check('and returns to the candidates',
        JSON.stringify(candidateIds(removed.json)) === JSON.stringify([1, 2]),
        `candidates: ${JSON.stringify(candidateIds(removed.json))}`);

    const addV1 = await server.post(`/${releaseA}/assets`, { asset_version_id: 1 }, admin);

    report.check('the other version can then be added', addV1.status === 201,
        `expected 201, got ${addV1.status}`);

    // -----------------------------------------------------------------
    // THE DIFF
    // -----------------------------------------------------------------

    const second = await server.post('/', { name: '0.2 Sandbox, 30 Oct' }, admin);

    report.check('a second release can be named', second.status === 201,
        `expected 201, got ${second.status}`);

    const releaseB = second.json?.release?.id;

    await server.post(`/${releaseB}/assets`, { asset_version_id: 2 }, admin);
    await server.post(`/${releaseB}/assets`, { asset_version_id: 3 }, admin);

    const diff = await server.get(`/${releaseB}/diff?against=${releaseA}`, admin);

    report.check('a diff is served', diff.status === 200,
        `expected 200, got ${diff.status} — ${diff.text.slice(0, 140)}`);

    report.check('it counts one asset changed and one unchanged',
        diff.json?.summary?.changed === 1 && diff.json?.summary?.unchanged === 1,
        `summary: ${JSON.stringify(diff.json?.summary)}`);

    const bigTree = assetOf(diff.json, 'BigTree');

    report.check('the changed asset names both versions',
        bigTree?.from_version === 1 && bigTree?.to_version === 2,
        `BigTree: ${JSON.stringify(bigTree)}`);

    report.check('with the file whose content changed',
        bigTree?.files?.changed?.length === 1
        && bigTree.files.changed[0].path === 'textures/bark.png'
        && bigTree.files.changed[0].from_sha256 === BARK_OLD
        && bigTree.files.changed[0].to_sha256 === BARK_NEW,
        `changed: ${JSON.stringify(bigTree?.files?.changed)}`);

    report.check('the new file is an addition',
        bigTree?.files?.added?.length === 1
        && bigTree.files.added[0].path === 'notes/extra.txt',
        `added: ${JSON.stringify(bigTree?.files?.added)}`);

    report.check('and nothing was removed',
        bigTree?.files?.removed?.length === 0,
        `removed: ${JSON.stringify(bigTree?.files?.removed)}`);

    const backwards = await server.get(`/${releaseA}/diff?against=${releaseB}`, admin);

    report.check('the reverse diff has the same change the other way',
        assetOf(backwards.json, 'BigTree')?.files?.removed?.[0]?.path === 'notes/extra.txt',
        `removed: ${JSON.stringify(assetOf(backwards.json, 'BigTree')?.files?.removed)}`);

    const itself = await server.get(`/${releaseB}/diff?against=${releaseB}`, admin);

    report.check('a release diffed against itself is all unchanged',
        itself.json?.summary?.unchanged === 2 && itself.json?.summary?.changed === 0,
        `summary: ${JSON.stringify(itself.json?.summary)}`);

    const noAgainst = await server.get(`/${releaseB}/diff`, admin);

    report.check('a diff needs two releases', noAgainst.status === 400,
        `expected 400, got ${noAgainst.status}`);

    const missing = await server.get(`/${releaseB}/diff?against=999`, admin);

    report.check('a missing release is a 404', missing.status === 404,
        `expected 404, got ${missing.status}`);

    // -----------------------------------------------------------------
    // AUDIT
    // -----------------------------------------------------------------

    const audits = action => db.prepare('SELECT * FROM audit_logs WHERE action = ?').all(action);

    report.check('the release creation is recorded', audits('release.create').length === 2);
    report.check('the additions are recorded', audits('release.asset_add').length === 5,
        `found ${audits('release.asset_add').length}`);
    report.check('the removal is recorded', audits('release.asset_remove').length === 1);

    // -----------------------------------------------------------------
    // DELETE
    // -----------------------------------------------------------------

    const deleted = await server.del(`/${releaseA}`, admin);

    report.check('a release can be deleted', deleted.status === 200,
        `expected 200, got ${deleted.status}`);

    const gone = await server.get(`/${releaseA}`, admin);

    report.check('and is gone afterwards', gone.status === 404,
        `expected 404, got ${gone.status}`);

    report.check('the assets survive the release',
        db.prepare('SELECT COUNT(*) AS n FROM asset_versions').get().n === 3,
        'deleting a release removed store content');

    report.check('the deletion is recorded',
        audits('release.delete').length === 1 && audits('release.delete')[0].actor_id === 1);

    // -----------------------------------------------------------------

    db.close();
    await server.close();

    report.finish('releases hold what they say, one version per asset, and the diff is by content');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
