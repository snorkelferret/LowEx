// backend/middleware/auth.js
const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
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
