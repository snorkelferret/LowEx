import { defineConfig } from 'vite';

export default defineConfig({
    root: 'frontend', // Tells Vite the project root is this folder
    publicDir: '../asstes',
    server: {
	port: 5173,
	strictPort: true
    },
    build: {
	rollupOptions: {
	    input: {
		main: 'index.html',
		portal: 'portal.html'
	    }
	}
    }
});
