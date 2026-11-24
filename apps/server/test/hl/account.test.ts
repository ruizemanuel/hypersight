import { describe, expect, it } from 'vitest';
import clearinghouse from '../../../../fixtures/hl/clearinghouseState.json';
import spot from '../../../../fixtures/hl/spotState.json';
import { type AccountInput, buildAccountView } from '../../src/hl/account';
import type { PerpMeta } from '../../src/hl/ids';
import { Catalogue } from '../../src/hl/outcomes';

const catalogue = new Catalogue();
catalogue.reset(
  {
    outcomes: [
      {
        outcome: 27121,
        name: 'Recurring',
        description:
          'class:priceBinary|underlying:BTC|expiry:20261120-0300|targetPrice:61509|period:1d',
        sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
      },
    ],
    questions: [],
  },
  [],
);

const perpMeta: PerpMeta[] = [
  { name: 'SOL', index: 0, szDecimals: 2, maxLeverage: 10, onlyIsolated: false },
  { name: 'ETH', index: 4, szDecimals: 4, maxLeverage: 25, onlyIsolated: false },
];

const emptyClearinghouse = {
  marginSummary: {
    accountValue: '0.0',
    totalNtlPos: '0.0',
    totalRawUsd: '0.0',
    totalMarginUsed: '0.0',
  },
  crossMarginSummary: {
    accountValue: '0.0',
    totalNtlPos: '0.0',
    totalRawUsd: '0.0',
    totalMarginUsed: '0.0',
  },
  crossMaintenanceMarginUsed: '0.0',
  withdrawable: '0.0',
  assetPositions: [],
};

const input = (over: Partial<AccountInput> = {}): AccountInput => ({
  clearinghouse: clearinghouse as AccountInput['clearinghouse'],
  spot: spot as AccountInput['spot'],
  mids: { '#271210': '0.6', '#271230': '0.5', ETH: '3411.0' },
  catalogue,
  perpMeta,
  abstraction: 'default',
  now: 1_795_470_000_000,
  ...over,
});

describe('buildAccountView', () => {
  it('reads a perp position with a null liquidation price', () => {
    const sol = buildAccountView(input()).perps.find((p) => p.coin === 'SOL');
    expect(sol).toMatchObject({
      size: 2.21,
      entryPx: 85.5682,
      leverage: 10,
      liqPx: null,
      szDecimals: 2,
    });
    expect(sol?.upnlUsd).toBeCloseTo(-29.120862, 6);
    // no SOL mid → mark derived from positionValue / |szi|
    expect(sol?.markPx).toBeCloseTo(159.984994 / 2.21, 6);
  });

  it('uses the mid as mark price when available', () => {
    const eth = buildAccountView(input()).perps.find((p) => p.coin === 'ETH');
    expect(eth).toMatchObject({ size: 0.5, markPx: 3411, liqPx: 2950, leverage: 2, roe: 0.031 });
  });

  it('marks outcome balances to market', () => {
    const pos = buildAccountView(input()).outcomes.find((o) => o.market.outcome === 27121);
    expect(pos).toMatchObject({
      sideIndex: 0,
      shares: 8,
      entryUsd: 4.73112,
      mid: 0.6,
      maxPayoutUsd: 8,
    });
    expect(pos?.valueUsd).toBeCloseTo(4.8, 9);
    expect(pos?.upnlUsd).toBeCloseTo(0.06888, 9);
    expect(pos?.market.key).toBe('rb:BTC:1d');
  });

  it('keeps a held outcome whose market is not in the catalogue', () => {
    const pos = buildAccountView(input()).outcomes.find((o) => o.market.outcome === 27123);
    expect(pos).toMatchObject({ shares: 22, market: { key: 'o:27123', sides: ['Yes', 'No'] } });
    expect(pos?.valueUsd).toBeCloseTo(11, 9);
  });

  it('computes equity for standard accounts: perp account value + spot USDC + outcomes', () => {
    const v = buildAccountView(input());
    expect(v.equityUsd).toBeCloseTo(3370.641206 + 501.12962316 + 4.8 + 11, 6);
    expect(v.spotUsdc).toBeCloseTo(501.12962316, 8);
    expect(v.perpWithdrawableUsd).toBeCloseTo(2397.029985, 6);
    expect(v.perpUpnlUsd).toBeCloseTo(-29.120862 + 42.1, 6);
    expect(v.marginRatio).toBeCloseTo(453.858664 / 3343.540876, 6);
    expect(v.marginUsage).toBeCloseTo(868.748499 / 3370.641206, 6);
    expect(v.abstraction).toBe('default');
    expect(v.updatedAt).toBe(1_795_470_000_000);
  });

  it('treats spot USDC as the balance source of truth in unified accounts', () => {
    const v = buildAccountView(input({ abstraction: 'unifiedAccount' }));
    expect(v.equityUsd).toBeCloseTo(501.12962316 + (-29.120862 + 42.1) + 4.8 + 11, 6);
  });

  it('shows an empty account as spot USDC only', () => {
    const v = buildAccountView(
      input({
        clearinghouse: emptyClearinghouse as AccountInput['clearinghouse'],
        spot: {
          balances: [{ coin: 'USDC', token: 0, total: '997.0', hold: '0.0', entryNtl: '0.0' }],
        },
      }),
    );
    expect(v.perps).toEqual([]);
    expect(v.outcomes).toEqual([]);
    expect(v.equityUsd).toBe(997);
    expect(v.marginRatio).toBe(0);
  });

  it('skips zero-size rows', () => {
    const v = buildAccountView(
      input({
        spot: { balances: [{ coin: '+271210', total: '0.0', hold: '0.0', entryNtl: '0.0' }] },
      }),
    );
    expect(v.outcomes).toEqual([]);
    expect(v.spotUsdc).toBe(0);
  });
});
