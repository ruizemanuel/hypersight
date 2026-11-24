import type { AlertRule } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateFill, evaluateRule, type Snapshot } from '../../src/alerts/rules';
import type { AccountView, PerpPosition } from '../../src/hl/account';
import { Catalogue } from '../../src/hl/outcomes';

const NOW = Date.UTC(2026, 10, 24, 12, 0);
const catalogue = new Catalogue({ now: () => NOW });
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

const eth = (over: Partial<PerpPosition> = {}): PerpPosition => ({
  coin: 'ETH',
  size: 0.5,
  entryPx: 3000,
  markPx: 3120,
  upnlUsd: 60,
  roe: 0.08,
  leverage: 2,
  isCross: true,
  liqPx: 2500,
  szDecimals: 4,
  ...over,
});

const view = (perps: PerpPosition[] = []): AccountView => ({
  equityUsd: 1000,
  perpUpnlUsd: perps.reduce((s, p) => s + p.upnlUsd, 0),
  marginRatio: 0.1,
  marginUsage: 0.3,
  perpWithdrawableUsd: 500,
  spotUsdc: 999,
  perps,
  outcomes: [],
  abstraction: 'unifiedAccount',
  updatedAt: NOW,
});

const snap = (
  mids: Record<string, string>,
  perps: PerpPosition[] = [],
  oddsHistory: Snapshot['oddsHistory'] = new Map(),
): Snapshot => ({ view: view(perps), mids, oddsHistory });

const rule = (
  kind: AlertRule['kind'],
  params: AlertRule['params'],
  extra: Partial<AlertRule> = {},
) => ({ id: `r-${kind}`, kind, params, cooldownMs: 60_000, enabled: true, ...extra }) as AlertRule;

const ctx = {
  market: (key: string) => catalogue.byKey(key),
  byOutcome: (o: number) => catalogue.byOutcome(o),
};

