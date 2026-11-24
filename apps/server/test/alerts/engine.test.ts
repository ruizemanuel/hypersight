import { EventEmitter } from 'node:events';
import type { AlertRule } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { AlertEngine } from '../../src/alerts/engine';
import type { AlertEvent } from '../../src/alerts/rules';
import type { AccountView, PerpPosition } from '../../src/hl/account';
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

  it('skips the fills of orders the user just confirmed, by order id', () => {
    const rules: AlertRule[] = [
      { id: 'fills', kind: 'fill', params: {}, cooldownMs: 0, enabled: true },
    ];
    const stream = Object.assign(new EventEmitter(), { view: () => view, mids: () => ({}) });
    const pushed: AlertEvent[] = [];
    const engine = new AlertEngine({
      stream,
      rules: { list: () => rules },
      catalogue: new Catalogue(),
      push: (ev) => pushed.push(ev),
      ownOrders: { isOwn: (f) => f.oid === 77, stopFor: () => undefined },
      now: () => T0,
    });
    engine.start();
    const fill = {
      coin: 'ETH',
      dir: 'Open Long',
      side: 'B',
      sz: '0.01',
      px: '3000',
      crossed: true,
    };
    stream.emit('fill', { ...fill, oid: 77 });
    stream.emit('fill', { ...fill, oid: 78 });
    expect(pushed.map((e) => e.title)).toEqual(['Order filled']);
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

describe('AlertEngine — odds and liquidation over time', () => {
  function live(rules: AlertRule[]) {
    const clock = { now: T0 };
    const catalogue = new Catalogue({ now: () => clock.now });
    catalogue.reset(
      {
        outcomes: [
          {
            outcome: 27321,
            name: 'Recurring',
            description:
              'class:priceBinary|underlying:BTC|expiry:20261125-0300|targetPrice:61509|period:1d',
            sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
          },
        ],
        questions: [],
      },
      [],
    );
    let current: AccountView = view;
    const mids: Record<string, string> = { '#273210': '0.5' };
    const stream = Object.assign(new EventEmitter(), { view: () => current, mids: () => mids });
    const pushed: AlertEvent[] = [];
    const engine = new AlertEngine({
      stream,
      rules: { list: () => rules },
      catalogue,
      push: (ev) => pushed.push(ev),
      now: () => clock.now,
    });
    engine.start();
    const tick = (over: { odds?: string; perps?: PerpPosition[] } = {}) => {
      if (over.odds) mids['#273210'] = over.odds;
      if (over.perps) current = { ...view, perps: over.perps };
      stream.emit('view', current);
    };
    return { pushed, clock, tick };
  }

  const pos = (coin: string, markPx: number, liqPx: number): PerpPosition => ({
    coin,
    size: 1,
    entryPx: markPx,
    markPx,
    upnlUsd: 0,
    roe: 0,
    leverage: 5,
    isCross: true,
    liqPx,
    szDecimals: 2,
  });

  it('catches an odds jump after a quiet stretch, and only once while it stays moved', () => {
    const s = live([
      {
        id: 'btc-odds',
        kind: 'oddsMove',
        params: { marketKey: 'rb:BTC:1d', points: 8, windowMs: 600_000 },
        cooldownMs: 0,
        enabled: true,
      },
    ]);
    for (let m = 0; m <= 20; m++) {
      s.clock.now = T0 + m * 60_000;
      s.tick({ odds: '0.5' });
    }
    s.clock.now += 60_000;
    s.tick({ odds: '0.6' });
    s.clock.now += 60_000;
    s.tick({ odds: '0.61' });
    s.clock.now += 60_000;
    s.tick({ odds: '0.6' });
    expect(s.pushed.map((e) => e.title)).toEqual(['BTC > 61,509 · 60% (+10)']);
  });

  it('warns about a second coin near liquidation inside the first coin cooldown', () => {
    const s = live([
      { id: 'liq', kind: 'liqDistance', params: { pct: 10 }, cooldownMs: 600_000, enabled: true },
    ]);
    s.tick({ perps: [pos('ETH', 3000, 2500), pos('BTC', 90_000, 80_000)] });
    s.tick({ perps: [pos('ETH', 2700, 2500), pos('BTC', 90_000, 80_000)] });
    s.clock.now += 60_000;
    s.tick({ perps: [pos('ETH', 2700, 2500), pos('BTC', 87_000, 80_000)] });
    expect(s.pushed.map((e) => e.title)).toEqual([
      'ETH 7% from liquidation',
      'BTC 8% from liquidation',
    ]);
  });

  it('warns at start-up about a position already close to liquidation', () => {
    const s = live([
      { id: 'liq', kind: 'liqDistance', params: { pct: 10 }, cooldownMs: 600_000, enabled: true },
    ]);
    s.tick({ perps: [pos('ETH', 2700, 2500)] });
    expect(s.pushed.map((e) => e.title)).toEqual(['ETH 7% from liquidation']);
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
