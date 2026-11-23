import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';

export type AppDeps = {
  sessionToken: string;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));
  app.get('/health', (c) => c.json({ ok: true, network: 'testnet' }));

  const api = new Hono();
  api.use('*', bearerAuth({ token: deps.sessionToken }));
  api.get('/ping', (c) => c.json({ ok: true }));
  app.route('/api', api);

  return app;
}
