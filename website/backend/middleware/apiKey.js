// backend/middleware/apiKey.js
//
// A PROGRAM'S WAY IN. See backend/lib/apiKeys.js for why this exists at all.
//
// The header is the same shape as the Perforce trigger's — `Bearer <key>` —
// because two credential styles in one codebase is one more thing to get wrong
// at 02:00.

const { verifyKey } = require('../lib/apiKeys');

function requireApiKey(req, res, next) {
    const header = String(req.get('authorization') || '');
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    const row = presented ? verifyKey(presented) : null;

    if (!row) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // WHAT THE HANDLER MAY KNOW ABOUT THE CALLER. A name and an id, not a role:
    // a key has no role, and dressing it as one is how it gains one later.
    req.apiKey = { id: row.id, name: row.name };

    return next();
}

module.exports = { requireApiKey };
