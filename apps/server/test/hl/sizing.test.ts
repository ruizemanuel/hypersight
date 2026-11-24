import { describe, expect, it } from 'vitest';
import {
  outcomeSellSlippagePrice,
  outcomeShares,
  outcomeSlippagePrice,
  perpSlippagePrice,
  roundOutcomePrice,
  roundPerpPrice,
  roundPerpSize,
  sizeOutcomeBuy,
} from '../../src/hl/sizing';

describe('perp sizing', () => {
  it.each<[number, number, 'down' | 'nearest', string]>([
    [0.0335 * 0.5, 4, 'down', '0.0167'],
    [0.3, 1, 'down', '0.3'], // 0.3 * 10 = 2.9999999999999996 in floats: must not round to 0.2
    [0.01675, 4, 'nearest', '0.0168'],
    [2.21, 2, 'down', '2.21'],
    [1.5, 0, 'down', '1'],
    [0.00009, 4, 'down', '0'],
    [12.5, 3, 'down', '12.5'],
  ])('roundPerpSize(%s, %s, %s) → %s', (sz, dec, mode, want) => {
    expect(roundPerpSize(sz, dec, mode)).toBe(want);
  });

  it.each<[number, number, string]>([
    [1756.73, 4, '1756.7'],
    [62317.4, 5, '62317'],
    [123456.7, 3, '123457'], // integers are always valid, even beyond 5 significant figures
    [85.56824, 2, '85.568'],
    [0.0123456, 0, '0.012346'], // ≤ 6 − szDecimals decimals and 5 significant figures
    [3200, 4, '3200'],
  ])('roundPerpPrice(%s, %s) → %s', (px, dec, want) => {
    expect(roundPerpPrice(px, dec)).toBe(want);
  });

  it('builds an aggressive IOC limit from the reference price', () => {
    expect(perpSlippagePrice(62300, true, 0.05, 5)).toBe('65415');
    expect(perpSlippagePrice(3411, false, 0.01, 4)).toBe('3376.9');
  });
});

describe('outcome sizing', () => {
  it.each<[number, number, number]>([
    [25, 0.62, 40],
    [0.05, 0.62, 0],
    [0.9, 0.3, 0], // 3 shares = $0.90 < the $1 minimum
    [1, 0.25, 4], // exactly $1.00 is allowed
    [10, 0.5, 20],
    [5, 0.51, 9],
  ])('outcomeShares($%s at %s) → %s', (usd, price, want) => {
    expect(outcomeShares(usd, price)).toBe(want);
  });

  it.each<[number, string]>([
    [1, '0.99999'],
    [0, '0.00001'],
    [0.0230512, '0.02305'],
    [0.6, '0.6'],
    [0.123456, '0.12346'],
  ])('roundOutcomePrice(%s) → %s', (p, want) => {
    expect(roundOutcomePrice(p)).toBe(want);
  });

  it('adds slippage in ticks of 0.01, clamped inside (0, 1)', () => {
    expect(outcomeSlippagePrice(0.6, 3)).toBe('0.63');
    expect(outcomeSlippagePrice(0.985, 3)).toBe('0.99999');
    expect(outcomeSellSlippagePrice(0.6, 3)).toBe('0.57');
    expect(outcomeSellSlippagePrice(0.02, 3)).toBe('0.00001');
  });
});

describe('outcome buy sizing', () => {
  it('gives up a few shares so a one-tick move still fills', () => {
    // $5 at 0.50 buys 10 shares only with the limit at the ask itself.
    const size = sizeOutcomeBuy([{ px: 0.5, sz: 1000 }], 5, 3);
    expect(size).toMatchObject({ shares: 9, limit: 0.53 });
    expect(size?.worst).toBeLessThanOrEqual(5);
  });

  it('keeps every share when the room would cost too many of them', () => {
    // At 0.05 one tick is 20% of the shares: the limit stays at the ask.
    expect(sizeOutcomeBuy([{ px: 0.05, sz: 1000 }], 5, 3)).toMatchObject({
      shares: 100,
      limit: 0.05,
    });
  });
});
