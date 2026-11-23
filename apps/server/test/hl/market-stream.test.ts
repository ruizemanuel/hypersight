import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import clearinghouse from '../../../../fixtures/hl/clearinghouseState.json';
import spot from '../../../../fixtures/hl/spotState.json';
import type { AccountView } from '../../src/hl/account';
import { MarketStream, type StreamInfo, type StreamSubs } from '../../src/hl/market-stream';
import { Catalogue } from '../../src/hl/outcomes';

const USER = '0x1111111111111111111111111111111111111111';

type Listener = (data: unknown) => void;

function fakeSubs() {
  const listeners = new Map<string, Listener>();
  const unsubscribed: string[] = [];
  const sub = (name: string, listener: Listener) => {
    listeners.set(name, listener);
    return Promise.resolve({
      unsubscribe: async () => {
        unsubscribed.push(name);
      },
    });
  };
  const subs: StreamSubs = {
    clearinghouseState: (_p, l) => sub('clearinghouseState', l as Listener),
    spotState: (_p, l) => sub('spotState', l as Listener),
    allMids: (l) => sub('allMids', l as Listener),
    orderUpdates: (_p, l) => sub('orderUpdates', l as Listener),
    userFills: (_p, l) => sub('userFills', l as Listener),
    outcomeMetaUpdates: (l) => sub('outcomeMetaUpdates', l as Listener),
  };
  const emit = (name: string, data: unknown) => listeners.get(name)?.(data);
  return { subs, emit, listeners, unsubscribed };
}

const info: StreamInfo = {
  clearinghouseState: async () => clearinghouse as never,
  spotClearinghouseState: async () => spot as never,
  allMids: async () => ({ ETH: '3411.0' }),
  l2Book: async () => ({
    coin: '#271210',
    time: 1,
    levels: [
      [
        { px: '0.59', sz: '12.0', n: 1 },
        { px: '0.58', sz: '30.0', n: 2 },
      ],
      [{ px: '0.61', sz: '18.0', n: 1 }],
    ],
  }),
};

function make() {
  const f = fakeSubs();
  const stream = new MarketStream({
    info,
    subs: f.subs,
    user: USER,
    catalogue: new Catalogue(),
    perpMeta: [],
    abstraction: 'default',
  });
  return { stream, ...f };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MarketStream', () => {
  it('builds an initial view from REST snapshots on start', async () => {
    const { stream } = make();
    await stream.start();
    expect(stream.view().perps.map((p) => p.coin)).toEqual(['SOL', 'ETH']);
    expect(stream.mids().ETH).toBe('3411.0');
  });

  it('coalesces three clearinghouse pushes within 100 ms into one view event', async () => {
    const { stream, emit } = make();
    await stream.start();
    const views: AccountView[] = [];
    stream.on('view', (v: AccountView) => views.push(v));
    for (let i = 0; i < 3; i++) {
      emit('clearinghouseState', { dex: '', user: USER, clearinghouseState: clearinghouse });
      vi.advanceTimersByTime(30);
    }
    vi.advanceTimersByTime(300);
    expect(views).toHaveLength(1);
  });

  it('still emits views while mids stream continuously (no starvation)', async () => {
    const { stream, emit } = make();
    await stream.start();
    let views = 0;
    stream.on('view', () => views++);
    for (let i = 0; i < 30; i++) {
      emit('allMids', { mids: { ETH: String(3400 + i) } });
      vi.advanceTimersByTime(100);
    }
    expect(views).toBeGreaterThanOrEqual(2);
    expect(stream.mids().ETH).toBe('3429');
  });

  it('applies a spot push to the view', async () => {
    const { stream, emit } = make();
    await stream.start();
    emit('spotState', {
      user: USER,
      spotState: {
        balances: [{ coin: 'USDC', token: 0, total: '42.0', hold: '0.0', entryNtl: '0.0' }],
      },
    });
    vi.advanceTimersByTime(300);
    expect(stream.view().spotUsdc).toBe(42);
  });

  it('emits fills but not the initial snapshot', async () => {
    const { stream, emit } = make();
    await stream.start();
    const fills: unknown[] = [];
    stream.on('fill', (f) => fills.push(f));
    emit('userFills', { user: USER, isSnapshot: true, fills: [{ coin: 'ETH' }] });
    emit('userFills', { user: USER, fills: [{ coin: '#271531', dir: 'Settlement' }] });
    expect(fills).toEqual([{ coin: '#271531', dir: 'Settlement' }]);
  });

  it('applies outcome meta updates to the catalogue and re-emits them', async () => {
    const { stream, emit } = make();
    await stream.start();
    const seen: unknown[] = [];
    stream.on('outcomeMeta', (u) => seen.push(u));
    const spec = {
      outcome: 27153,
      name: 'Recurring',
      description:
        'class:priceBinary|underlying:BTC|expiry:20261121-0300|targetPrice:62452|period:1d',
      sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
    };
    emit('outcomeMetaUpdates', { updates: [{ outcomeCreated: spec }] });
    expect(seen).toEqual([{ outcomeCreated: spec }]);
    expect(stream.catalogue.byKey('rb:BTC:1d')?.outcome).toBe(27153);
  });

  it('reads an order book as numbers', async () => {
    const { stream } = make();
    expect(await stream.book('#271210')).toEqual({
      bids: [
        { px: 0.59, sz: 12 },
        { px: 0.58, sz: 30 },
      ],
      asks: [{ px: 0.61, sz: 18 }],
    });
  });

  it('unsubscribes everything on stop and emits nothing afterwards', async () => {
    const { stream, emit, unsubscribed } = make();
    await stream.start();
    let views = 0;
    stream.on('view', () => views++);
    emit('clearinghouseState', { dex: '', user: USER, clearinghouseState: clearinghouse });
    await stream.stop();
    vi.advanceTimersByTime(2000);
    expect(views).toBe(0);
    expect(unsubscribed.sort()).toEqual(
      [
        'allMids',
        'clearinghouseState',
        'orderUpdates',
        'outcomeMetaUpdates',
        'spotState',
        'userFills',
      ].sort(),
    );
  });
});
