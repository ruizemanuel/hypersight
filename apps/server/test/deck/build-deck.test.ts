import { CardModelSchema, DEFAULT_PRESETS } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { buildDeck } from '../../src/deck/build-deck';
import type { AccountView, OutcomePosition, PerpPosition } from '../../src/hl/account';
import type { OutcomeMarket } from '../../src/hl/outcomes';

const NOW = Date.UTC(2026, 10, 23, 12, 0);

const btcDaily: OutcomeMarket = {
  key: 'rb:BTC:1d',
  outcome: 27321,
  title: 'BTC above 60,511 at Nov 24 03:00 UTC?',
  short: 'BTC > 60,511 · daily',
  sides: ['Yes', 'No'],
  expiresAt: Date.UTC(2026, 10, 24, 3, 0),
  category: 'price',
  recurring: { underlying: 'BTC', period: '1d' },
};
const ethDaily: OutcomeMarket = {
  ...btcDaily,
  key: 'rb:ETH:1d',
  outcome: 27322,
  title: 'ETH above 1,708.9 at Nov 24 03:00 UTC?',
  short: 'ETH > 1,708.9 · daily',
  recurring: { underlying: 'ETH', period: '1d' },
};
const hawks: OutcomeMarket = {
  key: 'o:24274',
  outcome: 24274,
  title: 'NBA Preseason: Atlanta Hawks v Dallas Mavericks',
  short: 'Hawks v Mavericks',
  sides: ['Hawks', 'Mavericks'],
  expiresAt: Date.UTC(2026, 10, 25, 6, 0),
  category: 'sports',
};

const ethLong: PerpPosition = {
  coin: 'ETH',
  size: 0.5,
  entryPx: 3326.8,
  markPx: 3411,
  upnlUsd: 42.1,
  roe: 0.031,
  leverage: 2,
  isCross: true,
  liqPx: 2950,
  szDecimals: 4,
};

const hawksYes: OutcomePosition = {
  market: hawks,
  sideIndex: 0,
  shares: 40,
  entryUsd: 24.8,
  mid: 0.62,
  valueUsd: 24.8,
  upnlUsd: 0,
  maxPayoutUsd: 40,
};

const view = (over: Partial<AccountView> = {}): AccountView => ({
  equityUsd: 999.73,
  perpUpnlUsd: 0,
  marginRatio: 0,
  marginUsage: 0,
  perpWithdrawableUsd: 0,
  spotUsdc: 999.73,
  perps: [],
  outcomes: [],
  abstraction: 'unifiedAccount',
  updatedAt: NOW,
  ...over,
});

const mids = { '#273210': '0.593705', '#273211': '0.406295', '#273220': '0.4', '#273221': '0.6' };

const deck = (v: AccountView, watch: OutcomeMarket[] = [btcDaily, ethDaily]) =>
  buildDeck({ view: v, watch, mids, presets: DEFAULT_PRESETS, badge: 'TESTNET', now: NOW });

