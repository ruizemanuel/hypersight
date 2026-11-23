import { describe, expect, it } from 'vitest';
import meta from '../../../../fixtures/hl/meta.json';
import {
  outcomeAsset,
  outcomeBalanceCoin,
  outcomeCoin,
  outcomeEnc,
  parseBalanceCoin,
  parsePerpMeta,
} from '../../src/hl/ids';

describe('outcome ids', () => {
  it('encodes outcome and side as 10·outcome + side', () => {
    expect(outcomeEnc(27121, 0)).toBe(271210);
    expect(outcomeEnc(27153, 1)).toBe(271531);
  });

  it('builds the order coin, balance coin and asset id', () => {
    expect(outcomeCoin(27121, 1)).toBe('#271211');
    expect(outcomeBalanceCoin(27121, 0)).toBe('+271210');
    expect(outcomeAsset(27121, 0)).toBe(100271210);
    expect(outcomeAsset(27153, 1)).toBe(100271531);
  });

  it.each([
    ['+271210', { outcome: 27121, side: 0 }],
    ['+271531', { outcome: 27153, side: 1 }],
  ])('parses balance coin %s', (coin, expected) => {
    expect(parseBalanceCoin(coin)).toEqual(expected);
  });

  it.each(['USDC', '#271210', '+27121x', '+', '+271212', 'o27153', ''])(
    'rejects %s as an outcome balance coin',
    (coin) => {
      expect(parseBalanceCoin(coin)).toBeNull();
    },
  );
});

describe('parsePerpMeta', () => {
  const perps = parsePerpMeta(meta as Parameters<typeof parsePerpMeta>[0]);

  it('keeps the universe index as the asset id (testnet BTC = 3)', () => {
    expect(perps.find((p) => p.name === 'BTC')).toEqual({
      name: 'BTC',
      index: 3,
      szDecimals: 5,
      maxLeverage: 40,
      onlyIsolated: false,
    });
    expect(perps.find((p) => p.name === 'ETH')).toMatchObject({ index: 4, szDecimals: 4 });
  });

  it('flags isolated-only assets', () => {
    expect(perps.find((p) => p.name === 'HYPE')).toMatchObject({ index: 135, onlyIsolated: true });
  });

  it('skips delisted assets', () => {
    expect(perps.find((p) => p.name === 'ZEC')).toBeUndefined();
    expect(perps).toHaveLength(159);
  });
});
