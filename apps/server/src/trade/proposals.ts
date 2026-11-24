import { randomUUID } from 'node:crypto';
import type { Intent, ProposalView } from '@hypersight/protocol';
import { fmtPrice, fmtUsd } from '../deck/format';
import type { AccountView } from '../hl/account';
import { isUnified } from '../hl/account';
import { outcomeAsset, outcomeCoin, type PerpMeta } from '../hl/ids';
import type { Book, Level } from '../hl/market-stream';
import type { Catalogue, OutcomeMarket } from '../hl/outcomes';
import {
  outcomeSellSlippagePrice,
  outcomeShares,
  perpSlippagePrice,
  roundPerpPrice,
  roundPerpSize,
  sizeOutcomeBuy,
} from '../hl/sizing';
import { describeIntent } from '../intent/describe';
import type { Repos } from '../store/repos';
import type { ExecResult, Executor, OrderPlan, PlaceOrder, PlanStep } from './executor';
import { checkRisk } from './risk';

export const PROPOSAL_TTL_MS = 15_000;
const PERP_MIN_USD = 10;
const OUTCOME_TICK = 0.01;
const STOP_LIMIT_OFFSET = 0.1;

export type Proposal = {
  id: string;
  intent: Intent;
  plan: OrderPlan;
  view: ProposalView;
  createdAt: number;
  expiresAt: number;
  marketKey?: string;
  /** The exact outcome the order targets: the stable key may move to the next day's market. */
  outcomeId?: number;
  /** Book price the plan was sized from; a move beyond the slippage cap asks for a new review. */
  refPx: number;
  /** Coin whose book `refPx` came from, and which side of it. */
  refCoin?: string;
  refSide?: 'bid' | 'ask';
  maxDrift?: { kind: 'ratio' | 'abs'; value: number };
  notionalUsd: number;
  reducesExposure: boolean;
  state: 'pending' | 'executing' | 'done' | 'cancelled' | 'expired';
  result?: ExecResult;
};

export type ProposalDeps = {
  stream: { view(): AccountView; book(coin: string): Promise<Book> };
  catalogue: Catalogue;
  repos: Repos;
  executor: Executor;
  perpMeta: PerpMeta[];
  network: string;
  now: () => number;
  newId?: () => string;
};

type Draft = Omit<Proposal, 'id' | 'createdAt' | 'expiresAt' | 'state' | 'view'> & {
  title: string;
  lines: string[];
  coin?: string;
  leverage?: number;
};

const blocked = (reason: string) => ({ blocked: reason });
const pct = (f: number) => `${Math.round(f * 100)}%`;
/** Whole dollars read as `$40`, others as `$24.80`. */
const usd = (n: number) => (Number.isInteger(n) ? `$${n.toLocaleString('en-US')}` : fmtUsd(n));
const sideLabel = (side: string) => (/^(yes|no)$/i.test(side) ? side.toUpperCase() : side);

/** Sum of book sizes priced within `limit` (asks ≤ limit for buys, bids ≥ limit for sells). */
function depthWithin(levels: Level[], limit: number, isBuy: boolean): number {
  let total = 0;
  for (const l of levels) {
    if (isBuy ? l.px > limit : l.px < limit) break;
    total += l.sz;
  }
  return total;
}

/** Keeps confirm cards within 3 lines by merging the overflow into the last line. */
function fitLines(lines: string[]): string[] {
  if (lines.length <= 3) return lines;
  return [lines[0] as string, lines[1] as string, lines.slice(2).join(' · ')];
}

/**
 * Turns an intent into a sized, risk-checked order plan with a human confirm card, and executes
 * it exactly once on confirm (expiry, market-closed and price-drift checks first).
 */
export class ProposalService {
  private readonly proposals = new Map<string, Proposal>();
  private readonly pending = new Map<string, Promise<ExecResult>>();
  private lastWriteAt: number | null = null;

