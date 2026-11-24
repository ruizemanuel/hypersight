import { DEFAULT_RISK_LIMITS } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { checkRisk, type RiskInput } from '../../src/trade/risk';

const NOW = 1_795_470_000_000;
const ctx = { dailyUsedUsd: 0, lastWriteAt: null, now: NOW };
const open = (over: Partial<RiskInput> = {}): RiskInput => ({
  network: 'testnet',
  coin: 'ETH',
  notionalUsd: 50,
  leverage: 2,
  reducesExposure: false,
  ...over,
});

describe('checkRisk', () => {
  it('allows a normal order', () => {
    expect(checkRisk(open(), DEFAULT_RISK_LIMITS, ctx)).toEqual({ ok: true });
  });

  it('refuses anything that is not testnet', () => {
    expect(checkRisk(open({ network: 'mainnet' }), DEFAULT_RISK_LIMITS, ctx)).toEqual({
      ok: false,
      reason: 'Testnet only',
    });
  });

  it('blocks an order above the per-order cap and shows the cap (Review Focus 5)', () => {
    expect(checkRisk(open({ notionalUsd: 500 }), DEFAULT_RISK_LIMITS, ctx)).toEqual({
      ok: false,
      reason: 'Max order is $250',
    });
  });

  it('allows an order exactly at the cap', () => {
    expect(checkRisk(open({ notionalUsd: 250 }), DEFAULT_RISK_LIMITS, ctx)).toEqual({ ok: true });
  });

  it('lets a position be reduced even above the caps', () => {
    const close = open({ notionalUsd: 900, reducesExposure: true, leverage: undefined });
    expect(checkRisk(close, DEFAULT_RISK_LIMITS, { ...ctx, dailyUsedUsd: 1990 })).toEqual({
      ok: true,
    });
  });

  it('blocks once the daily notional would pass the daily limit', () => {
    expect(
      checkRisk(open({ notionalUsd: 50 }), DEFAULT_RISK_LIMITS, { ...ctx, dailyUsedUsd: 1960 }),
    ).toEqual({ ok: false, reason: 'Daily limit $2,000 reached' });
    expect(
      checkRisk(open({ notionalUsd: 40 }), DEFAULT_RISK_LIMITS, { ...ctx, dailyUsedUsd: 1960 }),
    ).toEqual({ ok: true });
  });

  it('blocks leverage above the maximum', () => {
    expect(checkRisk(open({ leverage: 10 }), DEFAULT_RISK_LIMITS, ctx)).toEqual({
      ok: false,
      reason: 'Max leverage 5×',
    });
  });

  it('blocks coins that are not enabled, but not outcome orders without a coin', () => {
    expect(checkRisk(open({ coin: 'DOGE' }), DEFAULT_RISK_LIMITS, ctx)).toEqual({
      ok: false,
      reason: 'DOGE not enabled',
    });
    expect(
      checkRisk(open({ coin: undefined, leverage: undefined }), DEFAULT_RISK_LIMITS, ctx),
    ).toEqual({
      ok: true,
    });
  });

  it('throttles writes closer together than the minimum interval', () => {
    expect(checkRisk(open(), DEFAULT_RISK_LIMITS, { ...ctx, lastWriteAt: NOW - 500 })).toEqual({
      ok: false,
      reason: 'Too fast — wait a second',
    });
    expect(checkRisk(open(), DEFAULT_RISK_LIMITS, { ...ctx, lastWriteAt: NOW - 2000 })).toEqual({
      ok: true,
    });
  });

  it('formats the caps from the configured limits', () => {
    const limits = {
      ...DEFAULT_RISK_LIMITS,
      maxOrderUsd: 1000,
      maxDailyUsd: 12_500,
      maxLeverage: 3,
    };
    expect(checkRisk(open({ notionalUsd: 1500 }), limits, ctx)).toMatchObject({
      reason: 'Max order is $1,000',
    });
    expect(checkRisk(open({ leverage: 4 }), limits, ctx)).toMatchObject({
      reason: 'Max leverage 3×',
    });
    expect(checkRisk(open(), limits, { ...ctx, dailyUsedUsd: 12_480 })).toMatchObject({
      reason: 'Daily limit $12,500 reached',
    });
  });
});
