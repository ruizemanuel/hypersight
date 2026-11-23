import { z } from 'zod';
import { IntentSchema } from './intent';

export const RiskLimitsSchema = z.object({
  maxOrderUsd: z.number().positive(),
  maxDailyUsd: z.number().positive(),
  maxLeverage: z.number().int().min(1).max(50),
  /** Perp IOC limit offset from the reference price, e.g. 0.01 = 1%. */
  perpSlippage: z.number().gt(0).lt(0.5),
  /** Outcome IOC limit offset in ticks of 0.01. */
  outcomeSlippageTicks: z.number().int().min(0).max(20),
  minWriteIntervalMs: z.number().int().nonnegative(),
  allowedCoins: z.array(z.string().min(1)).min(1),
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxOrderUsd: 250,
  maxDailyUsd: 2000,
  maxLeverage: 5,
  perpSlippage: 0.01,
  outcomeSlippageTicks: 3,
  minWriteIntervalMs: 2000,
  allowedCoins: ['BTC', 'ETH', 'SOL', 'HYPE'],
};

export const PresetsSchema = z.object({
  closeFractions: z.array(z.number().gt(0).lte(1)).min(1).max(3),
  outcomeUsd: z.array(z.number().positive()).min(1).max(3),
  openUsd: z.array(z.number().positive()).min(1).max(3),
  defaultLeverage: z.number().int().min(1).max(50),
});
export type Presets = z.infer<typeof PresetsSchema>;

/** Outcome presets are sized for the ~$10/side depth of testnet outcome books (spike results). */
export const DEFAULT_PRESETS: Presets = {
  closeFractions: [0.25, 0.5, 1],
  outcomeUsd: [5, 10, 25],
  openUsd: [25, 50, 100],
  defaultLeverage: 2,
};

export const SettingsSchema = z.object({
  risk: RiskLimitsSchema,
  presets: PresetsSchema,
  mode: z.enum(['testnet', 'paper']),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  risk: DEFAULT_RISK_LIMITS,
  presets: DEFAULT_PRESETS,
  mode: 'testnet',
};

export const AlertRuleKindSchema = z.enum([
  'priceCross',
  'oddsMove',
  'pnlPct',
  'liqDistance',
  'fill',
  'settled',
]);
export type AlertRuleKind = z.infer<typeof AlertRuleKindSchema>;

export const AlertRuleSchema = z.object({
  id: z.string().min(1).max(64),
  kind: AlertRuleKindSchema,
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  /** Suggested action offered on the alert card ("your rule: ..."); it always goes through confirm. */
  action: IntentSchema.optional(),
  cooldownMs: z.number().int().nonnegative(),
  enabled: z.boolean(),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;