  constructor(private readonly deps: ProposalDeps) {}

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  async propose(intent: Intent): Promise<Proposal | { blocked: string }> {
    const now = this.deps.now();
    let draft: Draft | { blocked: string };
    try {
      draft = await this.draft(intent);
    } catch (err) {
      draft = blocked(
        `Could not prepare: ${err instanceof Error ? err.message : 'error'}`.slice(0, 60),
      );
    }
    if ('blocked' in draft) {
      if (draft.blocked !== 'Not an order')
        this.audit('blocked', '-', `${describeIntent(intent)}: ${draft.blocked}`, { intent });
      return draft;
    }
    const settings = this.deps.repos.settings.get();
    const risk = checkRisk(
      {
        network: this.deps.network,
        ...(draft.coin !== undefined ? { coin: draft.coin } : {}),
        ...(draft.leverage !== undefined ? { leverage: draft.leverage } : {}),
        notionalUsd: draft.notionalUsd,
        reducesExposure: draft.reducesExposure,
      },
      settings.risk,
      { dailyUsedUsd: this.deps.repos.usage.today(now), lastWriteAt: null, now },
    );
    if (!risk.ok) {
      this.audit('blocked', '-', `${describeIntent(intent)}: ${risk.reason}`, { intent });
      return blocked(risk.reason);
    }
    const id = this.deps.newId?.() ?? randomUUID();
    const expiresAt = now + PROPOSAL_TTL_MS;
    const { title, lines, coin: _coin, leverage: _leverage, ...rest } = draft;
    const proposal: Proposal = {
      ...rest,
      id,
      createdAt: now,
      expiresAt,
      state: 'pending',
      view: { id, title, lines: fitLines(lines), expiresAt },
    };
    this.proposals.set(id, proposal);
    this.audit('proposal', id, `${title} · ${proposal.view.lines.join(' · ')}`, {
      intent,
      plan: proposal.plan,
    });
    return proposal;
  }

  cancel(id: string): void {
    const p = this.proposals.get(id);
    if (p?.state !== 'pending') return;
    p.state = 'cancelled';
    this.audit('cancel', id, p.view.title, null);
  }

  confirm(id: string): Promise<ExecResult> {
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;
    const p = this.proposals.get(id);
    if (!p) return Promise.resolve({ status: 'none', message: 'Expired — nothing sent' });
    if (p.result) return Promise.resolve(p.result);
    if (p.state === 'cancelled')
      return Promise.resolve({ status: 'none', message: 'Cancelled — nothing sent' });
    const run = this.execute(p).finally(() => this.pending.delete(id));
    this.pending.set(id, run);
    return run;
  }

  private async execute(p: Proposal): Promise<ExecResult> {
    const now = this.deps.now();
    if (p.state === 'expired' || now > p.expiresAt) {
      p.state = 'expired';
      return { status: 'none', message: 'Expired — nothing sent' };
    }
    if (p.outcomeId !== undefined) {
      const market = this.deps.catalogue.byOutcome(p.outcomeId);
      if (!market || (market.expiresAt !== undefined && market.expiresAt <= now)) {
        p.state = 'expired';
        return { status: 'none', message: 'Market closed — nothing sent' };
      }
    }
    p.state = 'executing';
    try {
      if (await this.drifted(p)) {
        p.state = 'expired';
        return { status: 'none', message: 'Price moved — review again' };
      }
      const settings = this.deps.repos.settings.get();
      const risk = checkRisk(
        {
          network: this.deps.network,
          notionalUsd: p.notionalUsd,
          reducesExposure: p.reducesExposure,
        },
        settings.risk,
        { dailyUsedUsd: this.deps.repos.usage.today(now), lastWriteAt: this.lastWriteAt, now },
      );
      if (!risk.ok) {
        p.state = 'pending';
        return { status: 'none', message: risk.reason };
      }
      this.audit('confirm', p.id, p.view.title, null);
      this.lastWriteAt = now;
      let result: ExecResult;
      try {
        result =
          p.intent.kind === 'cancelAll'
            ? await this.deps.executor.cancelAll()
            : await this.deps.executor.execute(p.plan);
      } catch (err) {
        result = {
          status: 'error',
          message:
            `Execution failed: ${err instanceof Error ? err.message : 'unknown error'}`.slice(
              0,
              80,
            ),
        };
      }
      // The order went out: record the result first so nothing below can make it confirmable again.
      p.result = result;
      p.state = 'done';
      if (!p.reducesExposure && (result.status === 'filled' || result.status === 'partial')) {
        const filled = (result.filledSz ?? 0) * (result.avgPx ?? 0);
        try {
          this.deps.repos.usage.addNotional(filled > 0 ? filled : p.notionalUsd, this.deps.now());
        } catch {
          // bookkeeping must never turn a placed order back into a pending one
        }
      }
      this.audit('result', p.id, result.message, result);
      return result;
    } catch (err) {
      p.state = 'pending';
      throw err;
    }
  }

  /** True when the best price moved past the slippage cap since the proposal was sized. */
  private async drifted(p: Proposal): Promise<boolean> {
    if (!p.refCoin || !p.refSide || !p.maxDrift || p.refPx <= 0) return false;
    const book = await this.deps.stream.book(p.refCoin);
    const best = (p.refSide === 'bid' ? book.bids : book.asks)[0];
    if (!best) return true;
    const move = Math.abs(best.px - p.refPx);
    return p.maxDrift.kind === 'ratio'
      ? move / p.refPx > p.maxDrift.value
      : move > p.maxDrift.value + 1e-9;
  }

