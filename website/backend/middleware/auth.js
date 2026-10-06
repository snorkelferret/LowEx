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

// Populates req.user when the request carries a valid session, and does NOTHING
// otherwise — no 401, no 403. For routes that are open to everyone but want to
// know who is asking when they can.
//
// The feedback form is the first of these, and the reason it needs one: someone
// who cannot sign in is the most likely person to want to report something, so
// requiring a session would exclude exactly the reporter who matters most.
//
// A missing or unreadable token is treated as "not signed in" rather than as a
// refusal — the route is open, so failing to read a session must not close it.
// The user is still re-read from the database, so a deactivated account does
// not come back as a valid actor here either.
function optionalAuth(req, res, next) {
  const token = req.cookies?.token;

  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const user = getUserById.get(payload.sub);

      if (user && user.is_active) {
        req.user = {
          id: user.id,
          username: user.username,
          role: user.role
        };
      }
    } catch {
      // Deliberately silent. See above.
    }
  }

  next();
}

// THE ROLE RULE, and it is the rule every route in this project depends on:
//
//   SUPERUSER CAN DO EVERYTHING AN ADMIN CAN DO, plus more.
//
// The "plus more" is superuser-only — deploying the game, creating branches.
// The "everything an admin can do" part is the one that gets broken by
// accident, because the failure is silent: a route that lists 'admin' and
// forgets 'superuser' does not error, it just refuses the most privileged
// account in the system.
//
// THAT RULE IS NOW MOOT: 'superuser' was removed on 2026-10-06, so admin is the
// top of the ladder and there is no longer a role that a list can forget. It is
// left here because the failure mode it describes is the reason requireRole
// takes roles at all, and because it would return the moment a rung is added
// above admin.
//
// The one thing NOT covered here: ADMIN CAN DELETE. Deleting from the game
// store is an admin capability, not a superuser one, so a delete route naming
// only 'admin' is not the mistake this note is about.
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

function requireAdmin(req, res, next) {
  // Superusers automatically pass admin checks
  if (req.user?.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Unauthorized: Admin access required.' });
}

module.exports = {
    authenticateToken,
    optionalAuth,
    requireAdmin,
    requireRole
};
