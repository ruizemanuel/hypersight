import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AlertRule, DEFAULT_RISK_LIMITS, DEFAULT_SETTINGS } from '@hypersight/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db';
import { createRepos } from '../../src/store/repos';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hs-db-'));
  dirs.push(dir);
  return join(dir, 'nested', 'hypersight.sqlite');
}

describe('settings', () => {
  it('starts from the default risk limits and presets', () => {
    const repos = createRepos(openDb(':memory:'));
    expect(repos.settings.get().risk).toEqual(DEFAULT_RISK_LIMITS);
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a partial update across reopening the file', () => {
    const file = tempFile();
    const first = openDb(file);
    createRepos(first).settings.update({ risk: { maxOrderUsd: 100 } });
    first.close();
    const second = openDb(file);
    const repos = createRepos(second);
    expect(repos.settings.get().risk).toEqual({ ...DEFAULT_RISK_LIMITS, maxOrderUsd: 100 });
    expect(repos.settings.get().presets).toEqual(DEFAULT_SETTINGS.presets);
    second.close();
  });

  it('rejects an invalid update and keeps the previous settings', () => {
    const repos = createRepos(openDb(':memory:'));
    expect(() => repos.settings.update({ risk: { maxOrderUsd: -5 } })).toThrow();
    expect(repos.settings.get().risk.maxOrderUsd).toBe(DEFAULT_RISK_LIMITS.maxOrderUsd);
  });

  it('returns copies, so callers cannot corrupt the defaults or the stored settings', () => {
    const repos = createRepos(openDb(':memory:'));
    const s = repos.settings.get();
    s.risk.allowedCoins.push('DOGE');
    s.risk.maxOrderUsd = 1;
    expect(repos.settings.get().risk).toEqual(DEFAULT_RISK_LIMITS);
    expect(DEFAULT_RISK_LIMITS.allowedCoins).toEqual(['BTC', 'ETH', 'SOL', 'HYPE']);
  });
});

describe('migrations', () => {
  it('runs once per file: reopening keeps data and does not re-seed defaults', () => {
    const file = tempFile();
    const db1 = openDb(file);
    const repos1 = createRepos(db1);
    expect(repos1.watch.list()).toEqual(['rb:BTC:1d', 'rb:ETH:1d']);
    repos1.watch.remove('rb:ETH:1d');
    db1.close();
    const db2 = openDb(file);
    expect(createRepos(db2).watch.list()).toEqual(['rb:BTC:1d']);
    expect(
      (db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(1);
    db2.close();
  });
});

describe('watch', () => {
  it('adds in order without duplicates and removes', () => {
    const { watch } = createRepos(openDb(':memory:'));
    watch.add('o:10225');
    watch.add('rb:BTC:1d');
    expect(watch.list()).toEqual(['rb:BTC:1d', 'rb:ETH:1d', 'o:10225']);
    watch.remove('rb:BTC:1d');
    expect(watch.list()).toEqual(['rb:ETH:1d', 'o:10225']);
  });
});

describe('rules', () => {
  const rule: AlertRule = {
    id: 'eth-tp',
    kind: 'pnlPct',
    params: { coin: 'ETH', pct: 5 },
    action: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 },
    cooldownMs: 600_000,
    enabled: true,
  };

  it('upserts, lists and removes validated rules', () => {
    const { rules } = createRepos(openDb(':memory:'));
    rules.upsert(rule);
    rules.upsert({ ...rule, enabled: false });
    expect(rules.list()).toEqual([{ ...rule, enabled: false }]);
    rules.remove('eth-tp');
    expect(rules.list()).toEqual([]);
  });

  it('rejects a malformed rule', () => {
    const { rules } = createRepos(openDb(':memory:'));
    expect(() => rules.upsert({ ...rule, cooldownMs: -1 })).toThrow();
  });
});

describe('audit', () => {
  it('lists newest first with a limit', () => {
    const { audit } = createRepos(openDb(':memory:'));
    for (let i = 1; i <= 3; i++) {
      audit.append({ ts: i, kind: 'proposal', proposalId: `p${i}`, summary: `s${i}`, data: { i } });
    }
    expect(audit.list(2)).toEqual([
      { ts: 3, kind: 'proposal', proposalId: 'p3', summary: 's3', data: { i: 3 } },
      { ts: 2, kind: 'proposal', proposalId: 'p2', summary: 's2', data: { i: 2 } },
    ]);
  });
});

describe('usage', () => {
  it('sums notional only since 00:00 UTC of the given day', () => {
    const { usage } = createRepos(openDb(':memory:'));
    const midnight = Date.UTC(2026, 10, 24);
    usage.addNotional(500, midnight - 1);
    usage.addNotional(100, midnight);
    usage.addNotional(25.5, midnight + 3_600_000);
    expect(usage.today(midnight + 7_200_000)).toBe(125.5);
    expect(usage.today(midnight - 2)).toBe(500);
  });
});

describe('devices and paper ledger', () => {
  it('stores devices by token', () => {
    const { devices } = createRepos(openDb(':memory:'));
    const d = {
      token: 't1',
      master: '0xabc',
      agentAddress: '0xdef',
      agentKeySealed: 'sealed',
      createdAt: 1,
    };
    devices.put(d);
    expect(devices.byToken('t1')).toEqual(d);
    expect(devices.byToken('nope')).toBeUndefined();
  });

  it('appends and lists paper fills in order', () => {
    const { ledger } = createRepos(openDb(':memory:'));
    ledger.append({ ts: 1, coin: '#273210', isBuy: true, sz: 40, px: 0.62 });
    ledger.append({ ts: 2, coin: 'ETH', isBuy: false, sz: 0.25, px: 3411 });
    expect(ledger.list()).toEqual([
      { ts: 1, coin: '#273210', isBuy: true, sz: 40, px: 0.62 },
      { ts: 2, coin: 'ETH', isBuy: false, sz: 0.25, px: 3411 },
    ]);
  });
});
