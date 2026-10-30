#!/usr/bin/env node
/**
 * Checks who may READ the library and who may CHANGE it.
 *
 *   node scripts/check-library-access.js    # exit 0 = clean
 *
 * ============================================================
 * WHY THIS ONE
 * ============================================================
 *
 * The library was developer+admin on every route, read and write alike. Item 83
 * opened the READ side to production — reviewing is reading — and that is a
 * change to a permission boundary, which is exactly the kind that fails
 * silently: a role added to one route and not the next, or added to a write by
 * a copy-pasted list.
 *
 * The store's equivalent is covered in check-download-round-trip; this is the
 * library's half.
 *
 * ============================================================
 * WHAT IT PROVES
 * ============================================================
 *
 *   read    developer 200, production 200, nobody 401
 *   write   production refused on upload, update and remove — 403, not 401
 *           (403 says the session was understood and the role was not)
 */

const { Reporter, startCheckServer } = require('./lib/check-harness');

async function main() {
    const report = new Reporter();

    const server = await startCheckServer({
        prefix: 'lowex-library-access-',
        route: 'backend/routes/library',
        mount: '/api/library',

        seed(db) {
            db.exec(`
                INSERT INTO users (id, username, email, password_hash, role, is_active)
                VALUES
                    (1, 'dev-check',  'dev@check.invalid',  'x', 'developer', 1),
                    (2, 'prod-check', 'prod@check.invalid', 'x', 'prod', 1);
            `);
        }
    });

    const dev = server.tokenFor(1);
    const prod = server.tokenFor(2);

    // -----------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------

    const devList = await server.get('/', dev);
    report.check('a developer can read the library', devList.status === 200,
        `expected 200, got ${devList.status}`);

    const prodList = await server.get('/', prod);
    report.check('production can read the library', prodList.status === 200,
        `expected 200, got ${prodList.status} — ${prodList.text.slice(0, 120)}`);

    const prodMissing = await server.get('/999/thumbnail', prod);
    report.check('and production reaches the thumbnail route, not the gate',
        prodMissing.status === 404,
        `expected 404 for a missing item, got ${prodMissing.status}`);
    // 403 here would mean the ROLE was refused; 404 means the role passed and
    // the item did not exist, which is the distinction that matters.

    const nobody = await server.get('/', null);
    report.check('nobody is refused', nobody.status === 401,
        `expected 401, got ${nobody.status}`);

    // -----------------------------------------------------------------
    // WRITE
    // -----------------------------------------------------------------

    const prodUpload = await server.post('/upload', {}, prod);
    report.check('production cannot upload', prodUpload.status === 403,
        `expected 403, got ${prodUpload.status}`);

    const prodUpdate = await server.post('/1/update', {}, prod);
    report.check('production cannot edit an item', prodUpdate.status === 403,
        `expected 403, got ${prodUpdate.status}`);

    const prodRemove = await server.post('/1/remove', {}, prod);
    report.check('production cannot remove an item', prodRemove.status === 403,
        `expected 403, got ${prodRemove.status}`);

    // A developer PASSES the gate on the same route: the refusal above is about
    // the role, not about the body parser being reached first.
    const devUpdate = await server.post('/1/update', {}, dev);
    report.check('a developer reaches the same route the refusal came from',
        devUpdate.status !== 403,
        `expected anything but 403 for a developer, got ${devUpdate.status}`);

    // -----------------------------------------------------------------

    await server.close();

    report.finish('the library is readable by production and writable by nobody who only reads');
}

main().catch(err => {
    console.error('\n  check FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
