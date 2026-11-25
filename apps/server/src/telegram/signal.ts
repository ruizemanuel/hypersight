import type { Intent, Presets } from '@hypersight/protocol';
import { type IntentContext, parseIntentFast } from '../intent/grammar';

/** How traders announce a trade in a chat, folded into the verbs the intent grammar reads. */
const SYNONYMS: Record<string, string> = {
  longing: 'long',
  longed: 'long',
  longeo: 'long',
  longueo: 'long',
  longee: 'long',
  longuee: 'long',
  longeando: 'long',
  longueando: 'long',
  longear: 'long',
  shorting: 'short',
  shorted: 'short',
  shorteo: 'short',
  shortee: 'short',
  shorteando: 'short',
  shortear: 'short',
  buying: 'buy',
  bought: 'buy',
  compro: 'buy',
  selling: 'sell',
  sold: 'sell',
  vendo: 'sell',
  vendi: 'sell',
  closing: 'close',
  closed: 'close',
  cierro: 'close',
  cerre: 'close',
};

/** "no longeo eth" / "no buy" in a chat is a negation, never the outcome side "no". */
const NO_BEFORE_VERB = /\bno (?=(?:long|short|buy|sell|close)\b)/g;
/** Disclaimers under a call ("not financial advice") are not a negation of the trade. */
const DISCLAIMERS =
  /\b(?:not (?:an? )?(?:financial |investment )?advice|no es (?:un )?consejo(?: financiero| de inversion)?)\b/g;

function canonical(text: string): string {
  const s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(DISCLAIMERS, ' ')
    .replace(/[a-z]+/g, (w) => SYNONYMS[w] ?? w);
  return s.replace(NO_BEFORE_VERB, 'dont ');
}

const middle = (xs: number[]): number => (xs[1] ?? xs[0]) as number;

/**
 * A trade announced in a chat message, sized from the user's presets: the message only picks the
 * coin or market, the side and (for closes and sells) the share. Returns null for anything that is
 * not an open, a buy, or a close/sell of something the user holds.
 */
export function parseSignal(text: string, ctx: IntentContext, presets: Presets): Intent | null {
  // No focus and no single-position fallback: a chat message must name what it trades.
  const strict: IntentContext = { ...ctx, positions: [], focus: undefined };
  const s = canonical(text);
  const placeholder = ` ${middle(presets.openUsd)} dollars`;
  let intent = parseIntentFast(s, strict) ?? parseIntentFast(s + placeholder, strict);
  if (!intent) {
    // Entry, targets and stops ("entry 2450 tp 2600") are not a size; only a perp open may drop them.
    const bare = parseIntentFast(s.replace(/\d+(?:[.,]\d+)?/g, ' ') + placeholder, strict);
    if (bare?.kind === 'openPerp') intent = bare;
  }
  if (!intent) return null;
  switch (intent.kind) {
    case 'openPerp':
      return {
        kind: 'openPerp',
        coin: intent.coin,
        side: intent.side,
        usd: middle(presets.openUsd),
        leverage: presets.defaultLeverage,
      };
    case 'buyOutcome':
      return { ...intent, usd: middle(presets.outcomeUsd) };
    case 'closePerp':
      return ctx.positions.some((p) => p.coin === intent.coin) ? intent : null;
    case 'sellOutcome':
      return ctx.outcomePositions.some(
        (p) => p.marketKey === intent.marketKey && p.sideIndex === intent.sideIndex,
      )
        ? intent
        : null;
    default:
      return null;
  }
}
