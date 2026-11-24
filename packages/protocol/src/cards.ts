import { z } from 'zod';
import { IntentSchema } from './intent';

export const BadgeSchema = z.enum(['TESTNET', 'PAPER']);
export type Badge = z.infer<typeof BadgeSchema>;

export const QuickActionSchema = z.object({
  id: z.string().min(1).max(32),
  label: z.string().min(1).max(24),
  intent: IntentSchema,
});
export type QuickAction = z.infer<typeof QuickActionSchema>;

export const CardKindSchema = z.enum([
  'account',
  'perp',
  'outcomePosition',
  'market',
  'gram',
  'recap',
  'empty',
]);
export type CardKind = z.infer<typeof CardKindSchema>;

/** One glanceable card on the glasses deck: one idea, key number first. */
export const CardModelSchema = z.object({
  id: z.string().min(1).max(64),
  kind: CardKindSchema,
  title: z.string(),
  value: z.string(),
  lines: z.array(z.string()).max(3),
  hint: z.string(),
  badge: BadgeSchema,
  actions: z.array(QuickActionSchema).max(5),
});
export type CardModel = z.infer<typeof CardModelSchema>;

export const ProposalViewSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  lines: z.array(z.string()).max(3),
  /** Epoch ms after which a confirm is refused. */
  expiresAt: z.number(),
  /** Set when risk or sizing refused the action: the card shows the reason and offers no confirm. */
  blocked: z.string().optional(),
  /** One extra line under the details: what was heard, or why the card was refreshed. */
  note: z.string().max(120).optional(),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

export const OverlaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('listening'),
    transcript: z.string(),
    /** How listening started (HUD-side): hold → release sends; menu → tap sends. */
    source: z.enum(['hold', 'menu']).optional(),
  }),
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('confirm'), proposal: ProposalViewSchema }),
  z.object({
    kind: z.literal('result'),
    ok: z.boolean(),
    title: z.string(),
    lines: z.array(z.string()).max(3),
  }),
  z.object({
    kind: z.literal('alert'),
    title: z.string(),
    lines: z.array(z.string()).max(3),
    action: QuickActionSchema.optional(),
  }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type Overlay = z.infer<typeof OverlaySchema>;
export type OverlayKind = Overlay['kind'];
