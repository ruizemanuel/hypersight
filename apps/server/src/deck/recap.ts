import type { AuditEntry } from '../store/repos';

export type Recap = {
  /** Orders confirmed today (cancel-all is not a trade). */
  trades: number;
  /** Of those, how many filled (fully or in part). */
  filled: number;
  /** Realized PnL from today's fills, net of fees. */
  realizedUsd: number;
  /** The market that made the most today, when one made money. */
  best?: { name: string; pnlUsd: number };
};

/** The subset of a `userFills` entry the recap reads. */
export type RecapFill = { coin?: unknown; closedPnl?: unknown; fee?: unknown; time?: unknown };

const DAY_MS = 86_400_000;
const num = (v: unknown): number => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

/** 00:00 UTC of `now`'s day (the daily limits reset then too). */
export const dayStartUtc = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;

/**
 * Today's session in numbers, from the audit log (orders and their results) and today's fills
 * (realized PnL). Null before the first order or fill of the day.
 */
export function computeRecap(input: {
  entries: AuditEntry[];
  fills: RecapFill[];
  now: number;
  nameOf: (coin: string) => string;
}): Recap | null {
  const start = dayStartUtc(input.now);
  const today = input.entries.filter((e) => e.ts >= start);
  const kindOf = new Map<string, unknown>();
  for (const e of today) {
    if (e.kind !== 'proposal') continue;
    kindOf.set(e.proposalId, (e.data as { intent?: { kind?: unknown } } | null)?.intent?.kind);
  }
  let trades = 0;
  let filled = 0;
  for (const e of today) {
    if (e.kind !== 'result' || kindOf.get(e.proposalId) === 'cancelAll') continue;
    trades++;
    const status = (e.data as { status?: unknown } | null)?.status;
    if (status === 'filled' || status === 'partial') filled++;
  }
  const byCoin = new Map<string, number>();
  let realizedUsd = 0;
  let fillsToday = 0;
  for (const f of input.fills) {
    const t = num(f.time);
    if (t < start || t >= start + DAY_MS || typeof f.coin !== 'string') continue;
    fillsToday++;
    const net = num(f.closedPnl) - num(f.fee);
    realizedUsd += net;
    byCoin.set(f.coin, (byCoin.get(f.coin) ?? 0) + net);
  }
  if (trades === 0 && fillsToday === 0) return null;
  let best: Recap['best'];
  for (const [coin, pnlUsd] of byCoin) {
    if (pnlUsd > 0 && (!best || pnlUsd > best.pnlUsd)) best = { name: input.nameOf(coin), pnlUsd };
  }
  return { trades, filled, realizedUsd, ...(best ? { best } : {}) };
}
