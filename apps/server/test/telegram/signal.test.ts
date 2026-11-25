import { DEFAULT_PRESETS, type Intent } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import type { IntentContext } from '../../src/intent/grammar';
import { parseSignal } from '../../src/telegram/signal';

const ctx: IntentContext = {
  perpCoins: ['BTC', 'ETH', 'SOL'],
  positions: [{ coin: 'ETH' }],
  outcomePositions: [{ marketKey: 'o:24274', sideIndex: 0 }],
  markets: [
    {
      key: 'rb:BTC:1d',
      short: 'BTC > 61,509 · daily',
      sides: ['Yes', 'No'],
      aliases: ['btc', 'bitcoin', 'daily'],
    },
    {
      key: 'o:10225',
      short: 'June Fed rate change',
      sides: ['Change', 'No change'],
      aliases: ['fed'],
    },
    {
      key: 'o:24274',
      short: 'Hawks v Mavericks',
      sides: ['Hawks', 'Mavericks'],
      aliases: ['hawks', 'mavericks'],
    },
  ],
};

describe('parseSignal', () => {
  it.each<[string, Intent | null]>([
    ['longing ETH here', { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 50, leverage: 2 }],
    ['short sol', { kind: 'openPerp', coin: 'SOL', side: 'short', usd: 50, leverage: 2 }],
    ['Shorted SOL 3x', { kind: 'openPerp', coin: 'SOL', side: 'short', usd: 50, leverage: 2 }],
    ['longeó eth', { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 50, leverage: 2 }],
    [
      'compro yes en bitcoin',
      { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 10 },
    ],
    [
      'buying no change on the fed',
      { kind: 'buyOutcome', marketKey: 'o:10225', sideIndex: 1, usd: 10 },
    ],
    ['closing half my eth', { kind: 'closePerp', coin: 'ETH', fraction: 0.5 }],
    ['selling my hawks', { kind: 'sellOutcome', marketKey: 'o:24274', sideIndex: 0, fraction: 1 }],
    ['eth long closed +12%', { kind: 'closePerp', coin: 'ETH', fraction: 1 }],
    ['compro sí en bitcoin', { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 10 }],
  ])('reads %j as a trade', (text, want) => {
    expect(parseSignal(text, ctx, DEFAULT_PRESETS)).toEqual(want);
  });

  it('sizes from the presets, never from the size or leverage in the message', () => {
    expect(parseSignal('long eth 500 dollars 20x', ctx, DEFAULT_PRESETS)).toEqual({
      kind: 'openPerp',
      coin: 'ETH',
      side: 'long',
      usd: 50,
      leverage: 2,
    });
    const custom = { ...DEFAULT_PRESETS, openUsd: [30], outcomeUsd: [7], defaultLeverage: 3 };
    expect(parseSignal('short sol', ctx, custom)).toMatchObject({ usd: 30, leverage: 3 });
    expect(parseSignal('buying yes on bitcoin', ctx, custom)).toMatchObject({ usd: 7 });
  });

  it('reads a call-out post with entry, targets and leverage as a plain open', () => {
    const post = '🚀 ETH LONG\nEntry: 2450\nTP: 2600 / 2750\nSL: 2400\nLeverage: 10x';
    expect(parseSignal(post, ctx, DEFAULT_PRESETS)).toEqual({
      kind: 'openPerp',
      coin: 'ETH',
      side: 'long',
      usd: 50,
      leverage: 2,
    });
  });

  it.each<[string, Intent]>([
    [
      'ETH long here — not financial advice',
      { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 50, leverage: 2 },
    ],
    [
      'NFA, shorting sol. DYOR',
      { kind: 'openPerp', coin: 'SOL', side: 'short', usd: 50, leverage: 2 },
    ],
    [
      'compro yes en bitcoin (no es consejo financiero)',
      { kind: 'buyOutcome', marketKey: 'rb:BTC:1d', sideIndex: 0, usd: 10 },
    ],
  ])('does not read a disclaimer in %j as a negation', (text, want) => {
    expect(parseSignal(text, ctx, DEFAULT_PRESETS)).toEqual(want);
  });

  it.each([
    ['close btc', 'a coin the user does not hold'],
    ['closing half', 'a close that names no coin'],
    ['selling yes on bitcoin', 'an outcome the user does not hold'],
    ['selling mavericks', 'the other side of an outcome the user holds'],
    ['cancel all orders', 'not a trade'],
    ["don't long eth", 'negated'],
    ['not longing eth here', 'negated'],
    ['no longeo eth', 'negated (Spanish)'],
    ['no compres yes en bitcoin', 'negated (Spanish)'],
    ['no compro yes en bitcoin', 'negated (Spanish, first person)'],
    ['gm everyone', 'chatter'],
    ['what are the odds on the fed', 'a question'],
    ['long eth short btc', 'two trades'],
    ['should I long eth?', 'a question'],
    ['Who is longing ETH', 'a question without a question mark'],
    ['¿longeo eth?', 'a question (Spanish)'],
    ['BTC short-term bullish', 'an idiom (short-term)'],
    ['eth short term bounce likely', 'an idiom (short term)'],
    ['ETH short squeeze incoming', 'an idiom (short squeeze)'],
    ['eth long squeeze', 'an idiom (long squeeze)'],
    ['long live bitcoin', 'an idiom (long live)'],
    ['avoid longing eth here', 'advice against it'],
    ['I would avoid shorting sol', 'advice against it'],
    ['evitaría longear eth', 'advice against it (Spanish)'],
    ['ETH LONG SL hit', 'a status update'],
    ['ETH long TP1 hit 2600 ✅', 'a status update'],
    ['BTC short above 62000 invalidated', 'a status update'],
    ['long eth if it holds 2400', 'a conditional call'],
    ['si btc rompe 62k compro yes', 'a conditional call (Spanish)'],
  ])('ignores %j (%s)', (text) => {
    expect(parseSignal(text, ctx, DEFAULT_PRESETS)).toBeNull();
  });
});
