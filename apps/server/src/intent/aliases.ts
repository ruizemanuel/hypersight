import type { AccountView } from '../hl/account';
import type { Catalogue, OutcomeMarket } from '../hl/outcomes';
import type { IntentContext } from './grammar';

/** Spoken names for the core perps (`eath` is a common mis-transcription). */
export const COIN_ALIASES: Record<string, string[]> = {
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ether', 'ethereum', 'eath'],
  SOL: ['sol', 'solana'],
  HYPE: ['hype', 'hyperliquid'],
};

const CORE_COINS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const PERIOD_ALIAS: Record<string, string> = { '1d': 'daily', '1h': 'hourly', '1w': 'weekly' };
const SOONEST = 30;
const BASE_KEYTERMS = ['Hyperliquid', 'BTC', 'ETH', 'SOL', 'HYPE'];
const MAX_KEYTERMS = 50;

const STOPWORDS = new Set(
  (
    'the and for will with from this that what which who when where above below over under ' +
    'than then into onto about after before between each other yes win wins winner game match ' +
    'matchday season regular stage group round final finals week day utc jan feb mar apr may jun ' +
    'jul aug sep oct nov dec january february march april june july august september october ' +
    'november december'
  ).split(' '),
);

export function coinFromToken(token: string, perpCoins: string[]): string | null {
  for (const [coin, aliases] of Object.entries(COIN_ALIASES)) {
    if (aliases.includes(token)) return coin;
  }
  const upper = token.toUpperCase();
  return perpCoins.includes(upper) ? upper : null;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function aliasesFor(m: OutcomeMarket): string[] {
  const out = new Set<string>();
  const recurring = m.recurring ?? recurringFromKey(m.key);
  if (recurring) {
    for (const a of COIN_ALIASES[recurring.underlying] ?? [recurring.underlying.toLowerCase()])
      out.add(a);
    const period = PERIOD_ALIAS[recurring.period];
    if (period) out.add(period);
    return [...out];
  }
  for (const side of m.sides) {
    if (/^(yes|no)$/i.test(side)) continue;
    for (const w of words(side)) out.add(w);
  }
  for (const w of words(m.title)) out.add(w);
  return [...out];
}

/** `rq:BTC:1d:0` (price-bucket member) → underlying + period. */
function recurringFromKey(key: string): { underlying: string; period: string } | null {
  const m = /^r[bq]:([^:]+):([^:]+)/.exec(key);
  return m ? { underlying: m[1] as string, period: m[2] as string } : null;
}

/** Markets the voice grammar can name: watched + held + the 30 soonest-expiring. */
export function buildIntentContext(
  view: AccountView,
  catalogue: Catalogue,
  watchKeys: string[],
  opts: { perpCoins?: string[]; now?: number } = {},
): IntentContext {
  const now = opts.now ?? Date.now();
  const chosen = new Map<string, OutcomeMarket>();
  const add = (m: OutcomeMarket | undefined) => {
    if (m && !chosen.has(m.key)) chosen.set(m.key, m);
  };
  for (const k of watchKeys) add(catalogue.byKey(k));
  for (const o of view.outcomes) add(o.market);
  const upcoming = catalogue
    .all()
    .filter((m) => m.expiresAt !== undefined && m.expiresAt > now)
    .sort((a, b) => (a.expiresAt as number) - (b.expiresAt as number))
    .slice(0, SOONEST);
  for (const m of upcoming) add(m);

  const perpCoins = [
    ...new Set([...(opts.perpCoins ?? CORE_COINS), ...view.perps.map((p) => p.coin)]),
  ];
  return {
    perpCoins,
    positions: view.perps.map((p) => ({ coin: p.coin })),
    outcomePositions: view.outcomes.map((o) => ({
      marketKey: o.market.key,
      sideIndex: o.sideIndex,
    })),
    markets: [...chosen.values()].map((m) => ({
      key: m.key,
      short: m.short,
      sides: m.sides,
      aliases: aliasesFor(m),
    })),
  };
}

/** Speech-to-text keyterms: tickers first, then distinctive market words (≤ 50, ≤ 20 chars). */
export function keytermsFor(ctx: IntentContext): string[] {
  const out = new Set<string>(BASE_KEYTERMS);
  for (const m of ctx.markets) {
    for (const side of m.sides) {
      if (!/^(yes|no)$/i.test(side) && side.length <= 20) out.add(side);
    }
  }
  for (const m of ctx.markets) {
    for (const a of m.aliases) {
      if (a.length >= 4 && a.length <= 20) out.add(a);
    }
  }
  return [...out].slice(0, MAX_KEYTERMS);
}