  private audit(
    kind: 'proposal' | 'confirm' | 'cancel' | 'result' | 'blocked',
    id: string,
    summary: string,
    data: unknown,
  ): void {
    try {
      this.deps.repos.audit.append({ ts: this.deps.now(), kind, proposalId: id, summary, data });
    } catch {
      // auditing must never block trading decisions
    }
  }

  private async draft(intent: Intent): Promise<Draft | { blocked: string }> {
    switch (intent.kind) {
      case 'closePerp':
        return this.draftClose(intent.coin, intent.fraction);
      case 'openPerp':
        return this.draftOpen(intent.coin, intent.side, intent.usd, intent.leverage);
      case 'buyOutcome':
        return this.draftBuyOutcome(intent.marketKey, intent.sideIndex, intent.usd);
      case 'sellOutcome':
        return this.draftSellOutcome(intent.marketKey, intent.sideIndex, intent.fraction);
      case 'setStop':
        return this.draftStop(intent.coin, intent.triggerPx);
      case 'cancelAll':
        return {
          intent,
          plan: { steps: [], requestedSz: 0 },
          title: 'CANCEL ALL ORDERS',
          lines: ['Every open order on this account'],
          refPx: 0,
          notionalUsd: 0,
          reducesExposure: true,
        };
      default:
        return blocked('Not an order');
    }
  }

  private meta(coin: string): PerpMeta | undefined {
    return this.deps.perpMeta.find((m) => m.name === coin);
  }

  private async draftClose(coin: string, fraction: number): Promise<Draft | { blocked: string }> {
    const view = this.deps.stream.view();
    const pos = view.perps.find((p) => p.coin === coin);
    const meta = this.meta(coin);
    if (!pos || pos.size === 0) return blocked(`No ${coin} position`);
    if (!meta) return blocked(`${coin} not available`);
    const isBuy = pos.size < 0;
    const abs = Math.abs(pos.size);
    let sz = Number(roundPerpSize(abs * fraction, meta.szDecimals, 'down'));
    if (sz <= 0) return blocked('Size too small');
    const book = await this.deps.stream.book(coin);
    const best = (isBuy ? book.asks : book.bids)[0];
    if (!best) return blocked(isBuy ? 'No sellers right now' : 'No buyers right now');
    const slip = this.deps.repos.settings.get().risk.perpSlippage;
    const px = perpSlippagePrice(best.px, isBuy, slip, meta.szDecimals);
    const lines: string[] = [];
    const available = depthWithin(isBuy ? book.asks : book.bids, Number(px), isBuy);
    let shown = fraction;
    if (available < sz) {
      sz = Number(roundPerpSize(available, meta.szDecimals, 'down'));
      if (sz <= 0) return blocked(isBuy ? 'No sellers right now' : 'No buyers right now');
      lines.push(`only ${sz} ${coin} within ${px}`);
      shown = sz / abs;
    }
    const szStr = roundPerpSize(sz, meta.szDecimals, 'down');
    const notional = sz * best.px;
    const realized = (best.px - pos.entryPx) * sz * (pos.size > 0 ? 1 : -1);
    const order: PlaceOrder = {
      kind: 'order',
      asset: meta.index,
      coin,
      isBuy,
      px,
      sz: szStr,
      reduceOnly: true,
      tif: 'Ioc',
    };
    return {
      intent: { kind: 'closePerp', coin, fraction },
      plan: { steps: [order], requestedSz: sz },
      title: `CLOSE ${pct(shown)} ${coin} ${pos.size > 0 ? 'LONG' : 'SHORT'}`,
      lines: [
        `${szStr} ${coin} ≈ ${fmtUsd(notional)} @ ~${fmtPrice(best.px)}`,
        `${fmtUsd(realized, { sign: true })} realized`,
        ...lines,
      ],
      refPx: best.px,
      refCoin: coin,
      refSide: isBuy ? 'ask' : 'bid',
      maxDrift: { kind: 'ratio', value: slip },
      notionalUsd: notional,
      reducesExposure: true,
      coin,
    };
  }

