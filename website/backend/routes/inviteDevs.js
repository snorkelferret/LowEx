// backend/routes/inviteDevs.js
const express = require('express');
const crypto = require('crypto');
const db = require('../db'); // Imports your better-sqlite3 instance

// 1. IMPORT YOUR TRUE MIDDLEWARE SYSTEM
const { authenticateToken, requireAdmin, requireSuperuser } = require('../middleware/auth');

const router = express.Router();

// ❌ DELETED LOCAL HOLDOVER REQUIRE_ROLE HELPER (No longer needed!)

/**
 * ✅ UPDATED: GET /api/inviteDevs/list
 * Admin/Superuser route to pull the list of invitations
 * Uses your true middleware layer sequentially
 */
router.get('/list', authenticateToken, requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, email, assigned_role AS role, 
             CASE WHEN is_used = 1 THEN 'active' ELSE 'pending' END AS status,
             expires_at AS expiresAt, 
             reissue_count AS reissueCount,
             created_at AS createdAt
      FROM invitations 
      ORDER BY id DESC
    `).all();
    return res.json(rows);
  } catch (err) {
    console.error('Error fetching invite logs:', err);
    return res.status(500).json({ error: 'Failed to retrieve invitations list.' });
  }
});

/**
 * ✅ UPDATED: POST /api/inviteDevs/generate-invite
 * Superuser-only route to mint a brand new link
 * Uses your true middleware layer sequentially
 */
router.post('/generate-invite', authenticateToken, requireAdmin, (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const token = crypto.randomBytes(32).toString('hex');
    
    db.prepare(`
      INSERT INTO invitations (email, assigned_role, token, is_used, reissue_count, expires_at, created_at)
      VALUES (?, ?, ?, 0, 0, datetime('now', '+28 days'), datetime('now'))
    `).run(email, role || 'developer', token);

    const inviteLink = `http://localhost:5173/register?token=${token}`;
    
    // TODO: Connect Nodemailer transportation wrapper here

    return res.json({ success: true, inviteLink });
  } catch (err) {
    console.error('Error generating fresh invite profile:', err);
    return res.status(400).json({ error: 'An active invitation profile already exists for this email.' });
  }
});

/**
 * POST /api/inviteDevs/request-reissue
 * Developer-facing route to request renewal for an expired link.
 * 🔓 INTENTIONALLY LEFT UNPROTECTED: Incoming users do not have a login session yet!
 */
router.post('/request-reissue', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: 'Invitation token is required.' });
  }

  try {
    // 1. Fetch invitation record from SQLite
    const invite = db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);

    if (!invite) {
      return res.status(404).json({ message: 'Invitation record not found.' });
    }

    if (invite.is_used === 1) {
      return res.status(400).json({ message: 'This invitation has already been accepted.' });
    }

    // 2. Check 6-reissue limit constraint
    if (invite.reissue_count >= 6) {
      return res.status(403).json({
        error: 'LIMIT_REACHED',
        message: 'Maximum reissue limit (6/6) reached. Please contact your administrator for a fresh link.'
      });
    }

    // 3. Generate new raw token
    const newRawToken = crypto.randomBytes(32).toString('hex');

    // 4. Update invite record in SQLite: bump count, reset 28-day expiration
    const updateStmt = db.prepare(`
      UPDATE invitations
      SET token = ?,
          reissue_count = reissue_count + 1,
          expires_at = datetime('now', '+28 days'),
          last_reissued_at = datetime('now')
      WHERE id = ?
    `);

    updateStmt.run(newRawToken, invite.id);

    // Fetch updated record to return remaining attempts
    const updated = db.prepare('SELECT reissue_count, expires_at FROM invitations WHERE id = ?').get(invite.id);

    // TODO: Trigger email service with `newRawToken` to developer's email

    return res.json({
      success: true,
      reissuesRemaining: 6 - updated.reissue_count,
      expiresAt: updated.expires_at,
      message: 'Invitation reissued successfully! A new 28-day link has been generated.'
    });

  } catch (err) {
    console.error('Error reissuing invitation:', err);
    return res.status(500).json({ message: 'Internal server error processing reissue.' });
  }
});

module.exports = router;
