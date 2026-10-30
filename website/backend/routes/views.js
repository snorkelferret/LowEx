const express = require('express');
const path = require('path');
const router = express.Router();
const { authenticateToken, requireAdmin, requireRole } = require('../middleware/auth');

// The tester's landing page. Any signed-in role may see it — it is where a
// `user` account lands after signing in, and the page says so itself.
//
// THIS SERVED shopfront.html UNTIL 2026-10-06. The protected route for a
// signed-in tester sent them to the sign-in page. Nothing linked to it, so
// nobody hit it, and login redirects straight to /user.html instead — which is
// exactly how a route stays wrong for months.
router.get('/user', authenticateToken, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/user.html'));
});

// The production reviewer's page. Prod only — an administrator reaching it
// would find buttons the server refuses, which is worse than a clear refusal.
router.get(
  '/prod',
  authenticateToken,
  requireRole('prod'),
  (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/prodDashboard.html'));
  }
);

// Protected Admin View
router.get('/admin', authenticateToken, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/adminDashboard.html'));
});

// THERE IS NO /superuser ROUTE, and no superuser dashboard, as of 2026-10-06.
//
// The superuser's extra powers were the only reason for a separate page, and
// those powers are leaving the website: two of them were secrets typed into a
// web form, one was a deployment trigger, and the rest are operations that
// belong on the machine. See TODO 50 for where each is going.
//
// A superuser is not locked out of anything by this. They pass requireAdmin, so
// every page below is theirs already — which is the point: there is no longer a
// superuser page to attack, and no capability that only it could reach.

// Developer View
// NB: the page is devDashboard.html. Vite emits it from frontend/devDashboard.html
// (vite.config.mjs `input.developer`); there is no developerPanel.html page.
//
// requireSuperuser UNTIL 2026-10-06, which meant a developer asking for the
// developer dashboard was refused. Nothing linked here either, so it sat wrong
// rather than breaking anything — but it was one link away from locking people
// out of their own page.
router.get(
  '/developer',
  authenticateToken,
  requireRole('developer', 'admin'),
  (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/devDashboard.html'));
  }
);

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

  // BACK GOES TO THE READER'S OWN DASHBOARD.
  //
  // The manual is one generated file, and the reader's role is known HERE and
  // nowhere in the page. So the template carries a token and this fills it in.
  // It used to be a fixed "/" — the splash — from every role, which is why a
  // reader finishing a page was thrown out of the portal's furniture.
  //
  // Read rather than sendFile: the replacement is the whole reason the file
  // cannot go out as it sits on disk. The manual is one page read
  // occasionally, and a fresh read also means a rebuild is picked up without a
  // restart.
  const html = require('fs').readFileSync(manual, 'utf8').replace(
    '{{BACK_HREF}}',
    require('../../shared/dashboards.mjs').dashboardFor(req.user?.role) || '/index.html'
  );

  return res.type('html').send(html);
});

module.exports = router;
