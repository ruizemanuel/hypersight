/** Structural subset of the SDK's `EvenHubEvent` (the SDK types its envelopes as classes). */
export type HubEventLike = {
  listEvent?: {
    containerID?: number;
    containerName?: string;
    currentSelectItemIndex?: number;
    eventType?: number;
  };
  textEvent?: { containerID?: number; containerName?: string; eventType?: number };
  sysEvent?: { eventType?: number; eventSource?: number };
  audioEvent?: unknown;
  menuItemClickEvent?: { itemID?: number };
};

export type InputEvent =
  | { type: 'tap' | 'doubleTap' | 'up' | 'down' | 'holdStart' | 'holdEnd' }
  | { type: 'menu'; id: number }
  | { type: 'listSelect'; index: number }
  | { type: 'foregroundEnter' | 'foregroundExit' | 'exit' };

/** SDK `OsEventTypeList` values (mirrored so this module stays pure and testable). */
const EV = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7,
  IMU: 8,
  LONG_PRESS: 9,
  LONG_PRESS_RELEASE: 10,
} as const;

const DUPLICATE_MS = 90;
const SAME_SCROLL_MS = 350;
const AFTER_TEXT_UPDATE_MS = 80;

/**
 * CLICK is 0 and protobuf omits zero fields, so a tap arrives with `eventType: undefined`. The
 * default must be resolved inside the envelope check, or every envelope would read as a tap.
 */
function eventTypeOf(envelope?: { eventType?: number }): number | null {
  if (!envelope) return null;
  return envelope.eventType ?? EV.CLICK;
}

export function createInputNormalizer() {
  let lastType: string | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let lastTextUpdateAt = Number.NEGATIVE_INFINITY;

  function classify(ev: HubEventLike): InputEvent | null {
    const itemID = ev.menuItemClickEvent?.itemID;
    if (itemID !== undefined) return { type: 'menu', id: itemID };

    const listType = eventTypeOf(ev.listEvent);
    if (listType === EV.DOUBLE_CLICK) return { type: 'doubleTap' };
    if (listType === EV.CLICK) {
      return { type: 'listSelect', index: ev.listEvent?.currentSelectItemIndex ?? 0 };
    }

    const sys = eventTypeOf(ev.sysEvent);
    const text = eventTypeOf(ev.textEvent);
    const is = (t: number) => sys === t || text === t;
    // Explicit types first, CLICK last.
    if (is(EV.DOUBLE_CLICK)) return { type: 'doubleTap' };
    if (is(EV.SCROLL_TOP)) return { type: 'up' };
    if (is(EV.SCROLL_BOTTOM)) return { type: 'down' };
    if (is(EV.LONG_PRESS)) return { type: 'holdStart' };
    if (is(EV.LONG_PRESS_RELEASE)) return { type: 'holdEnd' };
    if (is(EV.FOREGROUND_ENTER)) return { type: 'foregroundEnter' };
    if (is(EV.FOREGROUND_EXIT)) return { type: 'foregroundExit' };
    if (is(EV.SYSTEM_EXIT) || is(EV.ABNORMAL_EXIT)) return { type: 'exit' };
    if (is(EV.IMU)) return null;
    if (is(EV.CLICK)) return { type: 'tap' };
    return null;
  }

  return {
    normalize(ev: HubEventLike, now: number): InputEvent | null {
      const input = classify(ev);
      if (!input) return null;
      const isScroll = input.type === 'up' || input.type === 'down';
      if (isScroll && now - lastTextUpdateAt < AFTER_TEXT_UPDATE_MS) return null;
      const window = isScroll ? SAME_SCROLL_MS : DUPLICATE_MS;
      const dedupe = input.type !== 'menu' && input.type !== 'listSelect';
      if (dedupe && input.type === lastType && now - lastAt < window) return null;
      lastType = input.type;
      lastAt = now;
      return input;
    },
    /** Call after every text render: the firmware re-layout can emit spurious scroll events. */
    markTextUpdate(now: number): void {
      lastTextUpdateAt = now;
    },
  };
}

export type InputNormalizer = ReturnType<typeof createInputNormalizer>;
