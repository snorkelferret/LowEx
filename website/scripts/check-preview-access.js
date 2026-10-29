#!/usr/bin/env node
/**
 * Checks the PREVIEW ROUTE over HTTP — who may see a submitted file, and who
 * may not.
 *
 *   node scripts/check-preview-access.js     # exit 0 = clean
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Every other check is static: schema, route order, DOM ids, naming, store
 * integrity, and the collector's own sequence. NONE of them sends a request.
 * The preview route's access rules were verified by hand on 2026-10-29 with a
 * throwaway script, and hand verification is a proof that lasts until the next
 * change and is remembered by nobody.
 *
 * THIS IS THE FIRST HTTP CHECK in the repository, and it is deliberately the
 * one that matters most: the route serves developer content to a role that is
 * NOT supposed to have a read path into a workspace. If its scoping breaks, it
 * breaks silently — every request still answers 200 — and the only signal is a
 * reviewer seeing something they should not.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   1. prod sees its own submission          200, image/webp, nosniff
 *   2. and receives the PREVIEW, not the file  the bytes are the WebP, not the blob
 *   3. a real file from another submission   404 — scoping is by the approval
 *   4. a file in the submission with no preview 404
 *   5. a developer                           403
 *   6. an administrator                      403 — admin acts by impersonation
 *   7. no session                            401
 *   8. a malformed hash                      400
 *   9. a malformed approval id               400
 *  10. an approval that does not exist       404
 *
 * ============================================================
 * HOW, WITHOUT TOUCHING ANYTHING REAL
 * ============================================================
 *
 * scripts/lib/check-harness.js copies the schema into a throwaway database,
 * creates throwaway storage directories, and mounts the REAL router on a
 * throwaway Express app. The live database is opened read-only and never
 * written; nothing is added to the live store or the live previews.
 *
 * The server is mounted IN PROCESS rather than spawned, so there is no port to
 * collide with and no second copy of server.js's configuration to drift.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Reporter, startCheckServer } = require('./lib/check-harness');

const shaOf = label => crypto.createHash('sha256').update(`check-preview:${label}`).digest('hex');

async function main() {
    const report = new Reporter();

    const A = shaOf('a');
    const B = shaOf('b');
    const C = shaOf('c');

    // A REAL WEBP FOR THE PREVIEW, and deliberately DIFFERENT bytes for the
    // blob: the check can then prove that what came back is the derived
    // picture, not the developer's file.
    const sharp = require('sharp');
    const previewBytes = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#333333' }
    }).webp().toBuffer();

    const server = await startCheckServer({
        prefix: 'lowex-preview-',
        route: 'backend/routes/developerWorkspace',
        mount: '/api/developer/workspace',

        seed(db, dirs) {
            // Two submissions, three files:
            //
            //   version 1  -> approval 1   file A (has a preview), file C (none)
            //   version 2  -> approval 2   file B (has a preview)
            //
            // so "a file that exists but is not in this approval" is real
            // rather than a hash nobody has.
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'prod-check', 'prod@check.invalid', 'x', 'prod', 1),
                    (2, 'dev-check',  'dev@check.invalid',  'x', 'developer', 1),
                    (3, 'admin-check','admin@check.invalid','x', 'admin', 1);

                INSERT INTO developer_workspaces (id, developer_id) VALUES (1, 2);
                INSERT INTO workspace_assets (id, workspace_id, name) VALUES (1, 1, 'PreviewTest');

                INSERT INTO workspace_versions
                    (id, workspace_asset_id, version_number, created_by, version_note)
                VALUES
                    (1, 1, 1, 2, 'first'),
                    (2, 1, 2, 2, 'second');

                INSERT INTO stored_files (id, sha256, storage_key, file_size)
                VALUES
                    (1, '${A}', '${A}', 30),
                    (2, '${B}', '${B}', 30),
                    (3, '${C}', '${C}', 30);

                INSERT INTO workspace_version_files
                    (workspace_version_id, stored_file_id, filename, relative_path)
                VALUES
                    (1, 1, 'a.png', ''),
                    (1, 3, 'c.png', ''),
                    (2, 2, 'b.png', '');

                INSERT INTO creative_approvals
                    (id, workspace_asset_id, workspace_version_id, requested_by, status)
                VALUES
                    (1, 1, 1, 2, 'pending'),
                    (2, 1, 2, 2, 'pending');

                INSERT INTO file_thumbnails (stored_file_id, kind, storage_key, width, height)
                VALUES (1, 'image', '${A}', 8, 8);
            `);

            fs.writeFileSync(path.join(dirs.thumbs, `${A}_image.webp`), previewBytes);
            fs.writeFileSync(path.join(dirs.blobs, A), 'THE ORIGINAL FILE, WHICH MUST NOT BE SERVED');
        }
    });

    const prod = server.tokenFor(1);
    const dev = server.tokenFor(2);
    const admin = server.tokenFor(3);

    // -----------------------------------------------------------------
    // The answers
    // -----------------------------------------------------------------

    const own = await server.get(`/creative-approvals/1/preview/${A}`, prod);

    report.check('prod sees its own submission', own.status === 200,
        `expected 200, got ${own.status}`);

    report.check('it is served as a WebP', /image\/webp/.test(own.headers.get('content-type') || ''),
        `content-type was ${own.headers.get('content-type')}`);

    report.check('and with nosniff', own.headers.get('x-content-type-options') === 'nosniff',
        `x-content-type-options was ${own.headers.get('x-content-type-options')}`);

    report.check('and it is the PREVIEW, not the file', own.body.equals(previewBytes),
        'the response was not the preview the check wrote — if it is the blob, the route is serving developer content');

    const otherVersion = await server.get(`/creative-approvals/1/preview/${B}`, prod);

    report.check('a real file from another submission is not served',
        otherVersion.status === 404,
        `expected 404, got ${otherVersion.status}`);

    const noPreview = await server.get(`/creative-approvals/1/preview/${C}`, prod);

    report.check('a file with no preview answers 404', noPreview.status === 404,
        `expected 404, got ${noPreview.status}`);

    const developer = await server.get(`/creative-approvals/1/preview/${A}`, dev);

    report.check('a developer is refused', developer.status === 403,
        `expected 403, got ${developer.status}`);

    // DELIBERATE, and worth failing if it ever changes: an administrator does
    // not see submissions either. Admin acts by impersonation (RULES.md 7); if
    // admin is ever added to this list, that is a decision, not a patch.
    const administrator = await server.get(`/creative-approvals/1/preview/${A}`, admin);

    report.check('an administrator is refused', administrator.status === 403,
        `expected 403, got ${administrator.status} — adding admin here is a decision (see docs/RULES.md 7)`);

    const nobody = await server.get(`/creative-approvals/1/preview/${A}`, null);

    report.check('no session is refused', nobody.status === 401,
        `expected 401, got ${nobody.status}`);

    const badHash = await server.get('/creative-approvals/1/preview/not-a-sha', prod);

    report.check('a malformed hash is a 400', badHash.status === 400,
        `expected 400, got ${badHash.status}`);

    const badId = await server.get(`/creative-approvals/abc/preview/${A}`, prod);

    report.check('a malformed approval id is a 400', badId.status === 400,
        `expected 400, got ${badId.status}`);

    const missing = await server.get(`/creative-approvals/999/preview/${A}`, prod);

    report.check('a missing approval is a 404', missing.status === 404,
        `expected 404, got ${missing.status}`);

    // -----------------------------------------------------------------

    await server.close();

    report.finish('the preview route serves prod its own submission, and nothing else');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
