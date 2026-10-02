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

// The manual. Any signed-in member, any role.
//
// THE ONLY SIGN-IN-GATED PAGE SERVED FROM backend/. Everything else under
// /app sends a file out of frontend/dist, which is also mounted with
// express.static — so those pages are fetchable directly at their .html paths,
// and the guard is really on the APIs behind them. That works because they are
// empty shells.
//
// The manual is not a shell: its content IS the page, including how the server
// is run and what administrators can do. Serving it from the static tree would
// publish all of it. So it is generated into backend/generated/ and reaches the
// browser only through here.
//
// If it is missing, the build has not been run — said plainly rather than
// leaving a blank page to interpret.
router.get('/manual', authenticateToken, (req, res) => {
  const manual = path.join(__dirname, '../generated/manual.html');

  if (!require('fs').existsSync(manual)) {
    return res.status(503).type('text/plain').send(
      'The manual has not been built. Run: npm run generate:manual'
    );
  }

  res.sendFile(manual);
});

module.exports = router;
