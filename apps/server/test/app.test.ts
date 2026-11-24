import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';

const app = createApp({ sessionToken: 'good-token-0123456789' });

describe('createApp', () => {
  it('reports health and the network', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, network: 'testnet', pairing: false });
  });

  it('requires the bearer token on /api routes', async () => {
    expect((await app.request('/api/ping')).status).toBe(401);
    expect(
      (await app.request('/api/ping', { headers: { Authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    const ok = await app.request('/api/ping', {
      headers: { Authorization: 'Bearer good-token-0123456789' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('accepts any token the registry knows (paired devices) when given an authorizer', async () => {
    const paired = createApp({
      sessionToken: 'good-token-0123456789',
      authorize: (t) => t === 'device-token-0123456789',
      pairing: true,
    });
    const ok = await paired.request('/api/ping', {
      headers: { Authorization: 'Bearer device-token-0123456789' },
    });
    expect(ok.status).toBe(200);
    expect(await (await paired.request('/health')).json()).toMatchObject({ pairing: true });
  });

  it('serves the link page and its pairing routes under /link', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'hs-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<title>HyperSight link</title>');
    writeFileSync(join(dist, 'assets', 'main.js'), 'console.log(1)');
    const routes = new Hono();
    routes.get('/status/:code', (c) => c.json({ paired: false }));
    const withLink = createApp({
      sessionToken: 'good-token-0123456789',
      link: { routes, distDir: dist },
    });
    const page = await withLink.request('/link');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('HyperSight link');
    expect((await withLink.request('/link/assets/main.js')).status).toBe(200);
    expect(await (await withLink.request('/link/status/ABC-DEF')).json()).toEqual({
      paired: false,
    });
  });

  it('says how to build the link page when it is missing', async () => {
    const routes = new Hono();
    const noDist = createApp({
      sessionToken: 'good-token-0123456789',
      link: { routes, distDir: join(tmpdir(), 'hs-missing-dist-xyz') },
    });
    const res = await noDist.request('/link');
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/pnpm --filter @hypersight\/link build/);
  });

  it('allows cross-origin calls from the HUD WebView', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://example.test' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
