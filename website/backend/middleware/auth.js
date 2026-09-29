// backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const db = require('../db');

// The single source of truth for "who is this request".
//
// The role is re-read from the database on every request rather than trusted
// from the token, so deactivating or demoting an account takes effect
// immediately instead of whenever its 8-hour token happens to expire.
const getUserById = db.prepare(
  'SELECT id, username, role, is_active FROM users WHERE id = ?'
);

function authenticateToken(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let payload;

  try {
    // No fallback secret. server.js refuses to start without JWT_SECRET, so
    // this can only fail on a genuine bad/expired token.
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  // `sub` is the standard JWT subject claim and is the only identity claim
  // either token issuer sets.
  const user = getUserById.get(payload.sub);

  if (!user || !user.is_active) {
    return res.status(403).json({ error: 'Account is not active' });
  }

  // req.user.id is always present, whichever route issued the token.
  req.user = {
    id: user.id,
    username: user.username,
    role: user.role
  };

  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user?.role) {
      return res.status(403).json({
        error: 'Unauthorized: no role assigned.'
      });
    }

    if (allowedRoles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({
      error: 'Unauthorized: insufficient permissions.'
    });
  };
}
function requireSuperuser(req, res, next) {
  // Check the single-source role
  if (req.user?.role === 'superuser') {
    return next();
  }
  return res.status(403).json({ error: 'Unauthorized: Superuser access required.' });
}

function requireAdmin(req, res, next) {
  // Superusers automatically pass admin checks
  if (req.user?.role === 'admin' || req.user?.role === 'superuser') {
    return next();
  }
  return res.status(403).json({ error: 'Unauthorized: Admin access required.' });
}

module.exports = {
    authenticateToken,
    requireSuperuser,
    requireAdmin,
    requireRole
};
