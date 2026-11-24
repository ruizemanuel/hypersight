import { EventEmitter } from 'node:events';
import {
  type AccountView,
  buildAccountView,
  type ClearinghouseLike,
  type SpotLike,
} from './account';
import type { PerpMeta } from './ids';
import { type Catalogue, parseOutcomeMetaEvent } from './outcomes';

export type Level = { px: number; sz: number };
export type Book = { bids: Level[]; asks: Level[] };

type Unsub = { unsubscribe(): Promise<void> };
type Addr = `0x${string}`;

/** The InfoClient calls the stream needs (structural, so tests can fake them). */
export type StreamInfo = {
  clearinghouseState(p: { user: Addr }): Promise<ClearinghouseLike>;
  spotClearinghouseState(p: { user: Addr }): Promise<SpotLike>;
  allMids(): Promise<Record<string, string>>;
  l2Book(p: { coin: string }): Promise<{
    levels: [{ px: string; sz: string }[], { px: string; sz: string }[]];
  } | null>;
  outcomeMeta(): Promise<unknown>;
  outcomeTemplates(): Promise<unknown>;
};

/** The SubscriptionClient calls the stream needs. Payloads are treated as untrusted. */
export type StreamSubs = {
  clearinghouseState(
    p: { user: Addr; dex?: string },
    l: (e: { clearinghouseState: ClearinghouseLike }) => void,
  ): Promise<Unsub>;
  spotState(p: { user: Addr }, l: (e: { spotState: SpotLike }) => void): Promise<Unsub>;
  allMids(l: (e: { mids: Record<string, string> }) => void): Promise<Unsub>;
  orderUpdates(p: { user: Addr }, l: (e: unknown) => void): Promise<Unsub>;
  userFills(
    p: { user: Addr },
    l: (e: { fills: unknown[]; isSnapshot?: true }) => void,
  ): Promise<Unsub>;
  outcomeMetaUpdates(l: (e: unknown) => void): Promise<Unsub>;
};

/**
 * Live market + account state. Events: `view` (AccountView, coalesced), `fill` (one per new fill),
 * `order` (raw order update), `outcomeMeta` (one per catalogue update).
 */
export interface MarketSource extends EventEmitter {
  readonly catalogue: Catalogue;
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  view(): AccountView;
  mids(): Record<string, string>;
  book(coin: string): Promise<Book>;
  /** Fills of the UTC day of `now` (the recap card). */
  todayFills(now: number): unknown[];
}

export type MarketStreamDeps = {
  info: StreamInfo;
  subs: StreamSubs;
  /** Master address (never the agent's). */
  user: string;
  catalogue: Catalogue;
  perpMeta: PerpMeta[];
  abstraction: string;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
};

/** Account changes reach the HUD within 250 ms; mid-only ticks at most once a second. */
const ACCOUNT_DELAY_MS = 250;
const MIDS_DELAY_MS = 1000;
/** Outcome events missed during a WS reconnect are not replayed: reload the catalogue. */
const CATALOGUE_REFRESH_MS = 10 * 60_000;
/** Recurring markets rotate at 03:00 UTC; settlement lands ~10 s later. */
const ROTATION_HOUR_UTC = 3;
const ROTATION_SETTLE_MS = 15_000;
const DAY_MS = 86_400_000;

const EMPTY_CH: ClearinghouseLike = {
  marginSummary: { accountValue: '0', totalMarginUsed: '0' },
  crossMarginSummary: { accountValue: '0' },
  crossMaintenanceMarginUsed: '0',
  withdrawable: '0',
  assetPositions: [],
};

function msUntilNextRotation(now: number): number {
  const d = new Date(now);
  let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ROTATION_HOUR_UTC);
  next += ROTATION_SETTLE_MS;
  if (next <= now) next += 86_400_000;
  return next - now;
}

