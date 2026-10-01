import { defineConfig, loadEnv } from 'vite';


import path from 'path';

export default defineConfig(({ mode }) => {
  const rootDir = __dirname;
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
          superuser: path.resolve(rootDir, 'frontend/superuserDashboard.html'),
          admin: path.resolve(rootDir, 'frontend/adminDashboard.html'),
          developer: path.resolve(rootDir, 'frontend/devDashboard.html'),
          user: path.resolve(rootDir, 'frontend/user.html'),
          // The invitation landing page. Not behind the app shell — whoever
          // arrives has no account yet.
          register: path.resolve(rootDir, 'frontend/register.html'),
        },
      },
    },
  };
});
