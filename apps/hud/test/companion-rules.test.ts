import { type AlertRule, AlertRuleSchema } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { buildRule, describeRule } from '../src/companion/rules';

const ok = (r: ReturnType<typeof buildRule>): AlertRule => {
  if ('error' in r) throw new Error(r.error);
  // Whatever the form builds must be accepted by the server as is.
  return AlertRuleSchema.parse(r.rule);
};

describe('buildRule — PnL', () => {
  it('builds a PnL rule whose alert offers "take half"', () => {
    const rule = ok(buildRule({ kind: 'pnl', coin: 'eth', pct: '5', action: 'half' }));
    expect(rule).toMatchObject({
      kind: 'pnlPct',
      params: { coin: 'ETH', pct: 5 },
      action: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 },
      enabled: true,
    });
  });

  it('offers a full close, or no action, and accepts a loss threshold', () => {
    expect(ok(buildRule({ kind: 'pnl', coin: 'BTC', pct: '-3', action: 'close' })).action).toEqual({
      kind: 'closePerp',
      coin: 'BTC',
      fraction: 1,
    });
    expect(ok(buildRule({ kind: 'pnl', coin: 'BTC', pct: '8', action: 'none' })).action).toBe(
      undefined,
    );
  });

  it('says what is missing instead of saving a rule that can never fire', () => {
    expect(buildRule({ kind: 'pnl', coin: ' ', pct: '5', action: 'half' })).toEqual({
      error: 'Enter a coin and a PnL %',
    });
    expect(buildRule({ kind: 'pnl', coin: 'ETH', pct: '0', action: 'half' })).toEqual({
      error: 'Enter a coin and a PnL %',
    });
  });
});

describe('buildRule — odds move', () => {
  it('builds an odds-move rule on a watched market with its window in minutes', () => {
    const rule = ok(
      buildRule({ kind: 'odds', marketKey: 'rb:BTC:1d', points: '8', minutes: '10' }),
    );
    expect(rule).toMatchObject({
      kind: 'oddsMove',
      params: { marketKey: 'rb:BTC:1d', points: 8, windowMs: 600_000 },
    });
  });

  it('refuses a missing market, a move outside 1–99 points or a window over an hour', () => {
    const err = { error: 'Pick a watched market, 1–99 points and 1–60 minutes' };
    expect(buildRule({ kind: 'odds', marketKey: '', points: '8', minutes: '10' })).toEqual(err);
    expect(buildRule({ kind: 'odds', marketKey: 'rb:BTC:1d', points: '0', minutes: '10' })).toEqual(
      err,
    );
    expect(buildRule({ kind: 'odds', marketKey: 'rb:BTC:1d', points: '8', minutes: '90' })).toEqual(
      err,
    );
  });
});

describe('buildRule — liquidation warning', () => {
  const current: AlertRule = {
    id: 'default-liq',
    kind: 'liqDistance',
    params: { pct: 10 },
    cooldownMs: 600_000,
    enabled: false,
  };

  it('edits the existing liquidation rule in place (same id, cooldown and on/off)', () => {
    expect(ok(buildRule({ kind: 'liq', pct: '15' }, current))).toEqual({
      ...current,
      params: { pct: 15 },
    });
  });

  it('creates the rule when there is none, and refuses a distance outside 1–50%', () => {
    expect(ok(buildRule({ kind: 'liq', pct: '12' }))).toMatchObject({
      id: 'default-liq',
      kind: 'liqDistance',
      params: { pct: 12 },
      enabled: true,
    });
    expect(buildRule({ kind: 'liq', pct: '80' }, current)).toEqual({
      error: 'Liquidation distance is 1–50%',
    });
  });
});

describe('describeRule', () => {
  it('reads each rule the way the alert will', () => {
    const pnl = ok(buildRule({ kind: 'pnl', coin: 'ETH', pct: '5', action: 'half' }));
    expect(describeRule(pnl)).toBe('ETH PnL ≥ +5% → take half');
    const loss = ok(buildRule({ kind: 'pnl', coin: 'ETH', pct: '-4', action: 'none' }));
    expect(describeRule(loss)).toBe('ETH PnL ≤ −4%');
    const odds = ok(
      buildRule({ kind: 'odds', marketKey: 'rb:BTC:1d', points: '8', minutes: '10' }),
    );
    expect(describeRule(odds)).toBe('rb:BTC:1d moves 8 pts in 10 min');
    expect(describeRule({ id: 'f', kind: 'fill', params: {}, cooldownMs: 0, enabled: true })).toBe(
      'Order filled or stop hit',
    );
  });
});
