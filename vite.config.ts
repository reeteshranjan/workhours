import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// The UI lives in web/ and is built to dist/web, which the server serves (DESIGN §2, §13).
// vitest.config.ts is separate so that `root: 'web'` doesn't apply to the tests.
export default defineConfig({
  root: 'web',
  plugins: [svelte()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7420',
        // changeOrigin matters: the server rejects requests whose Host header isn't
        // localhost/127.0.0.1 on its own port (DESIGN §11), and this rewrites Host from
        // localhost:5173 to 127.0.0.1:7420. Server-Sent Events go through this proxy too.
        changeOrigin: true,
      },
    },
  },
});
