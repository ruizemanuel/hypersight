import type { Intent } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { describeIntent } from '../../src/intent/describe';

describe('describeIntent', () => {
  it.each<[Intent, string]>([
    [{ kind: 'closePerp', coin: 'ETH', fraction: 0.5 }, 'Close 50% of ETH'],
    [{ kind: 'closePerp', coin: 'BTC', fraction: 1 }, 'Close all BTC'],
    [{ kind: 'openPerp', coin: 'SOL', side: 'long', usd: 50 }, 'Long SOL $50'],
    [
      { kind: 'openPerp', coin: 'ETH', side: 'short', usd: 100, leverage: 3 },
      'Short ETH $100 at 3×',
    ],
    [
      { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 1, usd: 10 },
      'Buy side 2 of rb:BTC:1d for $10',
    ],
    [
      { kind: 'sellOutcome', marketKey: 'o:24274', sideIndex: 0, fraction: 0.5 },
      'Sell 50% of side 1 in o:24274',
    ],
    [{ kind: 'setStop', coin: 'ETH', triggerPx: 3200 }, 'Stop ETH at 3200'],
    [{ kind: 'cancelAll' }, 'Cancel all orders'],
    [{ kind: 'query', topic: 'odds', marketKey: 'rb:BTC:1d' }, 'Odds for rb:BTC:1d'],
    [{ kind: 'query', topic: 'pnl' }, 'PnL'],
    [{ kind: 'watch', marketKey: 'o:10225' }, 'Watch o:10225'],
    [{ kind: 'unknown', reason: 'Not a trading command' }, 'Not a trading command'],
  ])('%o → %s', (intent, want) => {
    expect(describeIntent(intent)).toBe(want);
  });

  it('uses market names and side labels when a lookup is given', () => {
    const lookup = (key: string) =>
      key === 'rb:BTC:1d'
        ? { short: 'BTC > 61,509 · daily', sides: ['Yes', 'No'] as [string, string] }
        : undefined;
    expect(
      describeIntent({ kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 20 }, lookup),
    ).toBe('Buy YES · BTC > 61,509 · daily for $20');
  });
});
