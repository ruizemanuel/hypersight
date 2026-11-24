import type { Intent } from '@hypersight/protocol';
import { coinFromToken } from './aliases';

export type IntentContext = {
  perpCoins: string[];
  positions: { coin: string }[];
  outcomePositions: { marketKey: string; sideIndex: 0 | 1 }[];
  markets: {
    key: string;
    short: string;
    sides: [string, string];
    aliases: string[];
    /** Price markets: YES pays when the underlying ends ≥ lo and < hi (either bound may be open). */
    range?: { lo?: number; hi?: number };
    /** Price-bucket member: only named with a bucket word or one of its thresholds. */
    bucket?: boolean;
  }[];
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
/** A run of number words that is not one English cardinal ("one fifty", "twenty nine fifty"). */
const BROKEN = '~';
const isBroken = (w: string): boolean => w.startsWith(BROKEN);

type Run = { value: number; end: number };

/**
 * Reads one English cardinal starting at `start`, stopping before any word that cannot extend it:
 * a unit or teen only before hundred/thousand, tens only after a hundred/thousand or at the start.
 */
function readCardinal(tokens: string[], start: number): Run {
  let total = 0;
  let current = 0;
  let segHundred = false;
  let last: 'start' | 'unit' | 'teen' | 'tens' | 'tensUnit' | 'hundred' | 'thousand' = 'start';
  let j = start;
  if (tokens[j] === 'a' && (tokens[j + 1] as string) in SCALES) {
    current = 1;
    last = 'unit';
    j++;
  }
  const open = () => last === 'start' || last === 'hundred' || last === 'thousand';
  for (; j < tokens.length; j++) {
    const t = tokens[j] as string;
    if (t === 'and' && (last === 'hundred' || last === 'thousand')) {
      // "two thousand and five" joins; "sixty thousand and sixty two thousand" does not.
      let k = j + 1;
      while (
        k < tokens.length &&
        k <= j + 2 &&
        ((tokens[k] as string) in UNITS || (tokens[k] as string) in TENS)
      )
        k++;
      if (k === j + 1 || (tokens[k] as string) in SCALES) break;
      continue;
    }
    if (t in UNITS) {
      const n = UNITS[t] as number;
      if (n >= 10) {
        if (!open()) break;
        last = 'teen';
      } else if (last === 'tens' && n > 0) last = 'tensUnit';
      else if (open()) last = 'unit';
      else break;
      current += n;
    } else if (t in TENS) {
      if (!open()) break;
      current += TENS[t] as number;
      last = 'tens';
    } else if (t === 'hundred') {
      if (last === 'start') current = 100;
      else if (segHundred || current === 0) break;
      else current *= 100;
      segHundred = true;
      last = 'hundred';
    } else if (t === 'thousand') {
      if (total > 0) break;
      total = (last === 'start' ? 1 : current) * 1000;
      current = 0;
      segHundred = false;
      last = 'thousand';
    } else break;
  }
  return { value: total + current, end: j };
}

/**
 * Folds spoken numbers into digits: `twenty five` → `25`, `a hundred` → `100`. Number words that
 * do not form one cardinal become a single `~` token carrying the pieces (`one fifty` → `~1-50`).
 */
function mergeNumberWords(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i] as string;
    const startsRun = isNumberWord(w) || (w === 'a' && (tokens[i + 1] as string) in SCALES);
    if (!startsRun) {
      out.push(w);
      continue;
    }
    const pieces: number[] = [];
    let j = i;
    do {
      const run = readCardinal(tokens, j);
      pieces.push(run.value);
      j = run.end;
    } while (isNumberWord(tokens[j]) && tokens[j - 1] !== 'and');
    out.push(pieces.length === 1 ? String(pieces[0]) : BROKEN + pieces.join('-'));
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
  s = s.replace(/\bper\s+cent\b/g, 'percent');
  s = s.replace(/['’]/g, '');
  s = s.replace(/(\d)\.(?=\d)/g, '$1§');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9§\s]/g, ' ').replace(/§/g, '.');
  return mergeNumberWords(s.split(/\s+/).filter(Boolean));
}

/** First number in a phrase: digits, `$20`, `20 bucks`, `twenty five`, `a hundred`; null if unclear. */
export function parseNumberWords(s: string): number | null {
  const t = tokenize(s).find((w) => isNumeric(w) || isBroken(w));
  return t === undefined || isBroken(t) ? null : Number(t);
}

/**
 * Every number the user could have meant, for checking an LLM intent: plain numbers, `3x`, and the
 * colloquial readings of broken runs (`one fifty` → 1, 50, 150, 1.5; `twenty nine fifty` → 2950).
 */
