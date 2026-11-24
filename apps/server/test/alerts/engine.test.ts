import { EventEmitter } from 'node:events';
import type { AlertRule } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { AlertEngine } from '../../src/alerts/engine';
import type { AlertEvent } from '../../src/alerts/rules';
import type { AccountView } from '../../src/hl/account';
import { Catalogue } from '../../src/hl/outcomes';
import { openDb } from '../../src/store/db';
import { createRepos } from '../../src/store/repos';

const T0 = Date.UTC(2026, 10, 24, 12, 0);

const view: AccountView = {
  equityUsd: 1000,
  perpUpnlUsd: 0,
  marginRatio: 0,
  marginUsage: 0,
  perpWithdrawableUsd: 1000,
  spotUsdc: 1000,
  perps: [],
  outcomes: [],
  abstraction: 'unifiedAccount',
  updatedAt: T0,
};

function setup(rules: AlertRule[]) {
  const clock = { now: T0 };
  const mids: Record<string, string> = { ETH: '3390' };
  const stream = Object.assign(new EventEmitter(), { view: () => view, mids: () => mids });
  const pushed: AlertEvent[] = [];
  const engine = new AlertEngine({
    stream,
    rules: { list: () => rules },
    catalogue: new Catalogue(),
    push: (ev) => pushed.push(ev),
    now: () => clock.now,
  });
  engine.start();
  const tick = (eth: string) => {
    mids.ETH = eth;
    stream.emit('view', view);
  };
  return { engine, stream, pushed, clock, tick };
}

const cross = (cooldownMs: number): AlertRule => ({
  id: 'eth-3400',
  kind: 'priceCross',
  params: { coin: 'ETH', px: 3400, dir: 'above' },
  cooldownMs,
  enabled: true,
});

describe('AlertEngine', () => {
  it('pushes an alert when a rule fires on a view update', () => {
    const s = setup([cross(60_000)]);
    s.tick('3390');
    s.tick('3405');
    expect(s.pushed.map((e) => e.title)).toEqual(['ETH above 3,400']);
  });

  it('suppresses a second event inside the cooldown, and fires again after it', () => {
    const s = setup([cross(60_000)]);
    s.tick('3390');
    s.tick('3405');
    s.tick('3390');
    s.clock.now += 30_000;
    s.tick('3405');
    expect(s.pushed).toHaveLength(1);
    s.tick('3390');
    s.clock.now += 31_000;
    s.tick('3405');
    expect(s.pushed).toHaveLength(2);
  });

  it('skips disabled rules and stops listening on stop()', () => {
    const s = setup([{ ...cross(0), enabled: false }]);
    s.tick('3390');
    s.tick('3405');
    expect(s.pushed).toHaveLength(0);
    const t = setup([cross(0)]);
    t.engine.stop();
    t.tick('3390');
    t.tick('3405');
    expect(t.pushed).toHaveLength(0);
  });

  it('turns a settlement fill into a "settled" alert', () => {
    const s = setup([{ id: 'settled', kind: 'settled', params: {}, cooldownMs: 0, enabled: true }]);
    s.stream.emit('fill', {
      coin: '#271531',
      dir: 'Settlement',
      side: 'A',
      sz: '2.0',
      px: '1.0',
      closedPnl: '0.76438',
      crossed: true,
    });
    expect(s.pushed.map((e) => e.title)).toEqual(['NO won · +$0.76']);
  });

  it('survives a malformed fill or a throwing push', () => {
    const rules: AlertRule[] = [
      { id: 'settled', kind: 'settled', params: {}, cooldownMs: 0, enabled: true },
    ];
    const stream = Object.assign(new EventEmitter(), { view: () => view, mids: () => ({}) });
    const engine = new AlertEngine({
      stream,
      rules: { list: () => rules },
      catalogue: new Catalogue(),
      push: () => {
        throw new Error('boom');
      },
      now: () => T0,
    });
    engine.start();
    expect(() => stream.emit('fill', null)).not.toThrow();
    expect(() =>
      stream.emit('fill', { coin: '#271531', dir: 'Settlement', sz: '2', px: '1', closedPnl: '1' }),
    ).not.toThrow();
  });
});

describe('default alert rules', () => {
  it('are seeded on first run: resting fills, liquidation distance < 10%, settled outcomes', () => {
    const repos = createRepos(openDb(':memory:'));
    const rules = repos.rules.list();
    expect(rules.map((r) => r.kind).sort()).toEqual(['fill', 'liqDistance', 'settled']);
    expect(rules.find((r) => r.kind === 'liqDistance')?.params).toEqual({ pct: 10 });
    expect(rules.every((r) => r.enabled)).toBe(true);
  });
});
