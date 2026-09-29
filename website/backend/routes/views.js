const express = require('express');
const path = require('path');
const router = express.Router();
const { authenticateToken, requireAdmin, requireSuperuser } = require('../middleware/auth');

// Protected User View
router.get('/user', authenticateToken, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/shopfront.html'));
});

// Protected Admin View
router.get('/admin', authenticateToken, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/adminDashboard.html'));
});

// Protected Superuser / Developer View
router.get('/superuser', authenticateToken, requireSuperuser, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/superuserDashboard.html'));
});

// Developer View
// NB: the page is devDashboard.html. Vite emits it from frontend/devDashboard.html
// (vite.config.js `input.developer`); there is no developerPanel.html page.
router.get('/developer', authenticateToken, requireSuperuser, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/devDashboard.html'));
});

module.exports = router;
