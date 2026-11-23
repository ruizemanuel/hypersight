import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';

const app = createApp({ sessionToken: 'good-token-0123456789' });

describe('createApp', () => {
  it('reports health and the network', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, network: 'testnet' });
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

  it('allows cross-origin calls from the HUD WebView', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://example.test' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
