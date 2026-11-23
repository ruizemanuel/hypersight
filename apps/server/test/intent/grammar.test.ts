import type { Intent } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import type { AccountView } from '../../src/hl/account';
import { Catalogue } from '../../src/hl/outcomes';
import { buildIntentContext, keytermsFor } from '../../src/intent/aliases';
import { type IntentContext, parseIntentFast, parseNumberWords } from '../../src/intent/grammar';

const markets: IntentContext['markets'] = [
  {
    key: 'rb:BTC:1d',
    short: 'BTC > 61,509 · daily',
    sides: ['Yes', 'No'],
    aliases: ['btc', 'bitcoin', 'daily'],
  },
  {
    key: 'rb:HYPE:1d',
    short: 'HYPE > 60.855 · daily',
    sides: ['Yes', 'No'],
    aliases: ['hype', 'hyperliquid', 'daily'],
  },
  {
    key: 'o:24274',
    short: 'Hawks v Mavericks',
    sides: ['Hawks', 'Mavericks'],
    aliases: ['hawks', 'mavericks', 'nba', 'atlanta', 'dallas'],
  },
  {
    key: 'o:10225',
    short: 'June Fed rate change',
    sides: ['Change', 'No change'],
    aliases: ['june', 'fed', 'rate', 'change'],
  },
];

const base: IntentContext = {
  perpCoins: ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE'],
  positions: [{ coin: 'ETH' }, { coin: 'SOL' }],
  outcomePositions: [{ marketKey: 'o:24274', sideIndex: 0 }],
  markets,
};

const oneSol: IntentContext = { ...base, positions: [{ coin: 'SOL' }] };

describe('parseIntentFast', () => {
  it.each<[string, Intent | null, IntentContext?]>([
    ['close half my eth', { kind: 'closePerp', coin: 'ETH', fraction: 0.5 }],
    ['close my bitcoin', { kind: 'closePerp', coin: 'BTC', fraction: 1 }],
    ['close fifty percent of eth', { kind: 'closePerp', coin: 'ETH', fraction: 0.5 }],
    ['close fifteen percent of eth', { kind: 'closePerp', coin: 'ETH', fraction: 0.15 }],
    ['close a quarter of my sol', { kind: 'closePerp', coin: 'SOL', fraction: 0.25 }],
    ['long sol fifty dollars', { kind: 'openPerp', coin: 'SOL', side: 'long', usd: 50 }],
    [
      'short eth 100 at 3x',
      { kind: 'openPerp', coin: 'ETH', side: 'short', usd: 100, leverage: 3 },
    ],
    [
      'buy twenty dollars of yes on the bitcoin daily',
      { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 20 },
    ],
    ['buy 25 on hawks', { kind: 'buyOutcome', marketKey: 'o:24274', sideIndex: 0, usd: 25 }],
    [
      'buy ten dollars of no on the bitcoin daily',
      { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 1, usd: 10 },
    ],
    [
      'sell half my hawks',
      { kind: 'sellOutcome', marketKey: 'o:24274', sideIndex: 0, fraction: 0.5 },
    ],
    ['cancel all', { kind: 'cancelAll' }],
    ['cancel all orders', { kind: 'cancelAll' }],
    ["what's my pnl", { kind: 'query', topic: 'pnl' }],
    ['odds on the fed', { kind: 'query', topic: 'odds', marketKey: 'o:10225' }],
    ['stop eth at 3200', { kind: 'setStop', coin: 'ETH', triggerPx: 3200 }],
    ['Close half my ETH.', { kind: 'closePerp', coin: 'ETH', fraction: 0.5 }],
    [
      'Buy $20 of YES on the Bitcoin Daily.',
      { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 20 },
    ],
    ['Long SOL, 50 dollars.', { kind: 'openPerp', coin: 'SOL', side: 'long', usd: 50 }],
    ['What are the odds on HYPE?', { kind: 'query', topic: 'odds', marketKey: 'rb:HYPE:1d' }],
    ['tell me a joke', null],
    ['close half', { kind: 'closePerp', coin: 'SOL', fraction: 0.5 }, oneSol],
    ['close half', null],
    ['watch the fed', { kind: 'watch', marketKey: 'o:10225' }],
    ["what's the price of bitcoin", { kind: 'query', topic: 'price', coin: 'BTC' }],
    ["what's my balance", { kind: 'query', topic: 'balance' }],
    [
      'Long ETH $1,000 at 2x',
      { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 1000, leverage: 2 },
    ],
  ])('%s', (text, expected, ctx = base) => {
    expect(parseIntentFast(text, ctx)).toEqual(expected);
  });

  it('leaves ambiguous or incomplete commands to the LLM', () => {
    expect(parseIntentFast('buy on the bitcoin daily', base)).toBeNull(); // no amount
    expect(parseIntentFast('buy 20 on the daily', base)).toBeNull(); // BTC or HYPE daily?
    expect(parseIntentFast('buy 20 on the bitcoin daily', base)).toBeNull(); // which side?
    expect(parseIntentFast('long sol', base)).toBeNull(); // no amount
    expect(parseIntentFast('close two hundred percent of eth', base)).toBeNull();
  });

  it('never invents an amount from the leverage', () => {
    expect(parseIntentFast('long eth at 5x', base)).toBeNull();
  });
});

