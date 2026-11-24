import { outcomeCoin, type PerpMeta, parseBalanceCoin } from './ids';
import type { Catalogue, OutcomeMarket } from './outcomes';

/** Structural subset of `clearinghouseState` (perps). */
export type ClearinghouseLike = {
  marginSummary: { accountValue: string; totalMarginUsed?: string };
  crossMarginSummary: { accountValue: string };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      leverage: { type: string; value: number };
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      returnOnEquity: string;
      liquidationPx: string | null;
    };
  }[];
};

/** Structural subset of `spotClearinghouseState`. Outcome rows (`+enc`) carry no `token`. */
export type SpotLike = {
  balances: { coin: string; token?: number; total: string; hold: string; entryNtl: string }[];
};

export type PerpPosition = {
  coin: string;
  /** Signed: positive long, negative short. */
  size: number;
  entryPx: number;
  markPx: number;
  upnlUsd: number;
  roe: number;
  leverage: number;
  isCross: boolean;
  liqPx: number | null;
  szDecimals: number;
};

export type OutcomePosition = {
  market: OutcomeMarket;
  sideIndex: 0 | 1;
  shares: number;
  entryUsd: number;
  mid: number;
  valueUsd: number;
  upnlUsd: number;
  /** Each winning share pays $1. */
  maxPayoutUsd: number;
};

export type AccountView = {
  equityUsd: number;
  perpUpnlUsd: number;
  /** Cross maintenance margin / account value; liquidation at ≥ 1 (risk, for alerts). */
  marginRatio: number;
  /** Margin committed to positions / account value (what the account card shows). */
  marginUsage: number;
  perpWithdrawableUsd: number;
  spotUsdc: number;
  perps: PerpPosition[];
  outcomes: OutcomePosition[];
  /** `userAbstraction` mode: `unifiedAccount` | `portfolioMargin` | `default` | `disabled` | `dexAbstraction`. */
  abstraction: string;
  updatedAt: number;
};

export type AccountInput = {
  clearinghouse: ClearinghouseLike;
  spot: SpotLike;
  mids: Record<string, string>;
  catalogue: Catalogue;
  perpMeta: PerpMeta[];
  abstraction: string;
  now: number;
};

const num = (s: string | null | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** Spot USDC is the balance source of truth in these modes; per-dex perp balances are not meaningful. */
export function isUnified(abstraction: string): boolean {
  return abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin';
}

function placeholderMarket(outcome: number): OutcomeMarket {
  return {
    key: `o:${outcome}`,
    outcome,
    title: `Outcome ${outcome}`,
    short: `Outcome ${outcome}`,
    sides: ['Yes', 'No'],
  };
}

export function buildAccountView(input: AccountInput): AccountView {
  const { clearinghouse: ch, spot, mids, catalogue, perpMeta, abstraction, now } = input;
  const decimals = new Map(perpMeta.map((p) => [p.name, p.szDecimals]));

  const perps: PerpPosition[] = [];
  for (const { position: p } of ch.assetPositions) {
    const size = num(p.szi);
    if (size === 0) continue;
    const mid = mids[p.coin];
    perps.push({
      coin: p.coin,
      size,
      entryPx: num(p.entryPx),
      markPx: mid !== undefined ? num(mid) : num(p.positionValue) / Math.abs(size),
      upnlUsd: num(p.unrealizedPnl),
      roe: num(p.returnOnEquity),
      leverage: p.leverage.value,
      isCross: p.leverage.type === 'cross',
      liqPx: p.liquidationPx === null ? null : num(p.liquidationPx),
      szDecimals: decimals.get(p.coin) ?? 0,
    });
  }

  let spotUsdc = 0;
  const outcomes: OutcomePosition[] = [];
  for (const b of spot.balances) {
    if (b.coin === 'USDC') {
      spotUsdc = num(b.total);
      continue;
    }
    const id = parseBalanceCoin(b.coin);
    const shares = num(b.total);
    if (!id || shares === 0) continue;
    const entryUsd = num(b.entryNtl);
    const midRaw = mids[outcomeCoin(id.outcome, id.side)];
    // Without a mid, value at cost so the card shows the position rather than a fake loss.
    const mid = midRaw !== undefined ? num(midRaw) : shares > 0 ? entryUsd / shares : 0;
    const valueUsd = shares * mid;
    outcomes.push({
      market: catalogue.byOutcome(id.outcome) ?? placeholderMarket(id.outcome),
      sideIndex: id.side,
      shares,
      entryUsd,
      mid,
      valueUsd,
      upnlUsd: valueUsd - entryUsd,
      maxPayoutUsd: shares,
    });
  }

  const perpUpnlUsd = perps.reduce((s, p) => s + p.upnlUsd, 0);
  const outcomeValue = outcomes.reduce((s, o) => s + o.valueUsd, 0);
  const unified = isUnified(abstraction);
  const equityUsd = unified
    ? spotUsdc + perpUpnlUsd + outcomeValue
    : num(ch.marginSummary.accountValue) + spotUsdc + outcomeValue;

  const maintenance = num(ch.crossMaintenanceMarginUsed);
  const base = unified ? spotUsdc + perpUpnlUsd : num(ch.crossMarginSummary.accountValue);
  const marginRatio = maintenance === 0 ? 0 : base > 0 ? maintenance / base : 1;
  const used = num(ch.marginSummary.totalMarginUsed);
  const usageBase = unified ? spotUsdc + perpUpnlUsd : num(ch.marginSummary.accountValue);
  const marginUsage = used === 0 ? 0 : usageBase > 0 ? used / usageBase : 1;

  return {
    equityUsd,
    perpUpnlUsd,
    marginRatio,
    marginUsage,
    perpWithdrawableUsd: num(ch.withdrawable),
    spotUsdc,
    perps,
    outcomes,
    abstraction,
    updatedAt: now,
  };
}
