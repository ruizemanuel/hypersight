import { describe, expect, it } from 'vitest';
import { buildAccountView } from '../../src/hl/account';
import type { Book } from '../../src/hl/market-stream';
import { Catalogue } from '../../src/hl/outcomes';
import type { PaperFill } from '../../src/store/repos';
import type { PlaceOrder } from '../../src/trade/executor';
import { PaperExecutor, paperAccountState } from '../../src/trade/paper-executor';

const NOW = 1_795_000_000_000;

function harness(books: Record<string, Book>) {
  const fills: PaperFill[] = [];
  const ledger = { append: (f: PaperFill) => fills.push(f), list: () => fills };
  const executor = new PaperExecutor({
    book: async (coin) => books[coin] ?? { bids: [], asks: [] },
    ledger,
    now: () => NOW,
  });
  return { executor, fills };
}

const level = (px: number, sz: number) => ({ px, sz });
const yesBook: Book = { bids: [level(0.6, 50)], asks: [level(0.62, 100)] };
const buyYes: PlaceOrder = {
  kind: 'order',
  asset: 100271210,
  coin: '#271210',
  isBuy: true,
  px: '0.65',
  sz: '40',
  reduceOnly: false,
  tif: 'Ioc',
};

describe('PaperExecutor', () => {
  it('fills an IOC buy at the best ask for the full size and records it', async () => {
    const { executor, fills } = harness({ '#271210': yesBook });
    const r = await executor.execute({
      steps: [{ kind: 'perpToSpot', usd: '15' }, buyYes],
      requestedSz: 40,
    });
    expect(r).toMatchObject({
      status: 'filled',
      filledSz: 40,
      avgPx: 0.62,
      message: 'Filled 40 @ 0.62',
    });
    expect(fills).toEqual([{ ts: NOW, coin: '#271210', isBuy: true, sz: 40, px: 0.62 }]);
  });

  it('fills a sell at the best bid', async () => {
    const { executor, fills } = harness({ '#271210': yesBook });
    await executor.execute({
      steps: [{ ...buyYes, isBuy: false, px: '0.55', reduceOnly: true }],
      requestedSz: 40,
    });
    expect(fills[0]).toMatchObject({ isBuy: false, px: 0.6 });
  });

  it('executes nothing when the book is empty or beyond the limit price', async () => {
    const { executor, fills } = harness({ '#271210': { bids: [], asks: [level(0.9, 100)] } });
    expect(await executor.execute({ steps: [buyYes], requestedSz: 40 })).toMatchObject({
      status: 'none',
      message: 'No liquidity — nothing executed',
    });
    expect(fills).toEqual([]);
  });

  it('cancels all without touching the ledger', async () => {
    const { executor, fills } = harness({});
    expect((await executor.cancelAll()).status).toBe('filled');
    expect(fills).toEqual([]);
  });
});

describe('paperAccountState', () => {
  it('derives balances and positions that build the same account view as live', () => {
    const fills: PaperFill[] = [
      { ts: 1, coin: '#271210', isBuy: true, sz: 40, px: 0.62 },
      { ts: 2, coin: 'ETH', isBuy: true, sz: 0.02, px: 3000 },
      { ts: 3, coin: 'ETH', isBuy: false, sz: 0.01, px: 3100 },
    ];
    const mids = { ETH: '3200', '#271210': '0.7' };
    const state = paperAccountState(fills, { startingUsdc: 1000, mids });
    const view = buildAccountView({
      ...state,
      mids,
      catalogue: new Catalogue(),
      perpMeta: [{ name: 'ETH', index: 4, szDecimals: 4, maxLeverage: 25, onlyIsolated: false }],
      abstraction: 'unifiedAccount',
      now: NOW,
    });
    // 1000 − 24.80 (40 shares) + 1.00 realized on half the ETH.
    expect(view.spotUsdc).toBeCloseTo(976.2, 6);
    expect(view.perps).toHaveLength(1);
    expect(view.perps[0]).toMatchObject({ coin: 'ETH', size: 0.01, entryPx: 3000 });
    expect(view.perps[0]?.upnlUsd).toBeCloseTo(2, 6);
    expect(view.outcomes[0]).toMatchObject({ sideIndex: 0, shares: 40, entryUsd: 24.8 });
  });
});