export function heardNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const t of tokenize(text)) {
    if (isNumeric(t)) out.add(Number(t));
    const lev = /^(\d+)x$/.exec(t);
    if (lev) out.add(Number(lev[1]));
    if (isBroken(t)) {
      const pieces = t.slice(BROKEN.length).split('-').map(Number);
      for (const p of pieces) out.add(p);
      const [head, ...rest] = pieces as [number, ...number[]];
      if (rest.length > 0 && rest.every((p) => p >= 10 && p <= 99)) {
        out.add(Number(`${head}${rest.join('')}`));
        if (rest.length === 1) out.add(head + (rest[0] as number) / 100);
      }
    }
  }
  return [...out];
}

/**
 * Every share of a position the user could have meant: fraction words (`half`, `two thirds`) and
 * percent readings of the numbers heard (`15` → 0.15), for checking an LLM intent.
 */
export function heardFractions(text: string): number[] {
  const tokens = tokenize(text);
  const out = new Set<number>();
  tokens.forEach((t, i) => {
    if (!FRACTION_WORDS.has(t) || t === 'percent') return;
    const denominator = t.startsWith('half') ? 2 : t.startsWith('quarter') ? 4 : 3;
    const count = isNumeric(tokens[i - 1]) ? Number(tokens[i - 1]) : 1;
    out.add(Math.round((count / denominator) * 1000) / 1000);
  });
  for (const n of heardNumbers(text)) {
    if (n > 0 && n <= 100) out.add(n / 100);
    if (n > 0 && n <= 1) out.add(n);
  }
  return [...out];
}

const CURRENCY = new Set(['dollars', 'dollar', 'bucks', 'usd']);
const FRACTION_WORDS = new Set([
  'half',
  'halves',
  'quarter',
  'quarters',
  'third',
  'thirds',
  'percent',
]);
const NEGATIONS = new Set([
  'dont',
  'not',
  'never',
  'cant',
  'wont',
  'doesnt',
  'didnt',
  'shouldnt',
  'wouldnt',
  'isnt',
]);
const VERBS: Record<string, string> = {
  close: 'close',
  long: 'open',
  short: 'open',
  buy: 'buy',
  sell: 'sell',
  dump: 'sell',
  stop: 'stop',
  cancel: 'cancel',
  watch: 'watch',
  follow: 'watch',
  track: 'watch',
};
const QUERY_WORDS = new Set([
  'odds',
  'chance',
  'chances',
  'probability',
  'pnl',
  'profit',
  'balance',
  'equity',
  'price',
]);
/** Words a bare "close half" may contain; anything else may be an asset we did not recognise. */
const CLOSE_FILLER = new Set([
  'close',
  'out',
  'of',
  'my',
  'the',
  'a',
  'an',
  'all',
  'half',
  'quarter',
  'quarters',
  'third',
  'thirds',
  'percent',
  'position',
  'positions',
  'trade',
  'it',
  'please',
  'now',
  'entire',
  'whole',
  'full',
  'take',
  'profit',
  'profits',
  'on',
  'long',
  'short',
  'everything',
  'that',
  'this',
  'up',
]);

const currencyAfter = (tokens: string[], i: number): boolean =>
  CURRENCY.has(tokens[i + 1] as string);

/** Indexes of number tokens, and the slot that claimed each one. */
class Numbers {
  readonly all: number[];
  private readonly used = new Set<number>();
  constructor(private readonly tokens: string[]) {
    this.all = tokens.flatMap((t, i) => (isNumeric(t) ? [i] : []));
  }
  use(i: number): void {
    this.used.add(i);
  }
  free(): number[] {
    return this.all.filter((i) => !this.used.has(i));
  }
  value(i: number): number {
    return Number(this.tokens[i]);
  }
  /** True when every number the user said filled a slot. */
  allUsed(): boolean {
    return this.free().length === 0;
  }
}

/** Leverage like `3x`, `3 x`, `3 times`, `leverage 3`, `5 leverage`; 'ambiguous' if two readings. */
function leverageOf(tokens: string[], nums: Numbers): number | null | 'ambiguous' {
  const found: { value: number; index?: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const m = /^(\d+)x$/.exec(t);
    if (m) found.push({ value: Number(m[1]) });
    else if (isNumeric(t) && (tokens[i + 1] === 'x' || tokens[i + 1] === 'times')) {
      found.push({ value: Number(t), index: i });
    } else if (t === 'leverage') {
      const j = tokens[i + 1] === 'of' ? i + 2 : i + 1;
      if (isNumeric(tokens[j]) && !currencyAfter(tokens, j))
        found.push({ value: Number(tokens[j]), index: j });
      if (isNumeric(tokens[i - 1]) && !currencyAfter(tokens, i - 1)) {
        found.push({ value: Number(tokens[i - 1]), index: i - 1 });
      }
    }
  }
  if (found.length === 0) return null;
  if (found.length > 1) return 'ambiguous';
  const f = found[0] as { value: number; index?: number };
  if (f.index !== undefined) nums.use(f.index);
  return f.value;
}

