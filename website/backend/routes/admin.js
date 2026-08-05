const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// All routes require at least Admin privilege
router.use(authenticateToken, requireAdmin);

// Fetch system/shop overview stats
router.get('/stats', (req, res) => {
  res.json({
    activeUsers: 12,
    totalOrders: 148,
    serverStatus: 'Healthy'
  });
});

module.exports = router;
