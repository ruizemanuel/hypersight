import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { type ApiDeps, createApi } from './api';

export type AppDeps = {
  sessionToken: string;
  /** Companion API (settings, watchlist, rules, history, status); omitted in minimal setups. */
  api?: ApiDeps;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));
  app.get('/health', (c) => c.json({ ok: true, network: 'testnet' }));

  const api = new Hono();
  api.use('*', bearerAuth({ token: deps.sessionToken }));
  api.get('/ping', (c) => c.json({ ok: true }));
  if (deps.api) api.route('/', createApi(deps.api));
  app.route('/api', api);

  return app;
}
