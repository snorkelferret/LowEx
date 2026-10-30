// vite.config.mjs — the extension is load-bearing.
//
// It was vite.config.js, which is read as COMMONJS because the nearest
// package.json declares "type": "commonjs" — and this file uses ESM `import`
// syntax. Vite has been papering over that by bundling the config first, but
// the native config loader (which becomes the default in a future major
// version) would load it as CommonJS and fail on line 1.
//
// The fix is the extension, NOT "type": "module". The package.json in question
// is the one the backend and build.js live under, and both use require();
// flipping it would break them to satisfy a config file.
//
// Which also means __dirname is gone. It is a CommonJS global and does not
// exist in ESM — import.meta.dirname is the replacement, and it resolves to
// this file's own directory, which is what __dirname meant.
import { defineConfig, loadEnv } from 'vite';

import path from 'path';

// THE SAME CONFIG THE BACKEND USES. Vite is a Node program too, so it reads
// the same defaults from the same file rather than keeping a private copy of
// the development port and the proxy target (shared/config.mjs).
import { resolveConfig } from './shared/config.mjs';

export default defineConfig(({ mode }) => {
  const rootDir = import.meta.dirname;
  const env = loadEnv(mode, rootDir, '');

  // process.env first, then what .env contributes, so either source works.
  const config = resolveConfig({ ...process.env, ...env });

  return {
      root: path.resolve(rootDir, 'frontend'),
    envDir: rootDir, // <-- Forces Vite's bundler to look in this exact folder for .env
    // VITE_API_URL IS GONE. The frontend calls /api RELATIVELY — it is served
    // by the backend, so there is no other origin to name — and the variable
    // had no reader while still being REQUIRED to build. Removing it removes a
    // second place an address could be set wrongly.
    server: {
      port: config.vitePort,
      proxy: {
        '/api': {
          target: config.serverUrl,
          changeOrigin: true,
        },

        // /APP IS A BACKEND ROUTE, NOT A PAGE VITE SERVES.
        //
        // The one link is the manual (/app/manual, in utilityBar.js): it is
        // generated into backend/generated/ and served through the backend
        // because its content includes how the server is run and what
        // administrators can do — it is not a public shell like the others.
        //
        // WITHOUT THIS, Vite's history fallback answers /app/manual with
        // index.html, which sends the browser to the splash page. That is the
        // bug in report 25: "pressed the manual tab and got sent to the splash".
        // It only ever affected development; production serves /app itself.
        '/app': {
          target: config.serverUrl,
          changeOrigin: true,
        },
      },
    },
    build: {
      // Relative to `root`, which is <repo>/frontend — so this must be 'dist',
      // not '../dist'. backend/server.js:54 serves <repo>/frontend/dist, and
      // '../dist' wrote to <repo>/dist where nothing ever read it.
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: path.resolve(rootDir, 'frontend/index.html'),
          shopfront: path.resolve(rootDir, 'frontend/shopfront.html'),
          admin: path.resolve(rootDir, 'frontend/adminDashboard.html'),
          developer: path.resolve(rootDir, 'frontend/devDashboard.html'),
          user: path.resolve(rootDir, 'frontend/user.html'),
          prod: path.resolve(rootDir, 'frontend/prodDashboard.html'),
          // The invitation landing page. Not behind the app shell — whoever
          // arrives has no account yet.
          register: path.resolve(rootDir, 'frontend/register.html'),
          // The discussion board. A stub today, so the links to it from the
          // sign-in page and the tester landing page do not 404.
          discussion: path.resolve(rootDir, 'frontend/discussion.html'),
        },
      },
    },
  };
});
