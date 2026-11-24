/** Hyperliquid order rounding rules (HL §4.2, outcome rules from the spike results). */

/** Absorbs binary float error (0.3 × 10 = 2.9999999999999996) before rounding down. */
const EPS = 1e-9;
const PERP_MAX_DECIMALS = 6;
const OUTCOME_TICK = 0.01;
const OUTCOME_MIN_PX = 0.00001;
const OUTCOME_MAX_PX = 0.99999;
const OUTCOME_DECIMALS = 5;
const OUTCOME_MIN_ORDER_USD = 1;

/** Fixed-point string without trailing zeros (never scientific notation). */
function plain(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** At most `szDecimals` decimals; closes round down so they never exceed the position. */
export function roundPerpSize(sz: number, szDecimals: number, mode: 'down' | 'nearest'): string {
  const f = 10 ** szDecimals;
  const units = mode === 'down' ? Math.floor(sz * f + EPS) : Math.round(sz * f);
  return plain(units / f, szDecimals);
}

/** At most 5 significant figures and at most `6 − szDecimals` decimals; integers always valid. */
export function roundPerpPrice(px: number, szDecimals: number): string {
  if (Math.abs(px) >= 100_000) return String(Math.round(px));
  const maxDecimals = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  const sig = Number(px.toPrecision(5));
  return plain(sig, maxDecimals);
}

/** Aggressive IOC limit: reference ± slippage, rounded to a valid price. */
export function perpSlippagePrice(
  ref: number,
  isBuy: boolean,
  slip: number,
  szDecimals: number,
): string {
  return roundPerpPrice(ref * (isBuy ? 1 + slip : 1 - slip), szDecimals);
}

/** Whole shares only; 0 when the order would be under the 1 USDC minimum. */
export function outcomeShares(usd: number, price: number): number {
  if (!(price > 0) || !(usd > 0)) return 0;
  const shares = Math.floor(usd / price + EPS);
  return shares * price + EPS < OUTCOME_MIN_ORDER_USD ? 0 : shares;
}

/** Clamped to [0.00001, 0.99999], at most 5 decimals and 5 significant figures. */
export function roundOutcomePrice(p: number): string {
  const clamped = Math.min(OUTCOME_MAX_PX, Math.max(OUTCOME_MIN_PX, p));
  const sig = Number(clamped.toPrecision(5));
  const rounded = Math.min(
    OUTCOME_MAX_PX,
    Math.max(OUTCOME_MIN_PX, Number(sig.toFixed(OUTCOME_DECIMALS))),
  );
  return plain(rounded, OUTCOME_DECIMALS);
}

/** Buy limit: best ask + ticks × 0.01, capped below 1. */
export function outcomeSlippagePrice(bestAsk: number, ticks: number): string {
  return roundOutcomePrice(Math.min(bestAsk + ticks * OUTCOME_TICK, OUTCOME_MAX_PX));
}

export type OutcomeBuySize = {
  shares: number;
  /** IOC limit price: the worst price any share can fill at. */
  limit: number;
  /** Expected cost walking the book as it is now. */
  estimate: number;
  /** shares × limit — never more than the amount the user said. */
  worst: number;
  /** True when the book (not the amount) capped the size. */
  depthLimited: boolean;
};

/**
 * Most shares the amount buys walking the asks, with a limit price chosen so the worst case
 * (shares × limit) never exceeds the amount: money left over after the expected fill becomes
 * slippage room, capped at `ticks` × 0.01 (or 10% of a cheap price) above the deepest level used.
 */
export function sizeOutcomeBuy(
  asks: { px: number; sz: number }[],
  usd: number,
  ticks: number,
): OutcomeBuySize | null {
  const best = asks[0];
  if (!best || !(usd > 0)) return null;
  const maxPx = Math.min(best.px + ticks * OUTCOME_TICK, OUTCOME_MAX_PX);
  let pick: { shares: number; limit: number; depthLimited: boolean } | null = null;
  let depth = 0;
  for (const level of asks) {
    if (level.px > maxPx + EPS) break;
    depth += level.sz;
    const affordable = Math.floor(usd / level.px + EPS);
    const shares = Math.min(affordable, Math.floor(depth + EPS));
    if (shares <= 0 || (pick && shares <= pick.shares)) continue;
    const slip = Math.min(ticks * OUTCOME_TICK, Math.max(OUTCOME_TICK, level.px * 0.1));
    const room = Math.floor((usd / shares) * 100_000) / 100_000;
    const limit = Number(roundOutcomePrice(Math.min(level.px + slip, room, maxPx)));
    pick = { shares, limit: Math.max(limit, level.px), depthLimited: shares < affordable };
  }
  if (!pick) return null;
  let left = pick.shares;
  let estimate = 0;
  for (const level of asks) {
    const take = Math.min(left, level.sz);
    estimate += take * level.px;
    left -= take;
    if (left <= 0) break;
  }
  return { ...pick, estimate, worst: pick.shares * pick.limit };
}

/** Sell limit: best bid − ticks × 0.01, floored above 0. */
export function outcomeSellSlippagePrice(bestBid: number, ticks: number): string {
  return roundOutcomePrice(Math.max(bestBid - ticks * OUTCOME_TICK, OUTCOME_MIN_PX));
}