  private async draftOpen(
    coin: string,
    side: 'long' | 'short',
    usdAmount: number,
    leverageIn: number | undefined,
  ): Promise<Draft | { blocked: string }> {
    const meta = this.meta(coin);
    if (!meta) return blocked(`${coin} not available`);
    const settings = this.deps.repos.settings.get();
    const leverage = Math.min(leverageIn ?? settings.presets.defaultLeverage, meta.maxLeverage);
    const isBuy = side === 'long';
    const book = await this.deps.stream.book(coin);
    const best = (isBuy ? book.asks : book.bids)[0];
    if (!best) return blocked(isBuy ? 'No sellers right now' : 'No buyers right now');
    const slip = settings.risk.perpSlippage;
    const px = perpSlippagePrice(best.px, isBuy, slip, meta.szDecimals);
    let sz = Number(roundPerpSize(usdAmount / best.px, meta.szDecimals, 'down'));
    const lines: string[] = [];
    const available = depthWithin(isBuy ? book.asks : book.bids, Number(px), isBuy);
    if (available < sz) {
      sz = Number(roundPerpSize(available, meta.szDecimals, 'down'));
      lines.push(`only ${sz} ${coin} within ${px}`);
    }
    const notional = sz * best.px;
    if (notional < PERP_MIN_USD) return blocked(`Minimum $${PERP_MIN_USD}`);
    const isCross = !meta.onlyIsolated;
    const szStr = roundPerpSize(sz, meta.szDecimals, 'down');
    const steps: PlanStep[] = [
      { kind: 'leverage', asset: meta.index, leverage, isCross },
      {
        kind: 'order',
        asset: meta.index,
        coin,
        isBuy,
        px,
        sz: szStr,
        reduceOnly: false,
        tif: 'Ioc',
      },
    ];
    return {
      intent: {
        kind: 'openPerp',
        coin,
        side,
        usd: usdAmount,
        ...(leverageIn ? { leverage: leverageIn } : {}),
      },
      plan: { steps, requestedSz: sz },
      title: `${side.toUpperCase()} ${coin} ${fmtUsd(notional)}`,
      lines: [
        `${szStr} ${coin} @ ~${fmtPrice(best.px)}`,
        `${leverage}× ${isCross ? 'cross' : 'isolated'}`,
        ...lines,
      ],
      refPx: best.px,
      refCoin: coin,
      refSide: isBuy ? 'ask' : 'bid',
      maxDrift: { kind: 'ratio', value: slip },
      notionalUsd: notional,
      reducesExposure: false,
      coin,
      leverage,
    };
  }

  private async draftBuyOutcome(
    marketKey: string,
    sideIndex: 0 | 1,
    usdAmount: number,
  ): Promise<Draft | { blocked: string }> {
    const market = this.deps.catalogue.byKey(marketKey);
    const now = this.deps.now();
    if (!market) return blocked('Market not found');
    if (market.expiresAt !== undefined && market.expiresAt <= now) return blocked('Market closed');
    const coin = outcomeCoin(market.outcome, sideIndex);
    const book = await this.deps.stream.book(coin);
    const best = book.asks[0];
    if (!best) return blocked('No sellers right now');
    const ticks = this.deps.repos.settings.get().risk.outcomeSlippageTicks;
    if (outcomeShares(usdAmount, best.px) === 0) return blocked('Minimum $1');
    // The worst case (shares × limit) never exceeds the amount said, and risk checks that.
    const size = sizeOutcomeBuy(book.asks, usdAmount, ticks);
    if (!size || size.estimate < 1) return blocked('No sellers right now');
    const { shares, worst } = size;
    const px = String(size.limit);
    const extra: string[] = [];
    if (size.depthLimited) extra.push(`only ${shares} shares ≤ ${px}`);
    const cost = worst;
    const view = this.deps.stream.view();
    const steps: PlanStep[] = [];
    if (view.spotUsdc < cost) {
      const shortfall = Math.ceil(cost - view.spotUsdc);
      if (isUnified(view.abstraction) || view.perpWithdrawableUsd < shortfall)
        return blocked('Not enough USDC');
      steps.push({ kind: 'perpToSpot', usd: String(shortfall) });
      extra.push(`moves $${shortfall} perp → spot`);
    }
    steps.push({
      kind: 'order',
      asset: outcomeAsset(market.outcome, sideIndex),
      coin,
      isBuy: true,
      px,
      sz: String(shares),
      reduceOnly: false,
      tif: 'Ioc',
    });
    const side = sideLabel(market.sides[sideIndex]);
    return {
      intent: { kind: 'buyOutcome', marketKey, sideIndex, usd: usdAmount },
      plan: { steps, requestedSz: shares },
      title: `BUY ${side} · ${market.short}`,
      lines: [
        `${shares} shares @ ~${fmtPrice(size.estimate / shares)} = ${fmtUsd(size.estimate)}`,
        `pays ${usd(shares)} if ${side}${worst - size.estimate >= 0.005 ? ` · max ${fmtUsd(worst)}` : ''}`,
        ...extra,
      ],
      marketKey,
      outcomeId: market.outcome,
      refPx: best.px,
      refCoin: coin,
      refSide: 'ask',
      maxDrift: { kind: 'abs', value: ticks * OUTCOME_TICK },
      notionalUsd: cost,
      reducesExposure: false,
    };
  }

