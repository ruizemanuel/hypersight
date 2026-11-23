import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// Single-user P0: the HUD reuses the server's SESSION_TOKEN from the repo-root .env
// (replaced by per-device pairing tokens in Task 22).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  return {
    server: { host: true, port: 5173, strictPort: true },
    build: { target: 'esnext' },
    define: {
      'import.meta.env.VITE_SESSION_TOKEN': JSON.stringify(
        env.VITE_SESSION_TOKEN || env.SESSION_TOKEN || '',
      ),
      'import.meta.env.VITE_SERVER_WS': JSON.stringify(env.VITE_SERVER_WS || ''),
    },
  };
});