/** USD amount: the one free number left (a currency word after it is optional). */
function amountOf(nums: Numbers): number | null {
  const free = nums.free();
  if (free.length !== 1) return null;
  const i = free[0] as number;
  nums.use(i);
  return nums.value(i);
}

/** `half`, `a quarter`, `three quarters`, `two thirds`, `N percent`; 1 when no fraction is said. */
function fractionOf(tokens: string[], nums: Numbers): number | null {
  const at = tokens.flatMap((t, i) => (FRACTION_WORDS.has(t) ? [i] : []));
  if (at.length === 0) return 1;
  if (at.length > 1) return null;
  const i = at[0] as number;
  const word = tokens[i] as string;
  const prev = isNumeric(tokens[i - 1]) ? i - 1 : -1;
  if (word === 'percent') {
    if (prev < 0) return null;
    nums.use(prev);
    const n = nums.value(prev);
    return n > 0 && n <= 100 ? n / 100 : null;
  }
  const denominator = word.startsWith('half') ? 2 : word.startsWith('quarter') ? 4 : 3;
  let count = 1;
  if (prev >= 0) {
    nums.use(prev);
    count = nums.value(prev);
  }
  const f = Math.round((count / denominator) * 1000) / 1000;
  return f > 0 && f <= 1 ? f : null;
}

function coinsOf(tokens: string[], ctx: IntentContext): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    const coin = coinFromToken(t, ctx.perpCoins);
    if (coin) out.add(coin);
  }
  return [...out];
}

const ABOVE = new Set(['above', 'over', 'higher']);
const BELOW = new Set(['below', 'under', 'lower']);
const BETWEEN = new Set(['between', 'range']);

