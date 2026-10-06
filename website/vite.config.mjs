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

export default defineConfig(({ mode }) => {
  const rootDir = import.meta.dirname;
  const env = loadEnv(mode, rootDir, '');

  // Strict config-time check
  if (!env.VITE_API_URL) {
    throw new Error('FATAL: VITE_API_URL is missing from environment configuration.');
  }

  return {
      root: path.resolve(rootDir, 'frontend'),
    envDir: rootDir, // <-- Forces Vite's bundler to look in this exact folder for .env
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(env.VITE_API_URL), // <-- Force-injects the variable
    },
    server: {
      port: parseInt(env.VITE_PORT || '5173', 10),
      proxy: {
        '/api': {
          target: env.SERVER_URL,
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
