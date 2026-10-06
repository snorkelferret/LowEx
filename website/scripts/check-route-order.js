#!/usr/bin/env node
/**
 * Fails if any route or mounted router is registered AFTER the fallback
 * handlers in backend/server.js.
 *
 * Express matches in registration order, so a catch-all registered too early
 * silently swallows every route declared below it. The failure is invisible
 * by inspection: the shadowed routes still exist, they just never run. This is
 * exactly how login-step1, login-step2, the Google OAuth routes, create-invite,
 * register-invited, setup-2fa and the authenticated /api/superuser mount all
 * became unreachable, with login failing and returning a "Not found" body.
 * (The superuser mount has since been removed with the rest of the superuser
 * dashboard — 2026-10-06 — but the incident it caused is why this check
 * exists, so it stays named.)
 *
 * Add new routes above the fallback block, then run this.
 *
 *   node scripts/check-route-order.js      # exit 0 = clean
 *
 * listen() is stubbed, so this never binds a port and is safe to run against
 * the real .env and database.
 */

const path = require('path');

const repoRoot = path.join(__dirname, '..');

process.chdir(repoRoot);

require(path.join(repoRoot, 'node_modules/dotenv'))
  .config({ path: path.join(repoRoot, '.env'), quiet: true });

const express = require(path.join(repoRoot, 'node_modules/express'));

let app = null;
express.application.listen = function () {
  app = this;
  return { close() {} };
};

require(path.join(repoRoot, 'backend/server.js'));

const stack = (app.router && app.router.stack) ||
              (app._router && app._router.stack) || [];

if (stack.length === 0) {
  console.error('Could not read the route table. Did app.listen() move?');
  process.exit(1);
}

const label = (layer, i) =>
  layer.route
    ? Object.keys(layer.route.methods).join(',').toUpperCase() + ' ' + layer.route.path
    : 'USE ' + (layer.name || '<anonymous>');

console.log('  app-level registration order:');
stack.forEach((layer, i) => {
  const isSplat = layer.route && layer.route.path === '/*splat';
  console.log(
    '   ' + String(i).padStart(2) + '  ' + label(layer, i).slice(0, 60).padEnd(60) +
    (isSplat ? '  <-- SPA catch-all (must be last)' : '')
  );
});

const splatIndex = stack.findIndex(l => l.route && l.route.path === '/*splat');

if (splatIndex < 0) {
  console.error('\n  FAIL: no /*splat SPA fallback is registered.');
  process.exit(1);
}

// Everything from the /api JSON 404 onward must be fallbacks only. A shadowed
// mounted router is just as broken as a shadowed route, so flag both.
const fallbackStart = splatIndex - 1;

const isUnreachable = (layer) => {
  if (layer.route) return layer.route.path !== '/*splat';
  if (layer.handle && layer.handle.stack) return true;
  return false;
};

const stragglers = stack
  .map((layer, i) => ({ layer, i }))
  .filter(({ layer, i }) => i >= fallbackStart && isUnreachable(layer))
  .map(({ layer, i }) => i + ': ' + label(layer, i));

const splatIsLast = splatIndex === stack.length - 1;
const ok = splatIsLast && stragglers.length === 0;

console.log('');
console.log('  SPA catch-all index ....... ' + splatIndex + ' (stack length ' + stack.length + ')');
console.log('  catch-all is last ......... ' + (splatIsLast ? 'yes  OK' : 'NO  PROBLEM'));
console.log('  routes after fallbacks .... ' +
  (stragglers.length === 0 ? 'none  OK' : stragglers.join('\n                              ')));
console.log('');
console.log(ok ? '  PASS' : '  FAIL — move the fallbacks below every route (see server.js section 8)');

process.exit(ok ? 0 : 1);
