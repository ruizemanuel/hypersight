import type { Intent } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import outcomeMetaFixture from '../../../../fixtures/hl/outcomeMeta.json';
import templatesFixture from '../../../../fixtures/hl/outcomeTemplates.json';
import type { AccountView } from '../../src/hl/account';
import { Catalogue, type OutcomeMetaLike, type OutcomeTemplateLike } from '../../src/hl/outcomes';
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
    ['Take profit on half of my ether.', { kind: 'closePerp', coin: 'ETH', fraction: 0.5 }],
    ['take profits on my sol', { kind: 'closePerp', coin: 'SOL', fraction: 1 }],
    ['how much profit am I making', { kind: 'query', topic: 'pnl' }],
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

  const onlyEth: IntentContext = { ...base, positions: [{ coin: 'ETH' }] };
  const coreCoinsOnlyEth: IntentContext = { ...onlyEth, perpCoins: ['BTC', 'ETH', 'SOL', 'HYPE'] };

  // Phase 3 review I1: every number fills exactly one slot, and anything unclear goes to the LLM.
  it.each<[string, Intent | null, IntentContext?]>([
    ['close three quarters of my eth', { kind: 'closePerp', coin: 'ETH', fraction: 0.75 }],
    ['close two thirds of my eth', { kind: 'closePerp', coin: 'ETH', fraction: 0.667 }],
    ['close fifteen per cent of eth', { kind: 'closePerp', coin: 'ETH', fraction: 0.15 }],
    ['close one quarter of my sol', { kind: 'closePerp', coin: 'SOL', fraction: 0.25 }],
    ['close my eth long', { kind: 'closePerp', coin: 'ETH', fraction: 1 }],
    ['close 15 of my eth', null],
    ['close 0.5 eth', null],
    ['close my eth at 3400', null],
    ['close half my eth and sol', null],
    ['sell 10 shares of my hawks', null],
    ['long sol one fifty', null],
    ['stop eth at twenty nine fifty', null],
    ['stop eth at twenty nine hundred', { kind: 'setStop', coin: 'ETH', triggerPx: 2900 }],
    ['stop half my eth at 3000', null],
    ['long eth 100 dollars with a stop at 3000', null],
    [
      'long eth 5 leverage 50 dollars',
      { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 50, leverage: 5 },
    ],
    ['long eth 3x leverage 5', null],
    ['long eth 50 dollars 20', null],
    ['buy no on hawks for 20', null],
    ['buy yes on hawks for 20', null],
    ['buy 20 dollars of yes no on the bitcoin daily', null],
    [
      'buy 20 dollars of no change on the fed',
      { kind: 'buyOutcome', marketKey: 'o:10225', sideIndex: 1, usd: 20 },
    ],
    [
      'buy 20 dollars of change on the fed',
      { kind: 'buyOutcome', marketKey: 'o:10225', sideIndex: 0, usd: 20 },
    ],
    ["don't close my eth", null],
    ['never close my eth', null],
    ['do not close my eth', null],
    ['close half my eth if the price is above 3000', null],
    ['close half my doge', null, coreCoinsOnlyEth],
    ['close half', { kind: 'closePerp', coin: 'ETH', fraction: 0.5 }, onlyEth],
    ['cancel all 3 orders', null],
    ["what's my pnl on 5", null],
  ])('%s', (text, expected, ctx = base) => {
    expect(parseIntentFast(text, ctx)).toEqual(expected);
  });
});

// Phase 3 review I2: the real catalogue has price-bucket markets that share the daily's aliases.
describe('parseIntentFast with the captured testnet catalogue', () => {
  const now = Date.UTC(2026, 10, 23, 12);
  const catalogue = new Catalogue({ now: () => now });
  catalogue.reset(
    outcomeMetaFixture as unknown as OutcomeMetaLike,
    templatesFixture as unknown as OutcomeTemplateLike[],
  );
  const view = { perps: [{ coin: 'ETH' }], outcomes: [] } as unknown as AccountView;
  const ctx = buildIntentContext(view, catalogue, ['rb:BTC:1d', 'rb:ETH:1d'], { now });

  it('has the BTC price buckets in context (the case that used to tie)', () => {
    expect(ctx.markets.map((m) => m.key)).toEqual(
      expect.arrayContaining(['rb:BTC:1d', 'rq:BTC:1d:0', 'rq:BTC:1d:1', 'rq:BTC:1d:2']),
    );
  });

  it.each<[string, Intent | null]>([
    [
      'buy twenty dollars of yes on the bitcoin daily',
      { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 20 },
    ],
    ['odds on the bitcoin daily', { kind: 'query', topic: 'odds', marketKey: 'rb:BTC:1d' }],
    [
      'buy 20 dollars of yes on bitcoin below 60,375',
      { kind: 'buyOutcome', marketKey: 'rq:BTC:1d:0', sideIndex: 0, usd: 20 },
    ],
    [
      'buy 20 dollars of no on bitcoin between 60375 and 62840',
      { kind: 'buyOutcome', marketKey: 'rq:BTC:1d:1', sideIndex: 1, usd: 20 },
    ],
    ['odds on bitcoin 62,840 or above', { kind: 'query', topic: 'odds', marketKey: 'rq:BTC:1d:2' }],
    ['odds on bitcoin above 60511', { kind: 'query', topic: 'odds', marketKey: 'rb:BTC:1d' }],
    ['odds on bitcoin above', null], // the daily (> 60,511) or the top bucket?
    ['buy 20 dollars of yes on bitcoin above 99999', null], // no market at that price
  ])('%s', (text, expected) => {
    expect(parseIntentFast(text, ctx)).toEqual(expected);
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
    ['twenty five hundred', 2500],
    ['fifteen hundred', 1500],
    ['one hundred and five', 105],
    ['between sixty thousand and sixty two thousand', 60000],
    ['one fifty', null],
    ['twenty nine fifty', null],
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
