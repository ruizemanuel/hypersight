import { z } from 'zod';

const coin = z.string().min(1).max(20);
const marketKey = z.string().min(1).max(64);
/** 0 = first side (YES / first team), 1 = second side (NO / second team). */
const sideIndex = z.union([z.literal(0), z.literal(1)]);
/** Share of a position, 0 < f <= 1. */
const fraction = z.number().gt(0).lte(1);
const usd = z.number().positive();

export const IntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('closePerp'), coin, fraction }),
  z.object({
    kind: z.literal('openPerp'),
    coin,
    side: z.enum(['long', 'short']),
    usd,
    leverage: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ kind: z.literal('buyOutcome'), marketKey, sideIndex, usd }),
  z.object({ kind: z.literal('sellOutcome'), marketKey, sideIndex, fraction }),
  z.object({ kind: z.literal('setStop'), coin, triggerPx: z.number().positive() }),
  z.object({ kind: z.literal('cancelAll') }),
  z.object({
    kind: z.literal('query'),
    topic: z.enum(['pnl', 'price', 'odds', 'balance']),
    coin: coin.optional(),
    marketKey: marketKey.optional(),
  }),
  z.object({ kind: z.literal('watch'), marketKey }),
  z.object({ kind: z.literal('unknown'), reason: z.string().min(1).max(200) }),
]);

export type Intent = z.infer<typeof IntentSchema>;
export type IntentKind = Intent['kind'];
