import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// Single-user P0: only the dev server (`vite`/`vite serve`) injects the server's SESSION_TOKEN
// from the repo-root .env. Production builds (and the .ehpk) never contain it: the HUD reads the
// token the user stored on the phone instead (per-device pairing will replace this).
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  const devToken = command === 'serve' ? env.VITE_SESSION_TOKEN || env.SESSION_TOKEN || '' : '';
  return {
    server: { host: true, port: 5173, strictPort: true },
    build: { target: 'esnext' },
    define: {
      'import.meta.env.VITE_SESSION_TOKEN': JSON.stringify(devToken),
      'import.meta.env.VITE_SERVER_WS': JSON.stringify(
        process.env.VITE_SERVER_WS || env.VITE_SERVER_WS || '',
      ),
    },
  };
});