describe('parseNumberWords', () => {
  it.each<[string, number | null]>([
    ['20', 20],
    ['$20', 20],
    ['20 bucks', 20],
    ['twenty', 20],
    ['twenty five', 25],
    ['one hundred', 100],
    ['a hundred', 100],
    ['fifteen', 15],
    ['two thousand five hundred', 2500],
    ['3.5', 3.5],
    ['$1,250', 1250],
    ['nothing here', null],
  ])('%s → %s', (s, want) => {
    expect(parseNumberWords(s)).toBe(want);
  });
});

describe('buildIntentContext', () => {
  const catalogue = new Catalogue();
  catalogue.reset(
    {
      outcomes: [
        {
          outcome: 27321,
          name: 'Recurring',
          description:
            'class:priceBinary|underlying:BTC|expiry:20261124-0300|targetPrice:60511|period:1d',
          sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
        },
        {
          outcome: 10225,
          name: 'June Fed rate change',
          description: 'Resolves to Change if…',
          sideSpecs: [{ name: 'Change' }, { name: 'No change' }],
        },
      ],
      questions: [],
    },
    [],
  );
  const view = {
    perps: [{ coin: 'ETH' }],
    outcomes: [],
  } as unknown as AccountView;

  it('builds aliases from the underlying, the period, side labels and title keywords', () => {
    // The Fed market has no expiry, so it is in context only because it is watched.
    const ctx = buildIntentContext(view, catalogue, ['rb:BTC:1d', 'o:10225'], {
      now: Date.UTC(2026, 10, 23),
    });
    const btc = ctx.markets.find((m) => m.key === 'rb:BTC:1d');
    expect(btc?.aliases).toEqual(expect.arrayContaining(['btc', 'bitcoin', 'daily']));
    const fed = ctx.markets.find((m) => m.key === 'o:10225');
    expect(fed?.aliases).toEqual(expect.arrayContaining(['fed', 'rate', 'change']));
    expect(fed?.aliases).not.toContain('no');
    expect(ctx.positions).toEqual([{ coin: 'ETH' }]);
    expect(ctx.perpCoins).toEqual(expect.arrayContaining(['BTC', 'ETH', 'SOL', 'HYPE']));
  });

  it('feeds speech-to-text keyterms within provider limits', () => {
    const terms = keytermsFor(buildIntentContext(view, catalogue, ['rb:BTC:1d']));
    expect(terms).toEqual(expect.arrayContaining(['Hyperliquid', 'BTC', 'ETH', 'SOL', 'HYPE']));
    expect(terms.length).toBeLessThanOrEqual(50);
    expect(terms.every((t) => t.length <= 20)).toBe(true);
  });
});
