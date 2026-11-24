import type { RiskLimits } from '@hypersight/protocol';

export type RiskInput = {
  network: string;
  /** Perp coin; outcome orders have none. */
  coin?: string;
  notionalUsd: number;
  leverage?: number;
  /** Closing or selling: always allowed past the size caps and coin list (less risk, not more). */
  reducesExposure: boolean;
};

export type RiskResult = { ok: true } | { ok: false; reason: string };

export type RiskContext = { dailyUsedUsd: number; lastWriteAt: number | null; now: number };

/** Float noise: 390625 × 0.00064 is 250.00000000000003, which is still $250. */
const EPS = 1e-9;

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Hard limits checked before every proposal and again before execution. */
export function checkRisk(input: RiskInput, limits: RiskLimits, ctx: RiskContext): RiskResult {
  if (input.network !== 'testnet') return { ok: false, reason: 'Testnet only' };
  if (!input.reducesExposure) {
    if (input.coin !== undefined && !limits.allowedCoins.includes(input.coin)) {
      return { ok: false, reason: `${input.coin} not enabled` };
    }
    if (input.leverage !== undefined && input.leverage > limits.maxLeverage) {
      return { ok: false, reason: `Max leverage ${limits.maxLeverage}×` };
    }
    if (input.notionalUsd > limits.maxOrderUsd + EPS) {
      return { ok: false, reason: `Max order is ${usd(limits.maxOrderUsd)}` };
    }
    if (ctx.dailyUsedUsd + input.notionalUsd > limits.maxDailyUsd + EPS) {
      return { ok: false, reason: `Daily limit ${usd(limits.maxDailyUsd)} reached` };
    }
  }
  if (ctx.lastWriteAt !== null && ctx.now - ctx.lastWriteAt < limits.minWriteIntervalMs) {
    return { ok: false, reason: 'Too fast — wait a second' };
  }
  return { ok: true };
}
