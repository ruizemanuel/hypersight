import {
  type Badge,
  type CardModel,
  CardModelSchema,
  type ClientMsg,
  type Overlay,
} from '@hypersight/protocol';
import { z } from 'zod';
import type { InputEvent } from '../input/normalize';
import {
  layoutActions,
  layoutCard,
  layoutOverlay,
  layoutStatus,
  type PageSpec,
} from '../render/layout';

export type HudStatus =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'replaced'
  | 'unauthorized'
  | 'setup'
  | 'pairing';

export type HudState = {
  cards: CardModel[];
  index: number;
  overlay: Overlay | null;
  /** When the current overlay arrived (listening elapsed time). */
  overlayAt: number;
  mode: 'deck' | 'actions';
  /** The system exit dialog is up: input is ignored until it is answered. */
  exiting: boolean;
  status: HudStatus;
  badge: Badge;
  /** False while the deck on screen is the cached one from a previous run. */
  live: boolean;
  /** Server clock minus phone clock (ms), from `welcome`: confirm deadlines are server times. */
  clockOffset: number;
  /** While pairing: the code to type on the link page and where that page is. */
  pairing?: { code: string; url: string };
};

export type HudEvent =
  /** `at`: when the input happened (phone clock); the confirm card ignores taps right after it shows. */
  | (InputEvent & { at?: number })
  | { type: 'deck'; cards: CardModel[]; cached?: true }
  | { type: 'overlay'; overlay: Overlay | null; at: number }
  | { type: 'status'; status: HudStatus }
  | { type: 'exitFailed' }
  | { type: 'clock'; serverTime: number; at: number }
  | { type: 'pairing'; code: string; url: string }
  /** Once a second: expires overlays that must not stay up forever. */
  | { type: 'tick'; now: number };

/** A Thinking overlay (local or from the server) older than this becomes "No answer". */
export const THINKING_MAX_MS = 15_000;
/** An executing order may take this long before the HUD asks the user to check positions. */
export const SENDING_MAX_MS = 60_000;
/** A tap this soon after a confirm card shows is ignored: a repeated tap must not confirm unread. */
export const CONFIRM_ARM_MS = 600;
/** Results clear themselves (and the server snapshot) after this long. */
export const RESULT_MS = 4_000;

/** What to show when a tap could not be sent (offline): never let it look like it went out. */
export function offlineOverlayFor(msg: ClientMsg): Overlay | null {
  return msg.t === 'confirm' || msg.t === 'action' || msg.t === 'cancel'
    ? { kind: 'error', message: 'Offline — nothing sent' }
    : null;
}

export type Effect =
  | { type: 'send'; msg: ClientMsg }
  | { type: 'exit' }
  | { type: 'reconnect' }
  | { type: 'probe' };

export const initialHudState: HudState = {
  cards: [],
  index: 0,
  overlay: null,
  overlayAt: 0,
  mode: 'deck',
  exiting: false,
  status: 'connecting',
  badge: 'TESTNET',
  live: false,
  clockOffset: 0,
};

/** Contextual menu item ids (1 = Speak is handled by the voice controller). */
const MENU_ACTIONS: Record<number, string> = { 2: 'cancelAll', 3: 'refresh', 4: 'modeInfo' };

type Result = { state: HudState; effects: Effect[] };
const done = (state: HudState, ...effects: Effect[]): Result => ({ state, effects });

/** Statuses that block the deck with a full-screen message. */
function blocking(status: HudStatus): boolean {
  return (
    status === 'replaced' || status === 'unauthorized' || status === 'setup' || status === 'pairing'
  );
}

