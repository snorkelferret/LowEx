// backend/routes/views.js
const express = require('express');
const path = require('path');
const router = express.Router();

// Import your auth middleware (adjust path as needed)
const { authenticateToken, requireRole } = require('../middleware/auth');

const VIEWS_DIR = path.join(__dirname, '../views');

// 1. User Dashboard (Steam launcher & profile)
router.get('/user', authenticateToken, (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'userDashboard.html'));
});

// 2. Developer Dashboard
router.get('/developer', authenticateToken, requireRole('developer', 'admin', 'superuser'), (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'developerDashboard.html'));
});

// 3. Admin Dashboard
router.get('/admin', authenticateToken, requireRole('admin', 'superuser'), (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'adminDashboard.html'));
});

// 4. Superuser Dashboard (Privileged Governance)
router.get('/superuser', authenticateToken, requireRole('superuser'), (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'superuserDashboard.html'));
});

module.exports = router;
