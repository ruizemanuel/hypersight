import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import { describe, expect, it } from 'vitest';
import { humanizeHlError, mapOrderStatuses } from '../../src/hl/errors';

describe('mapOrderStatuses (partial fills are never reported as filled)', () => {
  it('reports a partial fill with filled/requested and the average price', () => {
    expect(
      mapOrderStatuses([{ filled: { totalSz: '12', avgPx: '0.61', oid: 1 } }], 40),
    ).toMatchObject({
      status: 'partial',
      filledSz: 12,
      requestedSz: 40,
      message: 'Partially filled 12/40 @ 0.61',
    });
  });

  it('reports a full fill', () => {
    expect(
      mapOrderStatuses([{ filled: { totalSz: '40', avgPx: '0.61', oid: 1 } }], 40),
    ).toMatchObject({
      status: 'filled',
      filledSz: 40,
      requestedSz: 40,
      avgPx: 0.61,
      message: 'Filled 40 @ 0.61',
    });
  });

  it('sums split fills and averages their prices by size', () => {
    const r = mapOrderStatuses(
      [
        { filled: { totalSz: '0.002', avgPx: '3000', oid: 1 } },
        { filled: { totalSz: '0.002', avgPx: '3010', oid: 2 } },
      ],
      0.004,
    );
    expect(r).toMatchObject({ status: 'filled', filledSz: 0.004, avgPx: 3005 });
  });

  it('reports an IOC with no liquidity as nothing executed', () => {
    expect(
      mapOrderStatuses(
        [
          {
            error: 'Order could not immediately match against any resting orders. asset=100271210',
          },
        ],
        40,
      ),
    ).toMatchObject({ status: 'none', message: 'No liquidity — nothing executed' });
  });

  it('reports a resting order and a waiting trigger as resting', () => {
    expect(mapOrderStatuses([{ resting: { oid: 5 } }], 1)).toMatchObject({ status: 'resting' });
    expect(mapOrderStatuses(['waitingForTrigger'], 1)).toMatchObject({ status: 'resting' });
  });

  it('collects the order ids of filled and resting orders', () => {
    const r = mapOrderStatuses(
      [
        { filled: { totalSz: '0.002', avgPx: '3000', oid: 1 } },
        { filled: { totalSz: '0.002', avgPx: '3010', oid: 2 } },
      ],
      0.004,
    );
    expect(r.oids).toEqual([1, 2]);
    expect(mapOrderStatuses([{ resting: { oid: 5 } }], 1).oids).toEqual([5]);
  });

  it('treats an empty or unexpected response as an error', () => {
    expect(mapOrderStatuses([], 1)).toMatchObject({ status: 'error' });
    expect(mapOrderStatuses([{ weird: true }], 1)).toMatchObject({ status: 'error' });
  });
});

describe('humanizeHlError', () => {
  it.each<[unknown, string]>([
    ['Order must have minimum value of 1 USDC. asset=100271530', 'Below $1 minimum'],
    ['Order has invalid size.', 'Whole shares only'],
    ['Order must have minimum value of $10.', 'Below $10 minimum'],
    ['Order has insufficient spot balance to trade', 'Not enough USDC'],
    ['Price must be divisible by tick size. asset=100271210', 'Price precision error'],
    ['Action already expired', 'Expired — nothing sent'],
    [
      'Order could not immediately match against any resting orders.',
      'No liquidity — nothing executed',
    ],
    ['Insufficient margin to place order.', 'Not enough margin'],
    ['Invalid TP/SL price.', 'Stop price is on the wrong side'],
    [new Error('order 0: Order has invalid size.'), 'Whole shares only'],
    [
      new ApiRequestError(
        { status: 'err', response: 'Action already expired' },
        'Action already expired',
      ),
      'Expired — nothing sent',
    ],
    [
      'Something brand new happened on the exchange today',
      'Hyperliquid error: Something brand new happened on the exchange today',
    ],
  ])('%s → %s', (e, want) => {
    expect(humanizeHlError(e)).toBe(want);
  });

  it('keeps unknown messages short', () => {
    expect(humanizeHlError('x'.repeat(200))).toBe(`Hyperliquid error: ${'x'.repeat(60)}`);
  });
});
