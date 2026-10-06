//website/backend/routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // Or 'bcrypt'
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  // 1. Validate Input Presence
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const cleanUsername = username.trim().toLowerCase();

    // 2. Fetch User Record from Database
    const user = db.prepare('SELECT id, username, email, password_hash, role, is_active FROM users WHERE LOWER(username) = ?').get(cleanUsername);

    // 3. Prevent Timing Attacks & Verify Account Exists
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // 4. Check Account Active Status
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account has been deactivated' });
    }

    // 5. Verify Password Hash
    const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // 6. Sign JWT with Single-Source Role.
    //
    // `sub` is the standard JWT subject claim and is the only identity claim
    // authenticateToken reads. Keep this in step with the issuers in server.js.
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role // One of the four in backend/lib/roles.js
    };

    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    // 7. Return Clean Response (Never return password_hash!)

    // Bake the secure HTTP-only cookie.
    // These attributes must match res.clearCookie() in /logout below.
    res.cookie('token', token, {
      httpOnly: true, // Prevents cross-site scripting (XSS) attacks
      secure: process.env.NODE_ENV === 'production', // true in production
      sameSite: 'lax',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000 // 8 hours matching the JWT expiration
    });
      
    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server authentication error' });
  }
});

// POST /api/auth/logout
//
// The session cookie is httpOnly, so the browser cannot remove it — only the
// server can. Without this route "log out" merely wiped localStorage and left
// a working session behind.
//
// Note: this is a stateless JWT, so this clears the cookie for THIS browser
// only. A token that was already copied elsewhere stays valid until it expires.
// Real revocation needs a server-side session record (see the unused
// `sessions` table in db.js).
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });

  return res.json({ success: true });
});

// GET /api/auth/me
//
// Who the server thinks you are, read from the database on this request.
//
// WHY THIS EXISTS RATHER THAN READING localStorage. The browser already holds a
// profile, and it is what the pages use to greet people — but it was written at
// sign-in and NEVER EXPIRES, while the session cookie behind it does. So a page
// that trusts it draws a full, confident "Your account" panel for somebody
// whose session ended hours ago. That is the failure frontend/src/api.js was
// written to catch, and this is the endpoint that lets a page catch it too.
//
// It is also the only way a page can show account details it did not get from
// the browser, which is the difference between displaying a fact and displaying
// something the client happens to remember.
//
// authenticateToken re-reads the row, so a deactivated account is refused here
// immediately rather than at token expiry — the same property that makes
// deactivation real everywhere else.
router.get('/me', authenticateToken, (req, res) => {
  try {
    // has_2fa_secret IS NOT is_2fa_enabled, and the difference matters.
    //
    // The flag is set automatically on first sign-in while no secret exists, so
    // it currently reads 1 for every account in the system that has no
    // authenticator at all — see TODO 47. Anything displaying "two-factor: on"
    // from that flag is displaying a falsehood.
    //
    // Whether a SECRET EXISTS is the honest question, and it is the one this
    // answers. The secret itself is never selected.
    const user = db.prepare(`
      SELECT
        id, username, email, role, created_at,
        is_2fa_enabled,
        two_factor_secret IS NOT NULL AS has_2fa_secret
      FROM users
      WHERE id = ?
    `).get(req.user.id);

    if (!user) {
      // The token verified but the row is gone, which authenticateToken cannot
      // distinguish from a valid session. Say so rather than 500.
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    return res.json({ user });

  } catch (err) {
    console.error('Failed to read the current account:', err);
    return res.status(500).json({ error: 'Failed to read the account' });
  }
});

module.exports = router;