export class MarketStream extends EventEmitter implements MarketSource {
  readonly catalogue: Catalogue;
  private readonly deps: MarketStreamDeps;
  private readonly now: () => number;
  private readonly user: Addr;
  private ch: ClearinghouseLike = EMPTY_CH;
  private spot: SpotLike = { balances: [] };
  private midsState: Record<string, string> = {};
  private current: AccountView;
  private subs: Unsub[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline = Number.POSITIVE_INFINITY;
  private running = false;
  /** Recent fills (snapshot + stream), for the day recap; trimmed to the last two days. */
  private fills: { time: number; fill: unknown }[] = [];

  constructor(deps: MarketStreamDeps) {
    super();
    this.deps = deps;
    this.catalogue = deps.catalogue;
    this.now = deps.now ?? Date.now;
    this.user = deps.user as Addr;
    this.current = this.compute() ?? buildEmpty(deps, this.now());
  }

  async start(): Promise<void> {
    const { info, subs } = this.deps;
    const user = this.user;
    const [ch, spot, mids] = await Promise.all([
      info.clearinghouseState({ user }),
      info.spotClearinghouseState({ user }),
      info.allMids(),
    ]);
    this.ch = ch;
    this.spot = spot;
    this.midsState = { ...mids };
    this.current = this.compute() ?? this.current;
    this.running = true;

    // Subscription callbacks run inside the SDK's event dispatch: a throw there would be an
    // uncaught exception and take the server down, so every callback is guarded.
    this.subs = await Promise.all([
      subs.clearinghouseState({ user, dex: '' }, (e) =>
        this.guard('clearinghouseState', () => {
          if (!e?.clearinghouseState?.assetPositions) return;
          this.ch = e.clearinghouseState;
          this.schedule(ACCOUNT_DELAY_MS);
        }),
      ),
      subs.spotState({ user }, (e) =>
        this.guard('spotState', () => {
          if (!Array.isArray(e?.spotState?.balances)) return;
          this.spot = e.spotState;
          this.schedule(ACCOUNT_DELAY_MS);
        }),
      ),
      subs.allMids((e) =>
        this.guard('allMids', () => {
          if (!e?.mids) return;
          Object.assign(this.midsState, e.mids);
          this.schedule(MIDS_DELAY_MS);
        }),
      ),
      subs.orderUpdates({ user }, (e) =>
        this.guard('orderUpdates', () => {
          if (this.running) this.safeEmit('order', e);
        }),
      ),
      subs.userFills({ user }, (e) =>
        this.guard('userFills', () => {
          if (!this.running || !Array.isArray(e?.fills)) return;
          this.keepFills(e.fills);
          // The snapshot is history: only new fills are events (alerts).
          if (e.isSnapshot) return;
          for (const f of e.fills) this.safeEmit('fill', f);
        }),
      ),
      subs.outcomeMetaUpdates((e) =>
        this.guard('outcomeMetaUpdates', () => {
          if (!this.running) return;
          for (const u of parseOutcomeMetaEvent(e)) {
            this.catalogue.apply(u);
            this.safeEmit('outcomeMeta', u);
          }
          this.schedule(ACCOUNT_DELAY_MS);
        }),
      ),
    ]);
    this.scheduleRefresh();
  }

  /** Re-reads account state and mids over REST (menu "Refresh", or after a missed push). */
  async refresh(): Promise<void> {
    const { info } = this.deps;
    const user = this.user;
    const [ch, spot, mids] = await Promise.all([
      info.clearinghouseState({ user }),
      info.spotClearinghouseState({ user }),
      info.allMids(),
    ]);
    this.ch = ch;
    this.spot = spot;
    this.midsState = { ...this.midsState, ...mids };
    const view = this.compute();
    if (!view) return;
    this.current = view;
    this.safeEmit('view', view);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.timer = null;
    this.refreshTimer = null;
    const subs = this.subs;
    this.subs = [];
    await Promise.allSettled(subs.map((s) => s.unsubscribe()));
  }

  view(): AccountView {
    return this.current;
  }

  mids(): Record<string, string> {
    return this.midsState;
  }

  /** Fills of `now`'s UTC day, oldest first (realized PnL for the recap card). */
  todayFills(now: number): unknown[] {
    const start = Math.floor(now / DAY_MS) * DAY_MS;
    return this.fills.filter((f) => f.time >= start && f.time < start + DAY_MS).map((f) => f.fill);
  }

  private keepFills(fills: unknown[]): void {
    for (const f of fills) {
      const time = Number((f as { time?: unknown } | null)?.time);
      if (Number.isFinite(time)) this.fills.push({ time, fill: f });
    }
    const cutoff = this.now() - 2 * DAY_MS;
    this.fills = this.fills.filter((f) => f.time >= cutoff).sort((a, b) => a.time - b.time);
  }

  async book(coin: string): Promise<Book> {
    const res = await this.deps.info.l2Book({ coin });
    const toLevels = (side: { px: string; sz: string }[] | undefined): Level[] =>
      (side ?? []).map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
    return { bids: toLevels(res?.levels[0]), asks: toLevels(res?.levels[1]) };
  }

  /** Coalesces updates: the timer is only moved earlier, never pushed back, so a busy feed cannot starve it. */
  private schedule(delayMs: number): void {
    if (!this.running) return;
    const due = this.now() + delayMs;
    if (this.timer && due >= this.deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.deadline = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadline = Number.POSITIVE_INFINITY;
      if (!this.running) return;
      const view = this.compute();
      if (!view) return;
      this.current = view;
      this.safeEmit('view', view);
    }, delayMs);
  }

  /** Every 10 min, and ~15 s after each 03:00 UTC rotation, whichever comes first. */
  private scheduleRefresh(): void {
    if (!this.running) return;
    const delay = Math.min(CATALOGUE_REFRESH_MS, msUntilNextRotation(this.now()));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.running) return;
      this.catalogue
        .load(this.deps.info)
        .then(() => this.schedule(ACCOUNT_DELAY_MS))
        .catch((err) => this.deps.log?.('[hl] catalogue refresh failed', err))
        .finally(() => this.scheduleRefresh());
    }, delay);
  }

  private compute(): AccountView | null {
    try {
      return buildAccountView({
        clearinghouse: this.ch,
        spot: this.spot,
        mids: this.midsState,
        catalogue: this.catalogue,
        perpMeta: this.deps.perpMeta,
        abstraction: this.deps.abstraction,
        now: this.now(),
      });
    } catch (err) {
      this.deps.log?.('[hl] account view failed', err);
      return null;
    }
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.log?.(`[hl] ${what} update failed`, err);
    }
  }

  private safeEmit(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (err) {
      this.deps.log?.(`[hl] ${event} listener failed`, err);
    }
  }
}

function buildEmpty(deps: MarketStreamDeps, now: number): AccountView {
  return buildAccountView({
    clearinghouse: EMPTY_CH,
    spot: { balances: [] },
    mids: {},
    catalogue: deps.catalogue,
    perpMeta: deps.perpMeta,
    abstraction: deps.abstraction,
    now,
  });
}