  private async draftSellOutcome(
    marketKey: string,
    sideIndex: 0 | 1,
    fraction: number,
  ): Promise<Draft | { blocked: string }> {
    const view = this.deps.stream.view();
    const pos = view.outcomes.find((o) => o.market.key === marketKey && o.sideIndex === sideIndex);
    if (!pos) return blocked('No position in that market');
    const market: OutcomeMarket = this.deps.catalogue.byOutcome(pos.market.outcome) ?? pos.market;
    const now = this.deps.now();
    if (market.expiresAt !== undefined && market.expiresAt <= now) return blocked('Market closed');
    let shares = Math.floor(pos.shares * fraction + 1e-9);
    if (shares < 1) return blocked('Less than one share');
    const coin = outcomeCoin(market.outcome, sideIndex);
    const book = await this.deps.stream.book(coin);
    const best = book.bids[0];
    if (!best) return blocked('No buyers right now');
    const ticks = this.deps.repos.settings.get().risk.outcomeSlippageTicks;
    const px = outcomeSellSlippagePrice(best.px, ticks);
    const extra: string[] = [];
    const available = Math.floor(depthWithin(book.bids, Number(px), false));
    if (available < shares) {
      shares = available;
      if (shares === 0) return blocked('No buyers right now');
      extra.push(`only ${shares} shares ≥ ${px}`);
    }
    const proceeds = shares * best.px;
    const side = sideLabel(market.sides[sideIndex]);
    return {
      intent: { kind: 'sellOutcome', marketKey, sideIndex, fraction },
      plan: {
        steps: [
          {
            kind: 'order',
            asset: outcomeAsset(market.outcome, sideIndex),
            coin,
            isBuy: false,
            px,
            sz: String(shares),
            reduceOnly: false,
            tif: 'Ioc',
          },
        ],
        requestedSz: shares,
      },
      title: `SELL ${side} · ${market.short}`,
      lines: [
        `${shares} of ${pos.shares} shares @ ~${fmtPrice(best.px)} ≈ ${fmtUsd(proceeds)}`,
        ...extra,
      ],
      marketKey,
      outcomeId: market.outcome,
      refPx: best.px,
      refCoin: coin,
      refSide: 'bid',
      maxDrift: { kind: 'abs', value: ticks * OUTCOME_TICK },
      notionalUsd: proceeds,
      reducesExposure: true,
    };
  }

  private async draftStop(coin: string, triggerPx: number): Promise<Draft | { blocked: string }> {
    const view = this.deps.stream.view();
    const pos = view.perps.find((p) => p.coin === coin);
    const meta = this.meta(coin);
    if (!pos || pos.size === 0) return blocked(`No ${coin} position`);
    if (!meta) return blocked(`${coin} not available`);
    const isLong = pos.size > 0;
    if (isLong && triggerPx >= pos.markPx) return blocked('Stop must be below mark for a long');
    if (!isLong && triggerPx <= pos.markPx) return blocked('Stop must be above mark for a short');
    const sz = roundPerpSize(Math.abs(pos.size), meta.szDecimals, 'down');
    const trigger = roundPerpPrice(triggerPx, meta.szDecimals);
    const limit = roundPerpPrice(
      triggerPx * (isLong ? 1 - STOP_LIMIT_OFFSET : 1 + STOP_LIMIT_OFFSET),
      meta.szDecimals,
    );
    return {
      intent: { kind: 'setStop', coin, triggerPx },
      plan: {
        steps: [
          {
            kind: 'trigger',
            asset: meta.index,
            coin,
            isBuy: !isLong,
            sz,
            triggerPx: trigger,
            px: limit,
            tpsl: 'sl',
          },
        ],
        requestedSz: Math.abs(pos.size),
      },
      title: `STOP ${coin} ${isLong ? 'LONG' : 'SHORT'} AT ${fmtPrice(triggerPx)}`,
      lines: [
        `${sz} ${coin} · mark ${fmtPrice(pos.markPx)}`,
        `market ${isLong ? 'sell' : 'buy'} if ${isLong ? '≤' : '≥'} ${fmtPrice(triggerPx)}`,
      ],
      refPx: 0,
      notionalUsd: Math.abs(pos.size) * pos.markPx,
      reducesExposure: true,
      coin,
    };
  }
}
