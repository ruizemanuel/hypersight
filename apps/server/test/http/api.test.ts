import type { AlertRule } from '@hypersight/protocol';
import { describe, expect, it, vi } from 'vitest';
import outcomeMetaFixture from '../../../../fixtures/hl/outcomeMeta.json';
import templatesFixture from '../../../../fixtures/hl/outcomeTemplates.json';
import { Catalogue, type OutcomeMetaLike, type OutcomeTemplateLike } from '../../src/hl/outcomes';
import { createApp } from '../../src/http/app';
import { openDb } from '../../src/store/db';
import { createRepos } from '../../src/store/repos';

const TOKEN = 'good-token-0123456789';
const NOW = Date.UTC(2026, 10, 23, 12);

function setup() {
  const catalogue = new Catalogue({ now: () => NOW });
  catalogue.reset(
    outcomeMetaFixture as unknown as OutcomeMetaLike,
    templatesFixture as unknown as OutcomeTemplateLike[],
  );
  const repos = createRepos(openDb(':memory:'));
  const onChange = vi.fn();
  const app = createApp({
    sessionToken: TOKEN,
    api: {
      repos,
      catalogue,
      onChange,
      status: () => ({
        mode: 'testnet',
        network: 'testnet',
        connected: true,
        latency: { sttMs: 230, intentMs: 1, execMs: 1482 },
      }),
    },
  });
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  return { app, repos, onChange, call };
}

describe('companion API', () => {
  it('requires the bearer token', async () => {
    const { app } = setup();
    expect((await app.request('/api/settings')).status).toBe(401);
    expect((await app.request('/api/status')).status).toBe(401);
  });

  it('rejects invalid settings without storing anything', async () => {
    const { call, repos, onChange } = setup();
    const res = await call('/api/settings', { method: 'PUT', body: { risk: { maxOrderUsd: -5 } } });
    expect(res.status).toBe(400);
    expect(repos.settings.get().risk.maxOrderUsd).toBe(250);
    expect(onChange).not.toHaveBeenCalled();
    expect((await call('/api/settings', { method: 'PUT', body: 'nope' })).status).toBe(400);
  });

  it('stores a valid settings update and pushes a fresh deck', async () => {
    const { call, repos, onChange } = setup();
    const res = await call('/api/settings', {
      method: 'PUT',
      body: { risk: { maxOrderUsd: 100 }, presets: { outcomeUsd: [2, 5, 10] } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { risk: { maxOrderUsd: number } }).risk.maxOrderUsd).toBe(100);
    expect(repos.settings.get().presets.outcomeUsd).toEqual([2, 5, 10]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      ((await (await call('/api/settings')).json()) as { risk: { maxOrderUsd: number } }).risk
        .maxOrderUsd,
    ).toBe(100);
  });

  it('searches markets with the BTC daily first', async () => {
    const { call } = setup();
    const res = await call('/api/markets?q=btc');
    expect(res.status).toBe(200);
    const list = (await res.json()) as { key: string; title: string; short: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(10);
    expect(list[0]?.key).toBe('rb:BTC:1d');
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(['expiresAt', 'key', 'short', 'title']);
  });

  it('manages the watchlist, refusing unknown markets', async () => {
    const { call, onChange } = setup();
    expect((await call('/api/watch', { method: 'POST', body: { key: 'o:999999' } })).status).toBe(
      404,
    );
    expect(
      (await call('/api/watch', { method: 'POST', body: { key: 'rq:BTC:1d:1' } })).status,
    ).toBe(200);
    expect(await (await call('/api/watch')).json()).toEqual([
      'rb:BTC:1d',
      'rb:ETH:1d',
      'rq:BTC:1d:1',
    ]);
    expect(
      (await call(`/api/watch/${encodeURIComponent('rb:ETH:1d')}`, { method: 'DELETE' })).status,
    ).toBe(200);
    expect(await (await call('/api/watch')).json()).toEqual(['rb:BTC:1d', 'rq:BTC:1d:1']);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('upserts, lists and deletes alert rules, validating them', async () => {
    const { call } = setup();
    const rule: AlertRule = {
      id: 'eth-3400',
      kind: 'priceCross',
      params: { coin: 'ETH', px: 3400, dir: 'above' },
      cooldownMs: 600_000,
      enabled: true,
    };
    expect((await call('/api/rules/eth-3400', { method: 'PUT', body: rule })).status).toBe(200);
    expect((await call('/api/rules/other', { method: 'PUT', body: rule })).status).toBe(400);
    expect(
      (await call('/api/rules/eth-3400', { method: 'PUT', body: { ...rule, cooldownMs: -1 } }))
        .status,
    ).toBe(400);
    const listed = (await (await call('/api/rules')).json()) as AlertRule[];
    expect(listed.map((r) => r.id)).toContain('eth-3400');
    expect((await call('/api/rules/eth-3400', { method: 'DELETE' })).status).toBe(200);
    expect(
      ((await (await call('/api/rules')).json()) as AlertRule[]).map((r) => r.id),
    ).not.toContain('eth-3400');
  });

  it('returns the audit history newest first, with a bounded limit', async () => {
    const { call, repos } = setup();
    for (let i = 1; i <= 3; i++) {
      repos.audit.append({
        ts: i,
        kind: 'proposal',
        proposalId: `p${i}`,
        summary: `s${i}`,
        data: null,
      });
    }
    const res = await call('/api/history?limit=2');
    expect(((await res.json()) as { proposalId: string }[]).map((e) => e.proposalId)).toEqual([
      'p3',
      'p2',
    ]);
    expect((await call('/api/history?limit=abc')).status).toBe(200);
  });

  it('reports status with the last stage latencies', async () => {
    const { call } = setup();
    expect(await (await call('/api/status')).json()).toEqual({
      mode: 'testnet',
      network: 'testnet',
      connected: true,
      latency: { sttMs: 230, intentMs: 1, execMs: 1482 },
    });
  });
});
