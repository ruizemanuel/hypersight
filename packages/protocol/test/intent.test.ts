import { describe, expect, it } from 'vitest';
import { IntentSchema } from '../src/index';

describe('IntentSchema', () => {
  it('accepts a partial perp close', () => {
    expect(IntentSchema.parse({ kind: 'closePerp', coin: 'ETH', fraction: 0.5 })).toEqual({
      kind: 'closePerp',
      coin: 'ETH',
      fraction: 0.5,
    });
  });

  it.each([0, 1.2, -0.5])('rejects close fraction %s (must be 0 < f <= 1)', (fraction) => {
    expect(() => IntentSchema.parse({ kind: 'closePerp', coin: 'ETH', fraction })).toThrow();
  });

  it('accepts closing the whole position (fraction 1)', () => {
    expect(IntentSchema.parse({ kind: 'closePerp', coin: 'BTC', fraction: 1 }).kind).toBe(
      'closePerp',
    );
  });

  it('rejects an outcome side other than 0 or 1', () => {
    expect(() =>
      IntentSchema.parse({ kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 2, usd: 10 }),
    ).toThrow();
  });

  it('accepts buying the NO side of an outcome', () => {
    expect(
      IntentSchema.parse({ kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 1, usd: 10 }),
    ).toMatchObject({ sideIndex: 1, usd: 10 });
  });

  it('requires a reason on unknown intents', () => {
    expect(() => IntentSchema.parse({ kind: 'unknown' })).toThrow();
    expect(IntentSchema.parse({ kind: 'unknown', reason: 'not a trading command' })).toEqual({
      kind: 'unknown',
      reason: 'not a trading command',
    });
  });

  it('rejects non-positive USD amounts and out-of-range leverage on opens', () => {
    expect(() =>
      IntentSchema.parse({ kind: 'openPerp', coin: 'SOL', side: 'long', usd: 0 }),
    ).toThrow();
    expect(() =>
      IntentSchema.parse({ kind: 'openPerp', coin: 'SOL', side: 'long', usd: 50, leverage: 51 }),
    ).toThrow();
    expect(() =>
      IntentSchema.parse({ kind: 'openPerp', coin: 'SOL', side: 'long', usd: 50, leverage: 2.5 }),
    ).toThrow();
    expect(
      IntentSchema.parse({ kind: 'openPerp', coin: 'SOL', side: 'short', usd: 50, leverage: 3 }),
    ).toMatchObject({ side: 'short', leverage: 3 });
  });

  it('rejects an unknown kind', () => {
    expect(() => IntentSchema.parse({ kind: 'withdraw', usd: 100 })).toThrow();
  });
});
