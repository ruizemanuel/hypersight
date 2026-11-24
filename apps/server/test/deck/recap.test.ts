import { describe, expect, it } from 'vitest';
import { computeRecap } from '../../src/deck/recap';
import type { AuditEntry } from '../../src/store/repos';

const DAY = Date.UTC(2026, 10, 24);
const NOW = DAY + 15 * 3_600_000;
const H = 3_600_000;

const proposal = (id: string, ts: number, intent: unknown): AuditEntry => ({
  ts,
  kind: 'proposal',
  proposalId: id,
  summary: id,
  data: { intent, plan: { steps: [], requestedSz: 0 } },
});
const result = (id: string, ts: number, data: unknown): AuditEntry => ({
  ts,
  kind: 'result',
  proposalId: id,
  summary: id,
  data,
});

// Three orders today (one filled, one refused, one partially filled), a cancel-all that is not a
// trade, and one order from yesterday.
const entries: AuditEntry[] = [
  proposal('p0', DAY - H, { kind: 'closePerp', coin: 'ETH', fraction: 1 }),
  result('p0', DAY - H, { status: 'filled', message: 'Filled 0.1 @ 3300' }),
  proposal('p1', NOW - 5 * H, { kind: 'closePerp', coin: 'ETH', fraction: 0.5 }),
  result('p1', NOW - 5 * H, { status: 'filled', filledSz: 0.25, avgPx: 3411, message: 'Filled' }),
  proposal('p2', NOW - 4 * H, { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 5 }),
  result('p2', NOW - 4 * H, { status: 'none', message: 'No liquidity — nothing executed' }),
  proposal('p3', NOW - 3 * H, {
    kind: 'sellOutcome',
    marketKey: 'rb:ETH:1d',
    sideIndex: 0,
    fraction: 1,
  }),
  result('p3', NOW - 3 * H, { status: 'partial', filledSz: 5, avgPx: 0.6, message: 'Partially' }),
  proposal('p4', NOW - 2 * H, { kind: 'cancelAll' }),
  result('p4', NOW - 2 * H, { status: 'filled', message: 'Cancelled 2 orders' }),
];

const fills = [
  { coin: 'ETH', closedPnl: '41.6', fee: '0.5', time: NOW - 5 * H },
  { coin: '#273210', closedPnl: '22.6', fee: '0.5', time: NOW - 3 * H },
  { coin: 'BTC', closedPnl: '0.0', fee: '0.0', time: NOW - 2 * H },
  { coin: 'ETH', closedPnl: '500', fee: '0', time: DAY - H }, // yesterday
];

const nameOf = (coin: string) => (coin === '#273210' ? 'ETH > 1,685.2' : coin);

describe('computeRecap', () => {
  it("sums today's orders and realized PnL, net of fees, and names the best market", () => {
    expect(computeRecap({ entries, fills, now: NOW, nameOf })).toEqual({
      trades: 3,
      filled: 2,
      realizedUsd: expect.closeTo(63.2, 6),
      best: { name: 'ETH', pnlUsd: expect.closeTo(41.1, 6) },
    });
  });

  it('has nothing to say before the first order of the day', () => {
    expect(computeRecap({ entries: entries.slice(0, 2), fills: [], now: NOW, nameOf })).toBeNull();
  });

  it('names no best market when nothing made money', () => {
    const losing = [{ coin: 'ETH', closedPnl: '-12', fee: '0.5', time: NOW - H }];
    const recap = computeRecap({ entries, fills: losing, now: NOW, nameOf });
    expect(recap?.realizedUsd).toBe(-12.5);
    expect(recap?.best).toBeUndefined();
  });
});
