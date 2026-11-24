import { z } from 'zod';
import { CardModelSchema, OverlaySchema } from './cards';

const seq = z.number().int().nonnegative();

/** Server to HUD. `welcome`, `deck` and `overlay` are sequenced so a reconnecting HUD can resume. */
export const ServerMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), sessionId: z.string().min(1), seq }),
  z.object({ t: z.literal('deck'), seq, cards: z.array(CardModelSchema) }),
  z.object({ t: z.literal('overlay'), seq, overlay: OverlaySchema.nullable() }),
  z.object({ t: z.literal('error'), code: z.string().min(1), message: z.string() }),
  z.object({ t: z.literal('pong') }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;

/** HUD to server. Audio travels as binary frames between `voice start` and `voice end`. */
export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    token: z.string().min(1),
    lastSeq: seq.optional(),
    /** Session the client's `lastSeq` belongs to; a mismatch (server restart) replays everything. */
    sessionId: z.string().min(1).optional(),
  }),
  z.object({ t: z.literal('action'), cardId: z.string().min(1), actionId: z.string().min(1) }),
  z.object({ t: z.literal('confirm'), proposalId: z.string().min(1) }),
  z.object({ t: z.literal('cancel'), proposalId: z.string().min(1) }),
  /** `cancel` abandons the utterance (2×TAP, exit, disconnect): nothing is transcribed. */
  z.object({ t: z.literal('voice'), phase: z.enum(['start', 'end', 'cancel']) }),
  z.object({ t: z.literal('dismiss') }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;
