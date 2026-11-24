import type { ExecResult } from '../trade/executor';

/**
 * Hyperliquid error strings → short HUD copy. Matched by prefix after dropping the SDK's
 * `order 0: ` batch prefix and the exchange's trailing ` asset=<n>` (research §11.4 + spike).
 */
const HUMAN: [prefix: string, text: string][] = [
  ['Order could not immediately match', 'No liquidity — nothing executed'],
  ['No liquidity available for market order', 'No liquidity — nothing executed'],
  ['Order has insufficient spot balance', 'Not enough USDC'],
  ['Order must have minimum value of $10', 'Below $10 minimum'],
  ['Order must have minimum value of 1 USDC', 'Below $1 minimum'],
  ['Order has invalid size', 'Whole shares only'],
  ['Price must be divisible by tick size', 'Price precision error'],
  ['Action already expired', 'Expired — nothing sent'],
  ['Insufficient margin to place order', 'Not enough margin'],
  ['Reduce only order would increase position', 'Position changed — nothing executed'],
  ['Invalid TP/SL price', 'Stop price is on the wrong side'],
  ['Order price too far from oracle', 'Price too far from oracle'],
  ['Order would cause position to exceed margin tier limit', 'Above the margin tier limit'],
  ['Order was never placed, already canceled, or filled', 'Order already gone'],
  ['Must deposit before performing actions', 'Account not funded'],
  ['L1 error: User or API Wallet', 'Agent wallet not authorized'],
];

const UNKNOWN_MAX = 60;

function rawMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Short human text for any exchange error (per-order string, thrown error or SDK error). */
export function humanizeHlError(e: unknown): string {
  // The SDK joins batch errors as "order 0: X, order 1: Y": the first one is enough.
  const first = rawMessage(e).split(/, (?=\w+ \d+: )/)[0] ?? '';
  const msg = first
    .replace(/^\w+ \d+: /, '')
    .replace(/ asset=\d+\s*$/, '')
    .trim();
  for (const [prefix, text] of HUMAN) {
    if (msg.startsWith(prefix)) return text;
  }
  return `Hyperliquid error: ${msg.slice(0, UNKNOWN_MAX)}`;
}

/** The raw `/exchange` response carried by the SDK's ApiRequestError, if any. */
export function apiResponseOf(e: unknown): unknown {
  return e instanceof Error && 'response' in e ? (e as { response: unknown }).response : undefined;
}

/** Per-order statuses inside a raw order/cancel response (`response.data.statuses`). */
export function statusesOf(response: unknown): unknown[] | null {
  const statuses = (response as { response?: { data?: { statuses?: unknown } } } | null)?.response
    ?.data?.statuses;
  return Array.isArray(statuses) ? statuses : null;
}

const num = (s: unknown): number =>
  typeof s === 'string' || typeof s === 'number' ? Number(s) : 0;
/** Plain decimal text without float noise (0.30000000000000004 → "0.3"). */
const fmt = (n: number): string => String(Number(n.toPrecision(12)));
const EPS = 1e-9;

/**
 * Order statuses → one result. A partial fill is reported as partial (filled/requested), never as
 * filled (Review Focus 4); errors only win when nothing filled or rested.
 */
export function mapOrderStatuses(statuses: unknown[], requestedSz: number): ExecResult {
  let filledSz = 0;
  let notional = 0;
  let resting = false;
  let error: string | null = null;
  let recognised = 0;
  for (const s of statuses) {
    if (typeof s === 'string') {
      // "waitingForTrigger" / "waitingForFill" (trigger orders) or "success".
      resting = true;
      recognised++;
      continue;
    }
    if (typeof s !== 'object' || s === null) continue;
    const o = s as {
      filled?: { totalSz?: unknown; avgPx?: unknown };
      resting?: unknown;
      error?: unknown;
    };
    if (o.filled) {
      const sz = num(o.filled.totalSz);
      filledSz += sz;
      notional += sz * num(o.filled.avgPx);
      recognised++;
    } else if (o.resting) {
      resting = true;
      recognised++;
    } else if (typeof o.error === 'string') {
      error ??= o.error;
      recognised++;
    }
  }
  if (filledSz > 0) {
    const avgPx = Number((notional / filledSz).toPrecision(10));
    const sz = Number(filledSz.toPrecision(12));
    if (sz >= requestedSz - EPS) {
      return {
        status: 'filled',
        filledSz: sz,
        requestedSz,
        avgPx,
        message: `Filled ${fmt(sz)} @ ${fmt(avgPx)}`,
      };
    }
    return {
      status: 'partial',
      filledSz: sz,
      requestedSz,
      avgPx,
      message: `Partially filled ${fmt(sz)}/${fmt(requestedSz)} @ ${fmt(avgPx)}`,
    };
  }
  if (resting) return { status: 'resting', requestedSz, message: 'Order resting' };
  if (error !== null) return { status: 'none', requestedSz, message: humanizeHlError(error) };
  return {
    status: 'error',
    requestedSz,
    message: recognised === 0 ? 'Unexpected exchange response' : 'Nothing executed',
  };
}