/** Best market by alias hits plus price-range words and thresholds; a tie means ambiguous (null). */
function marketOf(tokens: string[], ctx: IntentContext, nums: Numbers): Market | null {
  const words = new Set(tokens);
  const said = (set: Set<string>) => tokens.some((t) => set.has(t));
  const rangeNums = nums.all.filter((i) => !currencyAfter(tokens, i));
  let best: { m: Market; hits: number[] } | null = null;
  let bestScore = 0;
  let tie = false;
  for (const m of ctx.markets) {
    const aliasScore = new Set(m.aliases.filter((a) => words.has(a))).size;
    let score = aliasScore;
    const hits: number[] = [];
    if (m.range) {
      const { lo, hi } = m.range;
      for (const i of rangeNums) {
        const n = nums.value(i);
        if (n === lo || n === hi) hits.push(i);
      }
      const direction =
        lo !== undefined && hi !== undefined
          ? said(BETWEEN)
          : lo !== undefined
            ? said(ABOVE)
            : said(BELOW);
      if (m.bucket && !direction && hits.length === 0) continue;
      if (aliasScore === 0 && hits.length === 0) continue;
      score += hits.length + (direction ? 1 : 0);
    }
    if (score > bestScore) {
      best = { m, hits };
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  if (!best || bestScore === 0 || tie) return null;
  for (const i of best.hits) nums.use(i);
  return best.m;
}

const isYesNo = (m: Market) =>
  m.sides[0].toLowerCase() === 'yes' && m.sides[1].toLowerCase() === 'no';

/** YES/NO on yes/no markets; otherwise exactly one side label, and no stray yes/no. */
function sideOf(tokens: string[], market: Market): 0 | 1 | null {
  if (isYesNo(market)) {
    const yes = tokens.includes('yes');
    const no = tokens.includes('no');
    return yes === no ? null : yes ? 0 : 1;
  }
  const remaining = [...tokens];
  const labels = market.sides.map((s) => tokenize(s));
  // Longer labels first so "no change" is not also read as "change".
  const order = [0, 1].sort((a, b) => (labels[b]?.length ?? 0) - (labels[a]?.length ?? 0));
  let side: 0 | 1 | null = null;
  for (const i of order) {
    const label = labels[i] as string[];
    const at = label.map((w) => remaining.indexOf(w));
    if (label.length === 0 || at.some((k) => k < 0)) continue;
    if (side !== null) return null;
    side = i as 0 | 1;
    for (const k of at) remaining[k] = '';
  }
  if (remaining.includes('yes') || remaining.includes('no')) return null;
  return side;
}

/**
 * Deterministic parser for the short phrases the HUD suggests. Returns null when unsure, so the
 * caller can fall back to the LLM; it never guesses an amount, side or market: every number must
 * fill exactly one slot, one action only, no negation.
 */
export function parseIntentFast(text: string, ctx: IntentContext): Intent | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  if (tokens.some(isBroken) || tokens.some((t) => NEGATIONS.has(t))) return null;
  const has = (...ws: string[]) => ws.some((w) => tokens.includes(w));
  // "take profit on half my eth" closes a position; it is not a PnL question.
  const takeProfit = tokens.some(
    (t, i) => t === 'take' && (tokens[i + 1] === 'profit' || tokens[i + 1] === 'profits'),
  );
  const verbs = new Set(tokens.flatMap((t) => (t in VERBS ? [VERBS[t] as string] : [])));
  if (takeProfit) verbs.add('close');
  // "close my eth long" — long/short describe the position being closed.
  if (verbs.has('close')) verbs.delete('open');
  if (verbs.size > 1) return null;
  const verb = [...verbs][0];
  const query = tokens.some((t) => QUERY_WORDS.has(t)) && !takeProfit;
  if (verb && query) return null;
  const fractionSaid = tokens.some((t) => FRACTION_WORDS.has(t));
  if (fractionSaid && verb !== 'close' && verb !== 'sell') return null;

  const nums = new Numbers(tokens);
  const done = (intent: Intent): Intent | null => (nums.allUsed() ? intent : null);
  const coins = coinsOf(tokens, ctx);
  if (coins.length > 1) return null;
  const coin = coins[0] ?? null;

  if (!verb) {
    if (has('odds', 'chance', 'chances', 'probability')) {
      const m = marketOf(tokens, ctx, nums);
      return m ? done({ kind: 'query', topic: 'odds', marketKey: m.key }) : null;
    }
    if (has('pnl', 'profit') || (has('p') && has('l')))
      return done({ kind: 'query', topic: 'pnl' });
    if (has('balance', 'equity')) return done({ kind: 'query', topic: 'balance' });
    if (has('price')) return coin ? done({ kind: 'query', topic: 'price', coin }) : null;
    return null;
  }

  switch (verb) {
    case 'cancel':
      return has('all', 'orders', 'everything') ? done({ kind: 'cancelAll' }) : null;

    case 'stop': {
      const px = amountOf(nums);
      return coin && px !== null && px > 0 ? done({ kind: 'setStop', coin, triggerPx: px }) : null;
    }

    case 'close': {
      const fraction = fractionOf(tokens, nums);
      if (fraction === null) return null;
      let target = coin;
      const onlyFiller = tokens.every((t) => CLOSE_FILLER.has(t) || isNumeric(t));
      if (!target && ctx.positions.length === 1 && onlyFiller) {
        target = (ctx.positions[0] as { coin: string }).coin;
      }
      return target ? done({ kind: 'closePerp', coin: target, fraction }) : null;
    }

    case 'open': {
      if (has('long') && has('short')) return null;
      const lev = leverageOf(tokens, nums);
      if (lev === 'ambiguous') return null;
      const usd = amountOf(nums);
      if (!coin || usd === null || usd <= 0) return null;
      if (lev !== null && (lev < 1 || lev > 50)) return null;
      const side = has('long') ? 'long' : 'short';
      return done(
        lev !== null
          ? { kind: 'openPerp', coin, side, usd, leverage: lev }
          : { kind: 'openPerp', coin, side, usd },
      );
    }

    case 'buy': {
      const m = marketOf(tokens, ctx, nums);
      if (!m) return null;
      const sideIndex = sideOf(tokens, m);
      const usd = amountOf(nums);
      if (sideIndex === null || usd === null || usd <= 0) return null;
      return done({ kind: 'buyOutcome', marketKey: m.key, sideIndex, usd });
    }

    case 'sell': {
      const m = marketOf(tokens, ctx, nums);
      if (!m) return null;
      const fraction = fractionOf(tokens, nums);
      if (fraction === null) return null;
      let sideIndex = sideOf(tokens, m);
      if (sideIndex === null && !has('yes', 'no')) {
        const held = ctx.outcomePositions.filter((p) => p.marketKey === m.key);
        if (held.length === 1) sideIndex = (held[0] as { sideIndex: 0 | 1 }).sideIndex;
      }
      return sideIndex === null
        ? null
        : done({ kind: 'sellOutcome', marketKey: m.key, sideIndex, fraction });
    }

    case 'watch': {
      const m = marketOf(tokens, ctx, nums);
      return m ? done({ kind: 'watch', marketKey: m.key }) : null;
    }
  }
  return null;
}
