import type { MetaResponse } from '@nktkas/hyperliquid/api/info';

/** HIP-4 encoding: `enc = 10·outcome + side` (side 0 = first/YES, 1 = second/NO). */
export function outcomeEnc(outcome: number, side: 0 | 1): number {
  return 10 * outcome + side;
}

/** Coin name used in books, mids and order updates: `#<enc>`. */
export function outcomeCoin(outcome: number, side: 0 | 1): string {
  return `#${outcomeEnc(outcome, side)}`;
}

/** Coin name of a held outcome balance in `spotClearinghouseState`: `+<enc>`. */
export function outcomeBalanceCoin(outcome: number, side: 0 | 1): string {
  return `+${outcomeEnc(outcome, side)}`;
}

/** Asset id for orders: `100_000_000 + enc`. */
export function outcomeAsset(outcome: number, side: 0 | 1): number {
  return 100_000_000 + outcomeEnc(outcome, side);
}

/** `+271210` → `{outcome: 27121, side: 0}`; anything else (USDC, `#enc`, bad sides) → null. */
export function parseBalanceCoin(coin: string): { outcome: number; side: 0 | 1 } | null {
  const m = /^\+(\d+)$/.exec(coin);
  if (!m) return null;
  const enc = Number(m[1]);
  const side = enc % 10;
  if (side !== 0 && side !== 1) return null;
  return { outcome: Math.floor(enc / 10), side };
}

export type PerpMeta = {
  name: string;
  /** Position in `meta.universe` = the perp asset id (testnet BTC = 3). */
  index: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
};

/** Listed perps with their asset ids; delisted entries are skipped but keep indexes stable. */
export function parsePerpMeta(meta: MetaResponse): PerpMeta[] {
  const out: PerpMeta[] = [];
  meta.universe.forEach((u, index) => {
    if (u.isDelisted) return;
    out.push({
      name: u.name,
      index,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      onlyIsolated: u.onlyIsolated === true,
    });
  });
  return out;
}