export function step(s: HudState, ev: HudEvent): Result {
  switch (ev.type) {
    case 'deck': {
      const currentId = s.cards[s.index]?.id;
      const kept = currentId === undefined ? -1 : ev.cards.findIndex((c) => c.id === currentId);
      const index = kept >= 0 ? kept : Math.max(0, Math.min(s.index, ev.cards.length - 1));
      const badge = ev.cards[0]?.badge ?? s.badge;
      const mode = s.mode === 'actions' && kept < 0 ? 'deck' : s.mode;
      return done({ ...s, cards: ev.cards, index, badge, mode, live: ev.cached !== true });
    }
    case 'overlay': {
      // Server partials update the words; the HUD-side source and start time stay.
      const prev = s.overlay;
      if (ev.overlay?.kind === 'listening' && prev?.kind === 'listening') {
        const source = ev.overlay.source ?? prev.source;
        return done({ ...s, overlay: { ...ev.overlay, ...(source ? { source } : {}) } });
      }
      // A confirm replayed after a reconnect may already be dead: never offer it, and tell the
      // server so it clears it too (an alert may be waiting behind it).
      if (
        ev.overlay?.kind === 'confirm' &&
        ev.overlay.proposal.expiresAt <= ev.at + s.clockOffset
      ) {
        return done(prev?.kind === 'confirm' ? { ...s, overlay: null } : s, {
          type: 'send',
          msg: { t: 'cancel', proposalId: ev.overlay.proposal.id },
        });
      }
      return done({ ...s, overlay: ev.overlay, overlayAt: ev.at });
    }
    case 'status':
      return done({ ...s, status: ev.status });
    case 'exitFailed':
      return done({ ...s, exiting: false, mode: 'deck' });
    case 'clock':
      return done({ ...s, clockOffset: ev.serverTime - ev.at });
    case 'pairing':
      return done({ ...s, status: 'pairing', pairing: { code: ev.code, url: ev.url } });
    case 'tick':
      // "No tap → auto-cancel": the server refuses a late confirm anyway; clear it and say so.
      if (s.overlay?.kind === 'confirm' && s.overlay.proposal.expiresAt <= ev.now + s.clockOffset) {
        return done(
          { ...s, overlay: null },
          { type: 'send', msg: { t: 'cancel', proposalId: s.overlay.proposal.id } },
        );
      }
      // An unknown order outcome (CHECK POSITIONS) stays until the user taps it.
      if (s.overlay?.kind === 'result' && !s.overlay.unknown && ev.now - s.overlayAt > RESULT_MS) {
        return done({ ...s, overlay: null }, { type: 'send', msg: { t: 'dismiss' } });
      }
      if (s.overlay?.kind === 'thinking' && s.overlay.sending) {
        return ev.now - s.overlayAt > SENDING_MAX_MS
          ? done({
              ...s,
              overlay: { kind: 'error', message: 'No answer — check your positions' },
              overlayAt: ev.now,
            })
          : done(s);
      }
      if (s.overlay?.kind === 'thinking' && ev.now - s.overlayAt > THINKING_MAX_MS) {
        return done({
          ...s,
          overlay: { kind: 'error', message: 'No answer — try again' },
          overlayAt: ev.now,
        });
      }
      return done(s);
    default:
      return onInput(s, ev);
  }
}

function onInput(s: HudState, ev: InputEvent & { at?: number }): Result {
  if (s.exiting) {
    // FOREGROUND_EXIT while the system dialog is up = the user answered "No".
    return ev.type === 'foregroundExit' ? done({ ...s, exiting: false, mode: 'deck' }) : done(s);
  }
  if (ev.type === 'foregroundEnter') return done(s, { type: 'probe' });
  if (ev.type === 'menu') {
    const actionId = MENU_ACTIONS[ev.id];
    return actionId
      ? done(s, { type: 'send', msg: { t: 'action', cardId: 'menu', actionId } })
      : done(s);
  }

  if (s.overlay) return onOverlayInput(s, s.overlay, ev);

  if (blocking(s.status)) {
    if (ev.type === 'doubleTap') return exit(s);
    if (ev.type === 'tap' && s.status === 'replaced') return done(s, { type: 'reconnect' });
    return done(s);
  }

  const card = s.cards[s.index];
  if (s.mode === 'actions') {
    if (ev.type === 'doubleTap') return done({ ...s, mode: 'deck' });
    if (ev.type === 'listSelect' && card) {
      const action = card.actions[ev.index];
      if (!action) return done(s);
      return done(
        { ...s, mode: 'deck' },
        { type: 'send', msg: { t: 'action', cardId: card.id, actionId: action.id } },
      );
    }
    return done(s);
  }

  switch (ev.type) {
    case 'down':
      return done({ ...s, index: Math.min(s.index + 1, Math.max(0, s.cards.length - 1)) });
    case 'up':
      return done({ ...s, index: Math.max(s.index - 1, 0) });
    case 'tap':
      return card && card.actions.length > 0 ? done({ ...s, mode: 'actions' }) : done(s);
    case 'doubleTap':
      return exit(s);
    default:
      return done(s);
  }
}

/** Root double tap: the system exit dialog asks Yes/No itself (store rule: no exit UI of our own). */
function exit(s: HudState): Result {
  return done({ ...s, exiting: true }, { type: 'exit' });
}

