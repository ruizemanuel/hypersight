import type { CardModel } from '@hypersight/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeckCache,
  type HudEvent,
  type HudState,
  hudReducer,
  initialHudState,
  offlineOverlayFor,
  pageFor,
  step,
} from '../src/state/hud-state';

const card = (id: string, actions = 0): CardModel => ({
  id,
  kind: id === 'account' ? 'account' : 'perp',
  title: id.toUpperCase(),
  value: '$1',
  lines: [],
  hint: 'TAP actions · HOLD speak',
  badge: 'TESTNET',
  actions: Array.from({ length: actions }, (_, i) => ({
    id: `a${i}`,
    label: `Action ${i}`,
    intent: { kind: 'closePerp' as const, coin: 'ETH', fraction: 0.5 },
  })),
});

const deck = [card('account'), card('perp:ETH', 3), card('perp:SOL', 3)];

function run(events: HudEvent[], from: HudState = { ...initialHudState, status: 'open' }) {
  let state = from;
  const effects = [];
  for (const ev of events) {
    const r = step(state, ev);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

describe('hudReducer navigation', () => {
  it('moves down and up through the deck, clamped at both ends', () => {
    let s = hudReducer({ ...initialHudState, status: 'open' }, { type: 'deck', cards: deck });
    s = hudReducer(s, { type: 'down' });
    s = hudReducer(s, { type: 'down' });
    s = hudReducer(s, { type: 'down' });
    expect(s.index).toBe(2);
    s = hudReducer(s, { type: 'up' });
    s = hudReducer(s, { type: 'up' });
    s = hudReducer(s, { type: 'up' });
    expect(s.index).toBe(0);
  });

  it('stays on the same card when a new deck inserts a card before it', () => {
    const { state } = run([{ type: 'deck', cards: deck }, { type: 'down' }]);
    expect(state.cards[state.index]?.id).toBe('perp:ETH');
    const next = hudReducer(state, {
      type: 'deck',
      cards: [card('account'), card('opos:1:0', 2), card('perp:ETH', 3), card('perp:SOL', 3)],
    });
    expect(next.cards[next.index]?.id).toBe('perp:ETH');
  });

  it('clamps the index when the current card disappears', () => {
    const { state } = run([{ type: 'deck', cards: deck }, { type: 'down' }, { type: 'down' }]);
    const next = hudReducer(state, { type: 'deck', cards: [card('account')] });
    expect(next.index).toBe(0);
  });
});

describe('hudReducer actions', () => {
  it('opens the actions list on tap and goes back on double tap', () => {
    const opened = run([{ type: 'deck', cards: deck }, { type: 'down' }, { type: 'tap' }]).state;
    expect(opened.mode).toBe('actions');
    expect(hudReducer(opened, { type: 'doubleTap' }).mode).toBe('deck');
  });

  it('ignores a tap on a card without actions', () => {
    expect(run([{ type: 'deck', cards: deck }, { type: 'tap' }]).state.mode).toBe('deck');
  });

  it('sends the selected action and returns to the deck', () => {
    const { state, effects } = run([
      { type: 'deck', cards: deck },
      { type: 'down' },
      { type: 'tap' },
      { type: 'listSelect', index: 1 },
    ]);
    expect(effects).toEqual([
      { type: 'send', msg: { t: 'action', cardId: 'perp:ETH', actionId: 'a1' } },
    ]);
    expect(state.mode).toBe('deck');
  });

  it('maps contextual menu items to server actions', () => {
    const { effects } = run([
      { type: 'menu', id: 2 },
      { type: 'menu', id: 3 },
      { type: 'menu', id: 4 },
    ]);
    expect(effects.map((e) => (e.type === 'send' ? e.msg : e))).toEqual([
      { t: 'action', cardId: 'menu', actionId: 'cancelAll' },
      { t: 'action', cardId: 'menu', actionId: 'refresh' },
      { t: 'action', cardId: 'menu', actionId: 'modeInfo' },
    ]);
  });
});

describe('hudReducer exit card', () => {
  it('opens the exit card on a root double tap, exits on tap, stays on double tap', () => {
    const opened = run([{ type: 'deck', cards: deck }, { type: 'doubleTap' }]).state;
    expect(opened.mode).toBe('exit');
    expect(hudReducer(opened, { type: 'doubleTap' }).mode).toBe('deck');
    const r = step(opened, { type: 'tap' });
    expect(r.effects).toEqual([{ type: 'exit' }]);
    expect(r.state.exiting).toBe(true);
  });

  it('ignores input while the system dialog is up and returns when it is cancelled', () => {
    const exiting = run([{ type: 'doubleTap' }, { type: 'tap' }]).state;
    expect(run([{ type: 'down' }, { type: 'tap' }], exiting).effects).toEqual([]);
    const back = hudReducer(exiting, { type: 'foregroundExit' });
    expect(back).toMatchObject({ exiting: false, mode: 'deck' });
  });

  it('recovers when the shutdown call fails (no permanent lock)', () => {
    const exiting = run([{ type: 'doubleTap' }, { type: 'tap' }]).state;
    expect(hudReducer(exiting, { type: 'exitFailed' })).toMatchObject({
      exiting: false,
      mode: 'deck',
    });
  });

  it('allows exiting from the setup screen', () => {
    const setup = { ...initialHudState, status: 'setup' as const };
    expect(run([{ type: 'doubleTap' }, { type: 'tap' }], setup).effects).toEqual([
      { type: 'exit' },
    ]);
  });
});

describe('hudReducer overlays and link status', () => {
  const confirm = {
    kind: 'confirm' as const,
    proposal: { id: 'p1', title: 'CLOSE 50% ETH LONG', lines: [], expiresAt: 10_000 },
  };

  it('confirms on tap and cancels on double tap', () => {
    const shown = run([{ type: 'overlay', overlay: confirm, at: 0 }]).state;
    expect(step(shown, { type: 'tap' }).effects).toEqual([
      { type: 'send', msg: { t: 'confirm', proposalId: 'p1' } },
    ]);
    const cancelled = step(shown, { type: 'doubleTap' });
    expect(cancelled.effects).toEqual([{ type: 'send', msg: { t: 'cancel', proposalId: 'p1' } }]);
    expect(cancelled.state.overlay).toBeNull();
  });

  it('does not navigate the deck while an overlay is shown', () => {
    const { state } = run([
      { type: 'deck', cards: deck },
      { type: 'overlay', overlay: { kind: 'thinking' }, at: 0 },
      { type: 'down' },
    ]);
    expect(state.index).toBe(0);
  });

  it('switches to "sending" on the confirm tap and ignores taps until the result', () => {
    const shown = run([{ type: 'overlay', overlay: confirm, at: 0 }]).state;
    const tapped = step(shown, { type: 'tap' });
    expect(tapped.effects).toEqual([{ type: 'send', msg: { t: 'confirm', proposalId: 'p1' } }]);
    expect(tapped.state.overlay).toEqual({ kind: 'thinking', sending: true });
    expect(step(tapped.state, { type: 'tap' }).effects).toEqual([]);
    expect(step(tapped.state, { type: 'doubleTap' }).effects).toEqual([]);
    expect(step(tapped.state, { type: 'doubleTap' }).state.overlay).toEqual({
      kind: 'thinking',
      sending: true,
    });
  });

  it('lets an order be slow, then says to check positions (never "try again")', () => {
    const sending = run([
      { type: 'overlay', overlay: { kind: 'thinking', sending: true }, at: 0 },
    ]).state;
    expect(step(sending, { type: 'tick', now: 30_000 }).state.overlay).toEqual({
      kind: 'thinking',
      sending: true,
    });
    expect(step(sending, { type: 'tick', now: 61_000 }).state.overlay).toEqual({
      kind: 'error',
      message: 'No answer — check your positions',
    });
  });

  it('dismisses a result on tap', () => {
    const r = run([
      { type: 'overlay', overlay: { kind: 'result', ok: true, title: 'FILLED', lines: [] }, at: 0 },
      { type: 'tap' },
    ]);
    expect(r.effects).toEqual([{ type: 'send', msg: { t: 'dismiss' } }]);
    expect(r.state.overlay).toBeNull();
  });

  // Thinking must never trap the glasses, whoever sent it.
  it('dismisses a thinking overlay on double tap', () => {
    const r = run([
      { type: 'overlay', overlay: { kind: 'thinking' }, at: 0 },
      { type: 'doubleTap' },
    ]);
    expect(r.state.overlay).toBeNull();
    expect(r.effects).toEqual([{ type: 'send', msg: { t: 'dismiss' } }]);
  });

  it('dismisses a listening overlay that reaches the deck (voice idle) on double tap', () => {
    const r = run([
      { type: 'overlay', overlay: { kind: 'listening', transcript: 'close' }, at: 0 },
      { type: 'doubleTap' },
    ]);
    expect(r.state.overlay).toBeNull();
  });

  it('keeps the listening source and start time when server partials arrive', () => {
    const { state } = run([
      {
        type: 'overlay',
        overlay: { kind: 'listening', transcript: '', source: 'menu' },
        at: 1_000,
      },
      { type: 'overlay', overlay: { kind: 'listening', transcript: 'close half' }, at: 3_000 },
    ]);
    expect(state.overlay).toEqual({ kind: 'listening', transcript: 'close half', source: 'menu' });
    expect(state.overlayAt).toBe(1_000);
  });

  it('turns a thinking overlay older than 15 s into "No answer — try again"', () => {
    const shown = run([{ type: 'overlay', overlay: { kind: 'thinking' }, at: 1_000 }]).state;
    expect(step(shown, { type: 'tick', now: 15_999 }).state.overlay).toEqual({ kind: 'thinking' });
    expect(step(shown, { type: 'tick', now: 16_001 }).state.overlay).toEqual({
      kind: 'error',
      message: 'No answer — try again',
    });
  });

  it('auto-dismisses a result after 4 s and tells the server', () => {
    const result = { kind: 'result' as const, ok: true, title: 'Filled 0.25 @ 3411', lines: [] };
    const shown = run([{ type: 'overlay', overlay: result, at: 1_000 }]).state;
    expect(step(shown, { type: 'tick', now: 4_900 }).state.overlay).toEqual(result);
    const later = step(shown, { type: 'tick', now: 5_100 });
    expect(later.state.overlay).toBeNull();
    expect(later.effects).toEqual([{ type: 'send', msg: { t: 'dismiss' } }]);
  });

  it('ignores a confirm card that already expired (replayed after a reconnect)', () => {
    const stale = {
      kind: 'confirm' as const,
      proposal: { id: 'p0', title: 'CLOSE 50% ETH LONG', lines: [], expiresAt: 5_000 },
    };
    expect(run([{ type: 'overlay', overlay: stale, at: 6_000 }]).state.overlay).toBeNull();
    expect(run([{ type: 'overlay', overlay: stale, at: 4_000 }]).state.overlay).toEqual(stale);
  });

  it('turns a tap that could not be sent into "Offline — nothing sent"', () => {
    expect(offlineOverlayFor({ t: 'confirm', proposalId: 'p1' })).toEqual({
      kind: 'error',
      message: 'Offline — nothing sent',
    });
    expect(offlineOverlayFor({ t: 'action', cardId: 'perp:ETH', actionId: 'c50' })).toEqual({
      kind: 'error',
      message: 'Offline — nothing sent',
    });
    expect(offlineOverlayFor({ t: 'dismiss' })).toBeNull();
  });

  it('leaves other overlays alone on tick', () => {
    const shown = run([{ type: 'overlay', overlay: confirm, at: 0 }]).state;
    expect(step(shown, { type: 'tick', now: 60_000 }).state).toBe(shown);
  });

  it('reconnects on tap after being replaced, and probes on foreground', () => {
    const replaced = run([
      { type: 'deck', cards: deck },
      { type: 'status', status: 'replaced' },
    ]).state;
    expect(step(replaced, { type: 'tap' }).effects).toEqual([{ type: 'reconnect' }]);
    expect(run([{ type: 'foregroundEnter' }]).effects).toEqual([{ type: 'probe' }]);
  });
});

describe('pageFor', () => {
  it('shows connecting, the current card, actions, overlays and the exit card', () => {
    const val = (s: HudState) => pageFor(s, 0).texts.find((t) => t.name === 'val')?.text;
    expect(val({ ...initialHudState })).toBe('Connecting…');
    const withDeck = run([{ type: 'deck', cards: deck }, { type: 'down' }]).state;
    expect(pageFor(withDeck, 0).texts.find((t) => t.name === 'hdr')?.text).toBe(
      'PERP:ETH · TESTNET · 2/3',
    );
    expect(pageFor(hudReducer(withDeck, { type: 'tap' }), 0).layoutKey).toBe('actions');
    expect(val(hudReducer(withDeck, { type: 'doubleTap' }))).toBe('Exit HyperSight?');
    expect(val({ ...withDeck, status: 'replaced' })).toBe('Opened on another device');
  });

  it('marks a cached deck offline until the socket is open', () => {
    const cached = run([{ type: 'deck', cards: deck }], {
      ...initialHudState,
      status: 'connecting',
    }).state;
    expect(pageFor(cached, 0).texts.find((t) => t.name === 'hdr')?.text).toContain('offline');
  });

  it('keeps a cached deck marked offline after welcome until the server sends a fresh one', () => {
    const hdr = (s: HudState) => pageFor(s, 0).texts.find((t) => t.name === 'hdr')?.text;
    const cachedThenOpen = run(
      [
        { type: 'deck', cards: deck, cached: true },
        { type: 'status', status: 'open' },
      ],
      { ...initialHudState, status: 'connecting' },
    ).state;
    expect(hdr(cachedThenOpen)).toContain('offline');
    const fresh = hudReducer(cachedThenOpen, { type: 'deck', cards: deck });
    expect(hdr(fresh)).toBe('ACCOUNT · TESTNET · 1/3');
  });
});

describe('createDeckCache', () => {
  function memory(initial = '') {
    let value = initial;
    return {
      get: vi.fn(async () => value),
      set: vi.fn(async (_k: string, v: string) => {
        value = v;
        return true;
      }),
      read: () => value,
    };
  }

  it('round-trips a deck through storage with a debounced save', async () => {
    vi.useFakeTimers();
    const storage = memory();
    const cache = createDeckCache(storage);
    cache.save(deck);
    cache.save(deck);
    expect(storage.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.set.mock.calls[0]?.[0]).toBe('hs.deck');
    vi.useRealTimers();
    expect(await createDeckCache(storage).load()).toEqual(deck);
  });

  it('returns null for an empty or corrupt value', async () => {
    expect(await createDeckCache(memory('')).load()).toBeNull();
    expect(await createDeckCache(memory('{not json')).load()).toBeNull();
    expect(await createDeckCache(memory('[{"id":1}]')).load()).toBeNull();
  });
});
