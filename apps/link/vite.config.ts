import { defineConfig } from 'vite';

// Served by the HyperSight server under /link (same origin as the pairing routes).
export default defineConfig({
  base: '/link/',
  build: { target: 'esnext' },
  server: {
    port: 5174,
    strictPort: true,
    // `pnpm dev` here talks to a local server for the pairing routes.
    proxy: {
      '/link/start': 'http://localhost:8787',
      '/link/info': 'http://localhost:8787',
      '/link/status': 'http://localhost:8787',
      '/link/complete': 'http://localhost:8787',
    },
  },
});
