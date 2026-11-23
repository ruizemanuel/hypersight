import type { Intent } from '@hypersight/protocol';

export type MarketLookup = (key: string) => { short: string; sides: [string, string] } | undefined;

const pct = (f: number) => `${Math.round(f * 100)}%`;
const sideName = (side: string) => (/^(yes|no)$/i.test(side) ? side.toUpperCase() : side);

/** One-line human summary of an intent (result echoes, logs, audit entries). */
export function describeIntent(intent: Intent, market?: MarketLookup): string {
  const name = (key: string) => market?.(key)?.short ?? key;
  const side = (key: string, i: 0 | 1) => {
    const m = market?.(key);
    return m ? sideName(m.sides[i]) : `side ${i + 1}`;
  };
  switch (intent.kind) {
    case 'closePerp':
      return intent.fraction >= 1
        ? `Close all ${intent.coin}`
        : `Close ${pct(intent.fraction)} of ${intent.coin}`;
    case 'openPerp': {
      const base = `${intent.side === 'long' ? 'Long' : 'Short'} ${intent.coin} $${intent.usd}`;
      return intent.leverage ? `${base} at ${intent.leverage}×` : base;
    }
    case 'buyOutcome':
      return market?.(intent.marketKey)
        ? `Buy ${side(intent.marketKey, intent.sideIndex)} · ${name(intent.marketKey)} for $${intent.usd}`
        : `Buy ${side(intent.marketKey, intent.sideIndex)} of ${intent.marketKey} for $${intent.usd}`;
    case 'sellOutcome':
      return `Sell ${pct(intent.fraction)} of ${side(intent.marketKey, intent.sideIndex)} in ${name(intent.marketKey)}`;
    case 'setStop':
      return `Stop ${intent.coin} at ${intent.triggerPx}`;
    case 'cancelAll':
      return 'Cancel all orders';
    case 'query':
      if (intent.topic === 'odds')
        return `Odds for ${intent.marketKey ? name(intent.marketKey) : 'market'}`;
      if (intent.topic === 'price') return `Price of ${intent.coin ?? 'asset'}`;
      return intent.topic === 'pnl' ? 'PnL' : 'Balance';
    case 'watch':
      return `Watch ${name(intent.marketKey)}`;
    case 'unknown':
      return intent.reason;
  }
}
