import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { type Context, Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { type ApiDeps, createApi } from './api';

export type AppDeps = {
  sessionToken: string;
  /** Accepts more tokens than SESSION_TOKEN (paired devices); defaults to SESSION_TOKEN only. */
  authorize?: (token: string) => boolean;
  /** The server pairs devices (/link) instead of using an agent key from the environment. */
  pairing?: boolean;
  /** Companion API (settings, watchlist, rules, history, status); omitted in minimal setups. */
  api?: ApiDeps;
  /** Pairing routes and the built link page (apps/link/dist), served under /link. */
  link?: { routes: Hono; distDir: string };
};

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** The link page and its assets, read from the built bundle (no traversal outside it). */
function mountLinkPage(app: Hono, distDir: string): void {
  const page = (c: Context) => {
    const index = join(distDir, 'index.html');
    if (!existsSync(index)) {
      return c.text('Link page not built — run: pnpm --filter @hypersight/link build', 503);
    }
    return c.html(readFileSync(index, 'utf8'));
  };
  app.get('/link', page);
  app.get('/link/', page);
  app.get('/link/assets/*', (c) => {
    const assets = join(distDir, 'assets');
    const file = normalize(join(assets, c.req.path.slice('/link/assets/'.length)));
    if (!file.startsWith(assets + sep) || !existsSync(file)) return c.notFound();
    return c.body(readFileSync(file), 200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));
  app.get('/health', (c) =>
    c.json({ ok: true, network: 'testnet', pairing: deps.pairing ?? false }),
  );

  if (deps.link) {
    mountLinkPage(app, deps.link.distDir);
    app.route('/link', deps.link.routes);
  }

  const api = new Hono();
  const authorize = deps.authorize;
  api.use(
    '*',
    authorize
      ? bearerAuth({ verifyToken: (token) => authorize(token) })
      : bearerAuth({ token: deps.sessionToken }),
  );
  api.get('/ping', (c) => c.json({ ok: true }));
  if (deps.api) api.route('/', createApi(deps.api));
  app.route('/api', api);

  return app;
}
