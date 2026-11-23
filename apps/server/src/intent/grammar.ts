import type { Intent } from '@hypersight/protocol';
import { coinFromToken } from './aliases';

export type IntentContext = {
  perpCoins: string[];
  positions: { coin: string }[];
  outcomePositions: { marketKey: string; sideIndex: 0 | 1 }[];
  markets: { key: string; short: string; sides: [string, string]; aliases: string[] }[];
};

type Market = IntentContext['markets'][number];

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000 };

const isNumberWord = (w: string | undefined): boolean =>
  w !== undefined && (w in UNITS || w in TENS || w in SCALES);
const isNumeric = (w: string | undefined): boolean => w !== undefined && /^\d+(\.\d+)?$/.test(w);

/** Folds spoken numbers into digits: `twenty five` → `25`, `a hundred` → `100`. */
function mergeNumberWords(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i] as string;
    const startsRun =
      isNumberWord(w) ||
      (w === 'a' && tokens[i + 1] !== undefined && (tokens[i + 1] as string) in SCALES);
    if (!startsRun) {
      out.push(w);
      continue;
    }
    let total = 0;
    let current = 0;
    let j = i;
    if (w === 'a') {
      current = 1;
      j++;
    }
    for (; j < tokens.length; j++) {
      const t = tokens[j] as string;
      if (t in UNITS) current += UNITS[t] as number;
      else if (t in TENS) current += TENS[t] as number;
      else if (t === 'hundred') current = (current || 1) * 100;
      else if (t === 'thousand') {
        total += (current || 1) * 1000;
        current = 0;
      } else if (t === 'and' && isNumberWord(tokens[j + 1])) continue;
      else break;
    }
    out.push(String(total + current));
    i = j - 1;
  }
  return out;
}

/** Lowercase, currency/percent/thousands handled, punctuation removed, number words → digits. */
export function tokenize(text: string): string[] {
  let s = text.toLowerCase();
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  s = s.replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 dollars ');
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent ');
  s = s.replace(/['’]/g, '');
  s = s.replace(/(\d)\.(?=\d)/g, '$1§');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9§\s]/g, ' ').replace(/§/g, '.');
  return mergeNumberWords(s.split(/\s+/).filter(Boolean));
}

/** First number in a phrase: digits, `$20`, `20 bucks`, `twenty five`, `a hundred`. */
export function parseNumberWords(s: string): number | null {
  const t = tokenize(s).find(isNumeric);
  return t === undefined ? null : Number(t);
}

/** Leverage like `3x`, `3 x`, `3 times`, `leverage 3`; returns the value and the token indexes used. */
function leverageOf(tokens: string[]): { value: number; used: Set<number> } | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const m = /^(\d+)x$/.exec(t);
    if (m) return { value: Number(m[1]), used: new Set([i]) };
    if (isNumeric(t) && (tokens[i + 1] === 'x' || tokens[i + 1] === 'times')) {
      return { value: Number(t), used: new Set([i, i + 1]) };
    }
    if (t === 'leverage' && isNumeric(tokens[i + 1])) {
      return { value: Number(tokens[i + 1]), used: new Set([i, i + 1]) };
    }
  }
  return null;
}

/** USD amount: a number followed by dollars/bucks/usd wins, else the first free number. */
function amountOf(tokens: string[], exclude: Set<number> = new Set()): number | null {
  let first: number | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (exclude.has(i) || !isNumeric(tokens[i])) continue;
    if (tokens[i + 1] === 'percent') continue;
    const n = Number(tokens[i]);
    const unit = tokens[i + 1];
    if (unit === 'dollars' || unit === 'dollar' || unit === 'bucks' || unit === 'usd') return n;
    if (first === null) first = n;
  }
  return first;
}

/** `half` 0.5, `quarter` 0.25, `third` 0.333, `all`/`everything` 1, `N percent` N/100; default 1. */
function fractionOf(tokens: string[]): number | null {
  const pct = tokens.indexOf('percent');
  if (pct > 0 && isNumeric(tokens[pct - 1])) {
    const n = Number(tokens[pct - 1]);
    return n > 0 && n <= 100 ? n / 100 : null;
  }
  if (tokens.includes('half')) return 0.5;
  if (tokens.includes('quarter')) return 0.25;
  if (tokens.includes('third')) return 0.333;
  return 1;
}

function coinOf(tokens: string[], ctx: IntentContext): string | null {
  for (const t of tokens) {
    const coin = coinFromToken(t, ctx.perpCoins);
    if (coin) return coin;
  }
  return null;
}

