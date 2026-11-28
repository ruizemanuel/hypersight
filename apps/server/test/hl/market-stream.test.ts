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
  outcomeMeta: vi.fn(async () => ({ outcomes: [hawksSpec], questions: [] })),
  outcomeTemplates: vi.fn(async () => []),
};

const hawksSpec = {
  outcome: 24274,
  name: 'Hawks v Mavericks',
  description: 'free text',
  sideSpecs: [{ name: 'Hawks' }, { name: 'Mavericks' }],
};

function make() {
  const f = fakeSubs();
  const catalogue = new Catalogue();
  catalogue.reset({ outcomes: [hawksSpec], questions: [] }, []);
  const stream = new MarketStream({
    info,
    subs: f.subs,
    user: USER,
    catalogue,
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

  it('re-reads account state on refresh (menu "Refresh") and emits a view', async () => {
    const { stream } = make();
    await stream.start();
    const views: AccountView[] = [];
    stream.on('view', (v: AccountView) => views.push(v));
    const ch = info.clearinghouseState;
    info.clearinghouseState = async () => ({ ...clearinghouse, assetPositions: [] }) as never;
    try {
      await stream.refresh();
    } finally {
      info.clearinghouseState = ch;
    }
    expect(views).toHaveLength(1);
    expect(stream.view().perps).toEqual([]);
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

  it("keeps today's fills, from the snapshot and the stream, for the day recap", async () => {
    const day = Date.UTC(2026, 10, 24);
    // Fills older than two days are pruned against the clock: pin it to the day under test.
    vi.setSystemTime(day + 3_600_000);
    const { stream, emit } = make();
    await stream.start();
    emit('userFills', {
      user: USER,
      isSnapshot: true,
      fills: [
        { coin: 'ETH', time: day - 60_000 },
        { coin: 'BTC', time: day + 60_000 },
      ],
    });
    emit('userFills', { user: USER, fills: [{ coin: '#271531', time: day + 120_000 }] });
    expect(stream.todayFills(day + 3_600_000).map((f) => (f as { coin: string }).coin)).toEqual([
      'BTC',
      '#271531',
    ]);
    expect(stream.todayFills(day + 86_400_000 + 1)).toEqual([]);
  });

  it('keeps each fill once when a reconnect replays the snapshot', async () => {
    const day = Date.UTC(2026, 10, 24);
    vi.setSystemTime(day + 3_600_000);
    const { stream, emit } = make();
    await stream.start();
    const snapshot = [
      { coin: 'ETH', tid: 11, time: day + 60_000 },
      { coin: 'SOL', tid: 12, time: day + 120_000 },
    ];
    emit('userFills', { user: USER, isSnapshot: true, fills: snapshot });
    emit('userFills', { user: USER, fills: [{ coin: 'BTC', tid: 13, time: day + 180_000 }] });
    // The SDK resubscribes after a dropped socket and Hyperliquid sends the snapshot again.
    emit('userFills', {
      user: USER,
      isSnapshot: true,
      fills: [...snapshot, { coin: 'BTC', tid: 13, time: day + 180_000 }],
    });
    expect(stream.todayFills(day + 3_600_000).map((f) => (f as { tid: number }).tid)).toEqual([
      11, 12, 13,
    ]);
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

  it.each([
    ['SDK shape', { updates: [{ outcomeSettled: { outcome: 24274 } }] }],
    ['documented shape', [{ outcomeSettled: 24274 }]],
  ])('removes a settled market from the %s of outcomeMetaUpdates', async (_name, event) => {
    const { stream, emit } = make();
    await stream.start();
    expect(stream.catalogue.byOutcome(24274)).toBeDefined();
    emit('outcomeMetaUpdates', event);
    expect(stream.catalogue.byOutcome(24274)).toBeUndefined();
  });

  it('survives a throwing listener and a malformed push', async () => {
    const { stream, emit } = make();
    await stream.start();
    stream.on('fill', () => {
      throw new Error('listener bug');
    });
    expect(() => emit('userFills', { user: USER, fills: [{ coin: 'ETH' }] })).not.toThrow();
    expect(() => emit('outcomeMetaUpdates', { updates: 'garbage' })).not.toThrow();
    expect(() => emit('clearinghouseState', { nope: true })).not.toThrow();
    stream.on('view', () => {
      throw new Error('listener bug');
    });
    emit('spotState', { user: USER, spotState: spot });
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  });

  it('reloads the outcome catalogue periodically (missed updates are not replayed)', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 23, 12, 0));
    const { stream } = make();
    const before = (info.outcomeMeta as ReturnType<typeof vi.fn>).mock.calls.length;
    await stream.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    expect((info.outcomeMeta as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      before,
    );
    await stream.stop();
  });

  it('reloads the catalogue shortly after the 03:00 UTC daily rotation', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 24, 2, 58));
    const { stream } = make();
    const before = (info.outcomeMeta as ReturnType<typeof vi.fn>).mock.calls.length;
    await stream.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 20_000);
    expect((info.outcomeMeta as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      before,
    );
    await stream.stop();
  });
});