describe('buildDeck', () => {
  it('shows a perp position with value, liquidation and close presets', () => {
    const card = deck(view({ perps: [ethLong] })).find((c) => c.id === 'perp:ETH');
    expect(card).toMatchObject({ kind: 'perp', title: 'ETH LONG 2×', value: '+$42.10 (+3.1%)' });
    expect(card?.lines.some((l) => l.includes('liq $2,950'))).toBe(true);
    expect(card?.actions.map((a) => a.label)).toEqual(['Close 25%', 'Close 50%', 'Close all']);
    expect(card?.actions[1]?.intent).toEqual({ kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
  });

  it('labels a short and a position without liquidation price', () => {
    const card = deck(view({ perps: [{ ...ethLong, size: -0.5, liqPx: null, upnlUsd: -3 }] })).find(
      (c) => c.id === 'perp:ETH',
    );
    expect(card?.title).toBe('ETH SHORT 2×');
    expect(card?.value.startsWith('−$3.00')).toBe(true);
    expect(card?.lines.join(' ')).not.toContain('liq $');
  });

  it('never shows a blank deck for a fresh account', () => {
    const cards = deck(view());
    expect(cards.map((c) => c.id)).toEqual(['account', 'empty', 'mkt:rb:BTC:1d', 'mkt:rb:ETH:1d']);
    const empty = cards.find((c) => c.id === 'empty');
    expect(empty?.hint).toBe('HOLD to speak · TAP for markets');
    expect(empty?.actions.length).toBeGreaterThan(0);
    expect(empty?.actions[0]?.intent).toMatchObject({
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
    });
  });

  it('orders account, perps, outcome positions, then watched markets', () => {
    const ids = deck(view({ perps: [ethLong], outcomes: [hawksYes] })).map((c) => c.id);
    expect(ids).toEqual(['account', 'perp:ETH', 'opos:24274:0', 'mkt:rb:BTC:1d', 'mkt:rb:ETH:1d']);
  });

  it('offers sell presets on an outcome position', () => {
    const card = deck(view({ outcomes: [hawksYes] })).find((c) => c.id === 'opos:24274:0');
    expect(card).toMatchObject({ kind: 'outcomePosition', title: 'Hawks v Mavericks' });
    expect(card?.value).toContain('Hawks 62%');
    expect(card?.actions.map((a) => a.label)).toEqual(['Sell half', 'Sell all']);
    expect(card?.actions[0]?.intent).toEqual({
      kind: 'sellOutcome',
      marketKey: 'o:24274',
      sideIndex: 0,
      fraction: 0.5,
    });
  });

  it('shows a watched market with odds and outcome buy presets', () => {
    const card = deck(view()).find((c) => c.id === 'mkt:rb:BTC:1d');
    expect(card).toMatchObject({ kind: 'market', title: 'BTC > 60,511 · daily', value: 'YES 59%' });
    expect(card?.actions.map((a) => a.label)).toEqual([
      'Buy YES $5',
      'Buy YES $10',
      'Buy YES $25',
      'Buy NO $10',
    ]);
    expect(card?.actions[3]?.intent).toEqual({
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 1,
      usd: 10,
    });
    expect(card?.lines.join(' ')).toContain('in 15h 00m');
  });

  it('uses team names on sports market buttons and shows a dash without a mid', () => {
    const card = deck(view(), [hawks]).find((c) => c.id === 'mkt:o:24274');
    expect(card?.value).toBe('Hawks —');
    expect(card?.actions.map((a) => a.label)).toContain('Buy Mavericks $10');
  });

  it('keeps every card within protocol limits', () => {
    const longTeams: OutcomeMarket = {
      ...hawks,
      key: 'o:1',
      outcome: 1,
      sides: ['Nottingham Forest', 'Wolverhampton Wanderers'],
    };
    const cards = deck(view({ perps: [ethLong], outcomes: [hawksYes] }), [btcDaily, longTeams]);
    for (const c of cards) {
      expect(() => CardModelSchema.parse(c)).not.toThrow();
      expect(c.lines.length).toBeLessThanOrEqual(3);
      for (const a of c.actions) expect(a.label.length).toBeLessThanOrEqual(24);
      expect(c.badge).toBe('TESTNET');
    }
  });

  it('gives every action a unique id within its card (actions are looked up by id)', () => {
    for (const c of [...deck(view()), ...deck(view({ perps: [ethLong], outcomes: [hawksYes] }))]) {
      const ids = c.actions.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('shows equity and open PnL on the account card', () => {
    const card = deck(view({ equityUsd: 1042.5, perps: [ethLong], perpUpnlUsd: 42.1 })).find(
      (c) => c.id === 'account',
    );
    expect(card?.value).toBe('$1,042.50');
    expect(card?.lines[0]).toBe('Open PnL +$42.10');
  });

  it('shows margin used (committed margin), not the maintenance ratio', () => {
    const card = deck(view({ marginUsage: 0.258, marginRatio: 0.03 })).find(
      (c) => c.id === 'account',
    );
    expect(card?.lines[1]).toBe('Margin used 25.8%');
  });
});
