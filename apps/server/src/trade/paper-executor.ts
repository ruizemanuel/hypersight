import type { ClearinghouseLike, SpotLike } from '../hl/account';
import type { Book } from '../hl/market-stream';
import type { PaperFill } from '../store/repos';
import type { ExecResult, Executor, OrderPlan, PlaceOrder } from './executor';

export type PaperExecutorDeps = {
  book: (coin: string) => Promise<Book>;
  ledger: { append(f: PaperFill): void };
  now: () => number;
};

const fmt = (n: number): string => String(Number(n.toPrecision(12)));

/**
 * Paper trading on live order books (fallback if testnet funding fails): an order fills in
 * full at the best opposite price when that price is within its limit, else nothing executes.
 * Transfers and leverage are no-ops; stops are acknowledged but not simulated.
 */
export class PaperExecutor implements Executor {
  constructor(private readonly deps: PaperExecutorDeps) {}

  async execute(plan: OrderPlan): Promise<ExecResult> {
    let last: ExecResult = { status: 'none', message: 'Nothing to do' };
    for (const step of plan.steps) {
      if (step.kind === 'order') {
        last = await this.fill(step, plan.requestedSz);
        if (last.status !== 'filled') return last;
      } else if (step.kind === 'trigger') {
        last = { status: 'resting', requestedSz: plan.requestedSz, message: 'Stop set (paper)' };
      }
    }
    return last;
  }

  async cancelAll(): Promise<ExecResult> {
    return { status: 'filled', message: 'No open orders' };
  }

  private async fill(o: PlaceOrder, requestedSz: number): Promise<ExecResult> {
    const book = await this.deps.book(o.coin);
    const best = o.isBuy ? book.asks[0] : book.bids[0];
    const limit = Number(o.px);
    const withinLimit = best !== undefined && (o.isBuy ? best.px <= limit : best.px >= limit);
    if (!best || !withinLimit) {
      return { status: 'none', requestedSz, message: 'No liquidity — nothing executed' };
    }
    const sz = Number(o.sz);
    this.deps.ledger.append({ ts: this.deps.now(), coin: o.coin, isBuy: o.isBuy, sz, px: best.px });
    return {
      status: 'filled',
      filledSz: sz,
      requestedSz,
      avgPx: best.px,
      message: `Filled ${fmt(sz)} @ ${fmt(best.px)}`,
    };
  }
}

type Holding = { size: number; entryPx: number };

/**
 * Paper balances as the same raw shapes Hyperliquid returns, so `buildAccountView` renders the
 * paper account exactly like the live one (unified-account semantics: USDC sits in spot).
 */
export function paperAccountState(
  fills: PaperFill[],
  opts: { startingUsdc: number; mids: Record<string, string> },
): { clearinghouse: ClearinghouseLike; spot: SpotLike } {
  let usdc = opts.startingUsdc;
  const perps = new Map<string, Holding>();
  const outcomes = new Map<string, { shares: number; cost: number }>();

  for (const f of fills) {
    if (f.coin.startsWith('#')) {
      const h = outcomes.get(f.coin) ?? { shares: 0, cost: 0 };
      if (f.isBuy) {
        h.shares += f.sz;
        h.cost += f.sz * f.px;
        usdc -= f.sz * f.px;
      } else {
        const sold = Math.min(f.sz, h.shares);
        h.cost -= h.shares > 0 ? (h.cost * sold) / h.shares : 0;
        h.shares -= sold;
        usdc += sold * f.px;
      }
      outcomes.set(f.coin, h);
      continue;
    }
    // Perps: weighted entry on increases, realized PnL to USDC on reductions.
    const h = perps.get(f.coin) ?? { size: 0, entryPx: 0 };
    const delta = f.isBuy ? f.sz : -f.sz;
    if (h.size === 0 || Math.sign(h.size) === Math.sign(delta)) {
      const size = h.size + delta;
      h.entryPx = (Math.abs(h.size) * h.entryPx + Math.abs(delta) * f.px) / Math.abs(size);
      h.size = size;
    } else {
      const closed = Math.min(Math.abs(delta), Math.abs(h.size));
      usdc += closed * (f.px - h.entryPx) * Math.sign(h.size);
      const rest = Math.abs(delta) - closed;
      h.size += Math.sign(delta) * closed;
      if (rest > 0) {
        h.size = Math.sign(delta) * rest;
        h.entryPx = f.px;
      }
    }
    perps.set(f.coin, h);
  }

  let upnl = 0;
  const assetPositions: ClearinghouseLike['assetPositions'] = [];
  for (const [coin, h] of perps) {
    if (Math.abs(h.size) < 1e-12) continue;
    const mark = Number(opts.mids[coin] ?? h.entryPx);
    const pnl = h.size * (mark - h.entryPx);
    upnl += pnl;
    const value = Math.abs(h.size) * mark;
    assetPositions.push({
      position: {
        coin,
        szi: fmt(h.size),
        leverage: { type: 'cross', value: 1 },
        entryPx: fmt(h.entryPx),
        positionValue: fmt(value),
        unrealizedPnl: fmt(pnl),
        returnOnEquity: fmt(value > 0 ? pnl / (Math.abs(h.size) * h.entryPx) : 0),
        liquidationPx: null,
      },
    });
  }

  const balances: SpotLike['balances'] = [
    { coin: 'USDC', token: 0, total: fmt(usdc), hold: '0', entryNtl: '0' },
  ];
  for (const [coin, h] of outcomes) {
    if (h.shares <= 0) continue;
    balances.push({
      coin: `+${coin.slice(1)}`,
      total: fmt(h.shares),
      hold: '0',
      entryNtl: fmt(h.cost),
    });
  }

  const accountValue = fmt(usdc + upnl);
  return {
    clearinghouse: {
      marginSummary: { accountValue, totalMarginUsed: '0' },
      crossMarginSummary: { accountValue },
      crossMaintenanceMarginUsed: '0',
      withdrawable: fmt(usdc),
      assetPositions,
    },
    spot: { balances },
  };
}