function onOverlayInput(s: HudState, o: Overlay, ev: InputEvent & { at?: number }): Result {
  const cleared = { ...s, overlay: null };
  switch (o.kind) {
    case 'confirm': {
      const proposalId = o.proposal.id;
      if (ev.type === 'doubleTap' || (ev.type === 'tap' && o.proposal.blocked)) {
        return done(cleared, { type: 'send', msg: { t: 'cancel', proposalId } });
      }
      if (ev.type === 'tap' && ev.at !== undefined && ev.at - s.overlayAt < CONFIRM_ARM_MS) {
        return done(s);
      }
      // The card is gone the moment it is confirmed: no second tap, no "cancel" while it executes.
      if (ev.type === 'tap') {
        return done(
          { ...s, overlay: { kind: 'thinking', sending: true } },
          { type: 'send', msg: { t: 'confirm', proposalId } },
        );
      }
      return done(s);
    }
    case 'result':
    case 'error':
      return ev.type === 'tap' || ev.type === 'doubleTap'
        ? done(cleared, { type: 'send', msg: { t: 'dismiss' } })
        : done(s);
    case 'alert':
      if (ev.type === 'tap' && o.action) {
        return done(cleared, {
          type: 'send',
          msg: { t: 'action', cardId: 'alert', actionId: o.action.id },
        });
      }
      return ev.type === 'tap' || ev.type === 'doubleTap'
        ? done(cleared, { type: 'send', msg: { t: 'dismiss' } })
        : done(s);
    case 'thinking':
      if (o.sending) return done(s);
      return ev.type === 'doubleTap'
        ? done(cleared, { type: 'send', msg: { t: 'dismiss' } })
        : done(s);
    default:
      // listening / thinking: the voice controller consumes input while it is active, so a
      // double tap that gets here is the user's way out (slow assistant, stale overlay).
      return ev.type === 'doubleTap'
        ? done(cleared, { type: 'send', msg: { t: 'dismiss' } })
        : done(s);
  }
}

export function hudReducer(s: HudState, ev: HudEvent): HudState {
  return step(s, ev).state;
}

const EXIT_HINT = '2×TAP exit';

export function pageFor(s: HudState, now: number): PageSpec {
  const title = `HyperSight · ${s.badge}`;
  if (s.overlay) {
    // Countdowns run on the server clock; elapsed times stay on the phone clock.
    const clock = s.overlay.kind === 'confirm' ? now + s.clockOffset : now;
    return layoutOverlay(s.overlay, clock, { badge: s.badge, shownAt: s.overlayAt });
  }
  if (s.status === 'replaced') {
    return layoutStatus({
      title,
      value: 'Opened on another device',
      lines: ['Only one device can be connected'],
      hint: 'TAP reconnect · 2×TAP exit',
    });
  }
  if (s.status === 'unauthorized') {
    return layoutStatus({
      title,
      value: 'Token refused',
      lines: ['Paste the current token on the phone'],
      hint: EXIT_HINT,
    });
  }
  if (s.status === 'pairing' && s.pairing) {
    return layoutStatus({
      title,
      value: s.pairing.code,
      lines: [`Pair: open ${s.pairing.url}`, 'on a computer and type this code'],
      hint: EXIT_HINT,
    });
  }
  if (s.status === 'setup') {
    return layoutStatus({
      title,
      value: 'Setup needed',
      lines: ['Paste your server token', 'on the phone screen'],
      hint: EXIT_HINT,
    });
  }
  const card = s.cards[s.index];
  if (!card) {
    const value = s.status === 'open' ? 'Loading your account…' : 'Connecting…';
    return layoutStatus({ title, value, lines: [], hint: EXIT_HINT });
  }
  if (s.mode === 'actions') return layoutActions(card);
  return layoutCard(card, s.index, s.cards.length, { offline: s.status !== 'open' || !s.live });
}

export type DeckStorage = {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<boolean>;
};

const DECK_KEY = 'hs.deck';
const SAVE_DEBOUNCE_MS = 2000;
const DeckSchema = z.array(CardModelSchema);

/** Last deck on the phone, so a cold start shows cards (marked offline) instead of a black screen. */
export function createDeckCache(storage: DeckStorage) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    async load(): Promise<CardModel[] | null> {
      const raw = await storage.get(DECK_KEY).catch(() => '');
      if (!raw) return null;
      try {
        const parsed = DeckSchema.safeParse(JSON.parse(raw));
        return parsed.success && parsed.data.length > 0 ? parsed.data : null;
      } catch {
        return null;
      }
    },
    save(cards: CardModel[]): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void storage.set(DECK_KEY, JSON.stringify(cards)).catch(() => false);
      }, SAVE_DEBOUNCE_MS);
    },
  };
}
