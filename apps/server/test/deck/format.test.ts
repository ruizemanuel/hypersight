import { describe, expect, it } from 'vitest';
import {
  bar,
  fmtPct,
  fmtPrice,
  fmtProb,
  fmtSize,
  fmtUntil,
  fmtUsd,
  trend,
} from '../../src/deck/format';

describe('fmtUsd', () => {
  it.each<[number, { sign?: boolean } | undefined, string]>([
    [1234.5, undefined, '$1,234.50'],
    [0, undefined, '$0.00'],
    [42.1, { sign: true }, '+$42.10'],
    [-29.12, { sign: true }, '−$29.12'],
    [-29.12, undefined, '−$29.12'],
    [-0.004, { sign: true }, '$0.00'],
    [123456, undefined, '$123.5k'],
    [-250000, { sign: true }, '−$250.0k'],
    [99999.99, undefined, '$99,999.99'],
    [12_500_000, undefined, '$12.5M'],
  ])('fmtUsd(%s, %o) → %s', (n, opts, want) => {
    expect(fmtUsd(n, opts)).toBe(want);
  });
});

describe('fmtPrice', () => {
  it.each([
    [62317, '62,317'],
    [1756.7, '1,756.7'],
    [0.02305, '0.02305'],
    [3411.24, '3,411.2'],
    [123456.7, '123,460'],
    [0.6, '0.6'],
  ])('fmtPrice(%s) → %s', (n, want) => {
    expect(fmtPrice(n)).toBe(want);
  });
});

describe('fmtPct', () => {
  it.each<[number, { sign?: boolean } | undefined, string]>([
    [0.031, { sign: true }, '+3.1%'],
    [-0.135, { sign: true }, '−13.5%'],
    [0.031, undefined, '3.1%'],
    [0, { sign: true }, '0.0%'],
  ])('fmtPct(%s, %o) → %s', (n, opts, want) => {
    expect(fmtPct(n, opts)).toBe(want);
  });
});

describe('fmtProb', () => {
  it.each([
    [0.593705, '59%'],
    [0.5, '50%'],
    [0.003, '<1%'],
    [0.997, '>99%'],
    [0, '0%'],
    [1, '100%'],
  ])('fmtProb(%s) → %s', (p, want) => {
    expect(fmtProb(p)).toBe(want);
  });
});

describe('fmtUntil', () => {
  const now = Date.UTC(2026, 10, 23, 12, 0);
  it.each([
    [now + (2 * 60 + 5) * 60_000, 'in 2h 05m'],
    [now + 42 * 60_000, 'in 42m'],
    [now + 30_000, 'in <1m'],
    [now + 3 * 86_400_000 + 3_600_000, 'in 3d'],
    [now, 'closed'],
    [now - 1000, 'closed'],
  ])('fmtUntil(%s) → %s', (ts, want) => {
    expect(fmtUntil(ts, now)).toBe(want);
  });
});

describe('fmtSize', () => {
  it.each<[number, number, string]>([
    [0.5, 4, '0.5'],
    [2.21, 2, '2.21'],
    [0.016749, 4, '0.0167'],
    [3, 0, '3'],
  ])('fmtSize(%s, %s) → %s', (n, d, want) => {
    expect(fmtSize(n, d)).toBe(want);
  });
});

describe('trend', () => {
  it('marks a gain with ▲ and a loss with ▼, and nothing when it rounds to zero cents', () => {
    expect(trend(42.1)).toBe('▲ ');
    expect(trend(-0.09)).toBe('▼ ');
    expect(trend(0.004)).toBe('');
    expect(trend(-0.004)).toBe('');
    expect(trend(0)).toBe('');
  });
});

describe('bar', () => {
  it('draws a 0–1 share as solid blocks on a thin track (24 by default)', () => {
    expect(bar(0.32)).toBe('█'.repeat(8) + '─'.repeat(16));
    expect(bar(0.5, 20)).toBe('█'.repeat(10) + '─'.repeat(10));
  });

  it('clamps out-of-range and missing values instead of drawing a broken bar', () => {
    expect(bar(1.7)).toBe('█'.repeat(24));
    expect(bar(-0.2)).toBe('─'.repeat(24));
    expect(bar(Number.NaN)).toBe('─'.repeat(24));
  });
});
