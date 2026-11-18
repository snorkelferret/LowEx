// backend/lib/apiKeys.js
//
// KEYS FOR PROGRAMS, NOT PEOPLE.
//
// ============================================================
// WHY A KEY AND NOT A SESSION
// ============================================================
//
// The in-editor tool (TODO 109) is a program running on a developer's machine.
// It cannot sign in: there is no browser, no cookie, and asking a person to
// paste a session token into an editor plugin is a credential copied through a
// clipboard.
//
// A key is issued once, kept in a file, and carries ONE capability. It is not a
// user, it does not appear in the accounts list, and it cannot approve, browse
// or administer anything.
//
// ============================================================
// THE STORED FORM
// ============================================================
//
// The key itself is never stored. What is kept is:
//
//   key_prefix   the first few characters, for finding the row without
//                comparing against every hash in the table
//   key_hash     sha256 of the whole key
//
// The comparison is timing-safe. A key is a secret, and an early return on the
// first differing byte leaks how much of a guess was right — the same reasoning
// as the Perforce trigger token.
//
// ============================================================
// THE SHAPE
// ============================================================
//
//   lxk_<40 hex characters>
//
// The prefix is deliberate. A secret that cannot be recognised in a log or a
// pasted error is a secret that gets emailed. `lxk_` says what it is.

const crypto = require('crypto');
const db = require('../db');

const PREFIX_LENGTH = 12;

const insertKey = db.prepare(`
    INSERT INTO api_keys (name, key_prefix, key_hash)
    VALUES (?, ?, ?)
`);

const findByPrefix = db.prepare(`
    SELECT id, name, key_prefix, key_hash, created_at, last_used
    FROM api_keys
    WHERE key_prefix = ?
`);

const touchKey = db.prepare(`
    UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?
`);

const listKeys = db.prepare(`
    SELECT id, name, key_prefix, created_at, last_used
    FROM api_keys
    ORDER BY id DESC
`);

const deleteKey = db.prepare('DELETE FROM api_keys WHERE id = ?');

function hashKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * Issue a key. The plaintext is returned ONCE and never stored — the caller
 * prints it and the person puts it in the tool's environment file.
 */
function createKey(name) {
    const key = `lxk_${crypto.randomBytes(20).toString('hex')}`;

    insertKey.run(
        String(name || 'unnamed tool'),
        key.slice(0, PREFIX_LENGTH),
        hashKey(key)
    );

    return { key, prefix: key.slice(0, PREFIX_LENGTH) };
}

/**
 * Find the key row for a presented key, or null. Constant-time on the hash.
 *
 * A missing prefix and a wrong hash are the same answer to the caller: no.
 */
function verifyKey(presented) {
    const key = String(presented || '');

    if (!key.startsWith('lxk_') || key.length < PREFIX_LENGTH + 8) {
        return null;
    }

    const row = findByPrefix.get(key.slice(0, PREFIX_LENGTH));

    if (!row) return null;

    const supplied = Buffer.from(hashKey(key));
    const stored = Buffer.from(row.key_hash);

    if (supplied.length !== stored.length) return null;
    if (!crypto.timingSafeEqual(supplied, stored)) return null;

    touchKey.run(row.id);

    return row;
}

module.exports = {
    createKey,
    verifyKey,
    listKeys,
    deleteKey
};