/** Best market by alias hits; a tie means ambiguous (null). */
function marketOf(tokens: string[], ctx: IntentContext): Market | null {
  const words = new Set(tokens);
  let best: Market | null = null;
  let bestScore = 0;
  let tie = false;
  for (const m of ctx.markets) {
    const score = new Set(m.aliases.filter((a) => words.has(a))).size;
    if (score > bestScore) {
      best = m;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  return bestScore > 0 && !tie ? best : null;
}

function sideOf(tokens: string[], market: Market): 0 | 1 | null {
  const words = new Set(tokens);
  const labelWords = market.sides.map((s) => s.toLowerCase().split(/\s+/));
  // Longer labels first so "no change" is not read as "change".
  const order = [0, 1].sort((a, b) => (labelWords[b]?.length ?? 0) - (labelWords[a]?.length ?? 0));
  for (const i of order) {
    const lw = labelWords[i] as string[];
    if (lw.join(' ') === 'yes' || lw.join(' ') === 'no') continue;
    if (lw.every((w) => words.has(w))) return i as 0 | 1;
  }
  if (words.has('yes')) return 0;
  if (words.has('no')) return 1;
  return null;
}

/**
 * Deterministic parser for the short phrases the HUD suggests. Returns null when unsure, so the
 * caller can fall back to the LLM; it never guesses an amount, side or market.
 */
export function parseIntentFast(text: string, ctx: IntentContext): Intent | null {
  const tokens = tokenize(text);
  const has = (...ws: string[]) => ws.some((w) => tokens.includes(w));
  if (tokens.length === 0) return null;

  if (has('cancel') && has('all', 'orders', 'everything')) return { kind: 'cancelAll' };

  if (has('odds', 'chance', 'chances', 'probability')) {
    const m = marketOf(tokens, ctx);
    return m ? { kind: 'query', topic: 'odds', marketKey: m.key } : null;
  }
  if (has('pnl', 'profit') || (has('p') && has('l'))) return { kind: 'query', topic: 'pnl' };
  if (has('balance', 'equity')) return { kind: 'query', topic: 'balance' };
  if (has('price')) {
    const coin = coinOf(tokens, ctx);
    return coin ? { kind: 'query', topic: 'price', coin } : null;
  }

  if (has('stop')) {
    const coin = coinOf(tokens, ctx);
    const px = amountOf(tokens);
    return coin && px !== null && px > 0 ? { kind: 'setStop', coin, triggerPx: px } : null;
  }

  if (has('close')) {
    const fraction = fractionOf(tokens);
    if (fraction === null) return null;
    let coin = coinOf(tokens, ctx);
    if (!coin && ctx.positions.length === 1) coin = (ctx.positions[0] as { coin: string }).coin;
    return coin ? { kind: 'closePerp', coin, fraction } : null;
  }

  if (has('long', 'short')) {
    const coin = coinOf(tokens, ctx);
    const lev = leverageOf(tokens);
    const usd = amountOf(tokens, lev?.used);
    if (!coin || usd === null || usd <= 0) return null;
    const side = has('long') ? 'long' : 'short';
    if (lev && (lev.value < 1 || lev.value > 50)) return null;
    return lev
      ? { kind: 'openPerp', coin, side, usd, leverage: lev.value }
      : { kind: 'openPerp', coin, side, usd };
  }

  if (has('buy')) {
    const m = marketOf(tokens, ctx);
    if (!m) return null;
    const sideIndex = sideOf(tokens, m);
    const usd = amountOf(tokens);
    if (sideIndex === null || usd === null || usd <= 0) return null;
    return { kind: 'buyOutcome', marketKey: m.key, sideIndex, usd };
  }

  if (has('sell', 'dump')) {
    const m = marketOf(tokens, ctx);
    if (!m) return null;
    const fraction = fractionOf(tokens);
    if (fraction === null) return null;
    let sideIndex = sideOf(tokens, m);
    if (sideIndex === null) {
      const held = ctx.outcomePositions.filter((p) => p.marketKey === m.key);
      if (held.length === 1) sideIndex = (held[0] as { sideIndex: 0 | 1 }).sideIndex;
    }
    return sideIndex === null
      ? null
      : { kind: 'sellOutcome', marketKey: m.key, sideIndex, fraction };
  }

  if (has('watch', 'follow', 'track')) {
    const m = marketOf(tokens, ctx);
    return m ? { kind: 'watch', marketKey: m.key } : null;
  }

  return null;
}
