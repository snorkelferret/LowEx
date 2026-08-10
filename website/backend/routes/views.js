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
router.get('/developer', authenticateToken, requireSuperuser, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/developerPanel.html'));
});

module.exports = router;
