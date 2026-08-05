
import { defineConfig, loadEnv } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Automatically loads .env from the root working directory
  const env = loadEnv(mode, process.cwd(), '');

  const backendHost = env.BACKEND_HOST || env.HOST || '127.0.0.1';
  const backendPort = env.PORT || env.BACKEND_PORT || 5000;
  const frontendPort = parseInt(env.VITE_PORT || '5173', 10);

  return {
    // Tells Vite that frontend/ is the directory containing index.html
    root: 'frontend',
    server: {
      port: frontendPort,
      proxy: {
        '/api': {
          target: `http://${backendHost}:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'frontend/index.html'),
          shopfront: path.resolve(__dirname, 'frontend/shopfront.html'),
        },
      },
    },
  };
});
