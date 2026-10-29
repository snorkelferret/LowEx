// scripts/lib/check-harness.js
//
// THE PIECES EVERY HTTP CHECK NEEDS — a throwaway database built from the live
// schema, throwaway storage directories, the real routes mounted on a
// throwaway Express app, tokens, requests and a report.
//
// ============================================================
// WHY IT IS A MODULE AND NOT COPY-PASTE
// ============================================================
//
// Extracted the first time a second check needed it (the preview route, then
// the approval path). Two copies of "copy the schema, set five environment
// variables, mount the router" would agree on the day they were written and
// disagree the first time one of them forgot a step — and the one that forgot
// would be a check silently testing the wrong database.
//
// See docs/RULES.md 5.
//
// ============================================================
// WHAT IT TOUCHES
// ============================================================
//
// The live database is opened READ-ONLY, and only to copy its schema. The
// throwaway database, the blob store, the temp directory and the previews all
// live under one mkdtemp directory that is removed at the end. Nothing the
// portal holds is read for content or written.
//
// The application is pointed at that world through the four variables it
// already documents — DB_PATH, STORE_DIR, TMP_DIR, THUMB_DIR — so the REAL
// code runs: the real routes, the real middleware, the real statements.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

require('dotenv').config({ quiet: true });

const ROOT = path.join(__dirname, '../..');

// Captured at load, before startCheckServer replaces the environment: this is
// where the schema is copied FROM.
const SOURCE_DB = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(ROOT, 'backend/database.db');

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

class Reporter {
    constructor() {
        this.failures = 0;
    }

    check(label, condition, detail) {
        if (condition) {
            console.log(`  ok     : ${label}`);
            return true;
        }

        this.failures++;
        console.log(`  FAIL   : ${label}`);
        if (detail) console.log(`           ${detail}`);
        return false;
    }

    finish(passMessage) {
        if (this.failures > 0) {
            console.log(`\n  FAILED — ${this.failures} problem(s)\n`);
            process.exit(1);
        }

        console.log(`\n  PASS — ${passMessage}\n`);
    }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function copySchema(target) {
    const source = new Database(SOURCE_DB, { readonly: true, fileMustExist: true });

    const ddl = source.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END
    `).all();

    source.close();

    for (const { sql } of ddl) target.exec(sql);
}

/**
 * Build the throwaway world, seed it, mount the real routes on it, and start
 * listening on a port the operating system chooses.
 *
 *   prefix  a name for the temporary directory, so a leftover is identifiable
 *   route   the router to mount, relative to the repository root
 *   mount   where to mount it, as the real server does
 *   seed    (db, dirs) => {}, called against the throwaway database and the
 *           throwaway directories before the application requires it. This is
 *           where fixtures go.
 *
 * Returns { dbPath, tmp, dirs, base, tokenFor, get, post, close }.
 */
async function startCheckServer({ prefix, route, mount, seed }) {
    if (!fs.existsSync(SOURCE_DB)) {
        console.error(`\n  FAIL — no database at ${SOURCE_DB} to copy the schema from\n`);
        process.exit(1);
    }

    if (!process.env.JWT_SECRET) {
        console.error('\n  FAIL — JWT_SECRET is not set, and the middleware will not verify anything without it\n');
        process.exit(1);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const dbPath = path.join(tmp, 'database.db');
    const dirs = {
        blobs: path.join(tmp, 'files'),
        temp: path.join(tmp, 'tmp'),
        thumbs: path.join(tmp, 'thumbs')
    };

    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    copySchema(db);
    seed(db, dirs);
    db.close();

    // BEFORE anything that builds a handle or a path is required.
    process.env.DB_PATH = dbPath;
    process.env.STORE_DIR = dirs.blobs;
    process.env.TMP_DIR = dirs.temp;
    process.env.THUMB_DIR = dirs.thumbs;

    // db.js announces every migration on load; that output would bury the
    // results. Restored immediately afterwards.
    const realLog = console.log;
    console.log = () => {};

    let express;
    let cookieParser;
    let router;

    try {
        express = require('express');
        cookieParser = require('cookie-parser');
        router = require(path.join(ROOT, route));
    } finally {
        console.log = realLog;
    }

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(mount, router);

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));

    const base = `http://127.0.0.1:${server.address().port}${mount}`;

    const jwt = require('jsonwebtoken');

    // The middleware re-reads the role from the database, so the token's role
    // claim is decoration — the seeded user is what decides.
    const tokenFor = sub => jwt.sign(
        { sub, username: `user-${sub}`, role: 'ignored-by-the-middleware' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    const request = async (method, url, { token, body } = {}) => {
        const headers = {};

        if (token) headers.Cookie = `token=${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        const response = await fetch(base + url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        // THE BODY IS READ AS BYTES, not as text. A WebP is not UTF-8, and
        // decoding it as text replaces every invalid byte — which would make a
        // check comparing image bytes compare two differently-corrupted
        // strings and pass for the wrong reason.
        const bytes = Buffer.from(await response.arrayBuffer());

        let json = null;
        try { json = bytes.length ? JSON.parse(bytes.toString('utf8')) : null; } catch { /* not JSON */ }

        return {
            status: response.status,
            headers: response.headers,
            text: bytes.toString('utf8'),
            body: bytes,
            json
        };
    };

    return {
        dbPath,
        tmp,
        dirs,
        base,
        tokenFor,
        get: (url, token) => request('GET', url, { token }),
        post: (url, body, token) => request('POST', url, { token, body }),
        del: (url, token) => request('DELETE', url, { token }),
        close: async () => {
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    };
}

module.exports = { Reporter, startCheckServer, Database };