describe('evaluateRule', () => {
  it('fires once when the price crosses upward, not again while it stays above', () => {
    const r = rule('priceCross', { coin: 'ETH', px: 3400, dir: 'above' });
    const evs = evaluateRule(r, snap({ ETH: '3390' }), snap({ ETH: '3405' }), NOW, ctx);
    expect(evs).toMatchObject([{ ruleId: 'r-priceCross', title: 'ETH above 3,400' }]);
    expect(evaluateRule(r, snap({ ETH: '3405' }), snap({ ETH: '3410' }), NOW, ctx)).toEqual([]);
  });

  it('fires on a downward cross for a "below" rule', () => {
    const r = rule('priceCross', { coin: 'ETH', px: 3400, dir: 'below' });
    expect(evaluateRule(r, snap({ ETH: '3410' }), snap({ ETH: '3399' }), NOW, ctx)).toMatchObject([
      { title: 'ETH below 3,400' },
    ]);
    expect(evaluateRule(r, snap({ ETH: '3390' }), snap({ ETH: '3405' }), NOW, ctx)).toEqual([]);
  });

  it('reports an odds move within the window, keyed by the outcome actually trading', () => {
    const r = rule('oddsMove', { marketKey: 'rb:BTC:1d', points: 8, windowMs: 600_000 });
    const history = new Map([['#273210', [{ t: NOW - 300_000, p: 0.54 }]]]);
    const evs = evaluateRule(
      r,
      snap({ '#273210': '0.55' }, [], history),
      snap({ '#273210': '0.62' }, [], history),
      NOW,
      ctx,
    );
    expect(evs).toMatchObject([{ title: 'BTC > 61,509 · 62% (+8)' }]);
  });

  it('ignores odds moves that are too small', () => {
    const r = rule('oddsMove', { marketKey: 'rb:BTC:1d', points: 8, windowMs: 600_000 });
    const small = new Map([['#273210', [{ t: NOW - 300_000, p: 0.58 }]]]);
    expect(evaluateRule(r, snap({}), snap({ '#273210': '0.62' }, [], small), NOW, ctx)).toEqual([]);
  });

  it('measures an odds move from the price at the start of the window, even after a quiet period', () => {
    const r = rule('oddsMove', { marketKey: 'rb:BTC:1d', points: 8, windowMs: 600_000 });
    // 50% for the last 20 minutes (history only stores changes), then a jump to 60%.
    const history = new Map([['#273210', [{ t: NOW - 1_200_000, p: 0.5 }]]]);
    const evs = evaluateRule(
      r,
      snap({ '#273210': '0.50' }, [], history),
      snap({ '#273210': '0.60' }, [], history),
      NOW,
      ctx,
    );
    expect(evs.map((e) => e.title)).toEqual(['BTC > 61,509 · 60% (+10)']);
    expect(evs[0]?.lines[0]).toBe('was 50% 10 min ago');
  });

  it('fires an odds move once on entering the moved state, not on every update while moved', () => {
    const r = rule('oddsMove', { marketKey: 'rb:BTC:1d', points: 8, windowMs: 600_000 });
    const history = new Map([['#273210', [{ t: NOW - 300_000, p: 0.5 }]]]);
    const stillMoved = evaluateRule(
      r,
      snap({ '#273210': '0.60' }, [], history),
      snap({ '#273210': '0.61' }, [], history),
      NOW,
      ctx,
    );
    expect(stillMoved).toEqual([]);
  });

  it("phrases a PnL rule action as the user's own rule", () => {
    const r = rule(
      'pnlPct',
      { coin: 'ETH', pct: 5 },
      { action: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 } },
    );
    const prev = snap({}, [eth({ markPx: 3120, upnlUsd: 60 })]); // +4%
    const next = snap({}, [eth({ markPx: 3165, upnlUsd: 82.5 })]); // +5.5%
    const [ev] = evaluateRule(r, prev, next, NOW, ctx);
    expect(ev?.title).toBe('ETH +5.5%');
    expect(ev?.lines).toContain('your rule: take half');
    expect(ev?.action).toEqual({ kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    expect(evaluateRule(r, next, next, NOW, ctx)).toEqual([]);
  });

  it('warns when a position gets closer to liquidation than the rule allows', () => {
    const r = rule('liqDistance', { pct: 10 });
    const prev = snap({}, [eth({ markPx: 2800, liqPx: 2500 })]); // 10.7%
    const next = snap({}, [eth({ markPx: 2720, liqPx: 2500 })]); // 8.1%
    expect(evaluateRule(r, prev, next, NOW, ctx)).toMatchObject([
      { title: 'ETH 8% from liquidation' },
    ]);
    expect(evaluateRule(r, next, next, NOW, ctx)).toEqual([]);
  });
});

describe('evaluateRule — liquidation distance', () => {
  const btc = (over: Partial<PerpPosition> = {}) =>
    eth({ coin: 'BTC', size: 0.01, entryPx: 90_000, markPx: 88_000, liqPx: 80_000, ...over });

  it('warns for every position that gets too close, each with its own cooldown key', () => {
    const r = rule('liqDistance', { pct: 10 });
    const prev = snap({}, [eth({ markPx: 2800 }), btc({ markPx: 90_000 })]); // 10.7%, 11.1%
    const next = snap({}, [eth({ markPx: 2720 }), btc({ markPx: 87_000 })]); // 8.1%, 8.0%
    const evs = evaluateRule(r, prev, next, NOW, ctx);
    expect(evs.map((e) => e.title)).toEqual(['ETH 8% from liquidation', 'BTC 8% from liquidation']);
    expect(new Set(evs.map((e) => e.key)).size).toBe(2);
  });

  it('warns on the first snapshot when a position is already close to liquidation', () => {
    const r = rule('liqDistance', { pct: 10 });
    const next = snap({}, [eth({ markPx: 2720, liqPx: 2500 })]);
    expect(evaluateRule(r, null, next, NOW, ctx).map((e) => e.title)).toEqual([
      'ETH 8% from liquidation',
    ]);
  });

  it('stays quiet on the first snapshot for crossing rules (a restart is not a cross)', () => {
    const r = rule('priceCross', { coin: 'ETH', px: 3400, dir: 'above' });
    expect(evaluateRule(r, null, snap({ ETH: '3405' }), NOW, ctx)).toEqual([]);
  });
});

describe('evaluateFill', () => {
  it('reports a settlement of a held outcome with the realized result (spike §5)', () => {
    const fill = {
      coin: '#271531',
      dir: 'Settlement',
      side: 'A',
      sz: '2.0',
      px: '1.0',
      closedPnl: '0.76438',
      crossed: true,
    };
    expect(evaluateFill(rule('settled', {}), fill, ctx)).toMatchObject({
      title: 'NO won · +$0.76',
    });
    expect(evaluateFill(rule('fill', {}), fill, ctx)).toBeNull();
  });

  const resting = {
    coin: 'ETH',
    dir: 'Open Long',
    side: 'B',
    sz: '0.01',
    px: '3000',
    closedPnl: '0',
    crossed: false,
    oid: 501,
  };

  it('reports a resting order that filled', () => {
    expect(evaluateFill(rule('fill', {}), resting, ctx)).toMatchObject({
      title: 'Order filled',
      lines: ['Bought 0.01 ETH @ 3,000'],
    });
    expect(evaluateFill(rule('settled', {}), resting, ctx)).toBeNull();
  });

  it('skips the fills of an order the user just confirmed, maker or taker', () => {
    const own = { ...ctx, isOwnFill: (f: { oid?: unknown }) => f.oid === 77 };
    // A confirmed outcome buy can come back as a maker fill (crossed: false).
    const confirmedBuy = { ...resting, coin: '#273210', dir: 'Buy', oid: 77 };
    expect(evaluateFill(rule('fill', {}), confirmedBuy, own)).toBeNull();
    expect(evaluateFill(rule('fill', {}), { ...confirmedBuy, crossed: true }, own)).toBeNull();
    expect(evaluateFill(rule('fill', {}), resting, own)).toMatchObject({ title: 'Order filled' });
  });

  it('reports a triggered stop, a taker fill the user did not just confirm, as a stop hit', () => {
    const stopFill = {
      coin: 'ETH',
      dir: 'Close Long',
      side: 'A',
      sz: '0.5',
      px: '2950',
      closedPnl: '-188.4',
      crossed: true,
      oid: 900,
    };
    const withStop = {
      ...ctx,
      isOwnFill: () => false,
      stopFor: (c: string) => (c === 'ETH' ? 2950 : undefined),
    };
    expect(evaluateFill(rule('fill', {}), stopFill, withStop)).toMatchObject({
      title: 'Stop hit · ETH',
      lines: ['Sold 0.5 ETH @ 2,950 · PnL −$188.40'],
    });
    // Without a known stop on that coin it is still reported, as a plain fill.
    expect(evaluateFill(rule('fill', {}), stopFill, ctx)).toMatchObject({ title: 'Order filled' });
  });
});
