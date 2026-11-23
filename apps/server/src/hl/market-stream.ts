import { EventEmitter } from 'node:events';
import {
  type AccountView,
  buildAccountView,
  type ClearinghouseLike,
  type SpotLike,
} from './account';
import type { PerpMeta } from './ids';
import type { Catalogue, OutcomeMetaUpdate } from './outcomes';

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
};

/** The SubscriptionClient calls the stream needs. */
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
  outcomeMetaUpdates(l: (e: { updates: unknown[] }) => void): Promise<Unsub>;
};

/**
 * Live market + account state. Events: `view` (AccountView, coalesced), `fill` (one per new fill),
 * `order` (raw order update), `outcomeMeta` (one per catalogue update).
 */
export interface MarketSource extends EventEmitter {
  readonly catalogue: Catalogue;
  start(): Promise<void>;
  stop(): Promise<void>;
  view(): AccountView;
  mids(): Record<string, string>;
  book(coin: string): Promise<Book>;
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
};

/** Account changes reach the HUD within 250 ms; mid-only ticks at most once a second. */
const ACCOUNT_DELAY_MS = 250;
const MIDS_DELAY_MS = 1000;

const EMPTY_CH: ClearinghouseLike = {
  marginSummary: { accountValue: '0' },
  crossMarginSummary: { accountValue: '0' },
  crossMaintenanceMarginUsed: '0',
  withdrawable: '0',
  assetPositions: [],
};

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
  private deadline = Number.POSITIVE_INFINITY;
  private running = false;

  constructor(deps: MarketStreamDeps) {
    super();
    this.deps = deps;
    this.catalogue = deps.catalogue;
    this.now = deps.now ?? Date.now;
    this.user = deps.user as Addr;
    this.current = this.compute();
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
    this.current = this.compute();
    this.running = true;

    this.subs = await Promise.all([
      subs.clearinghouseState({ user, dex: '' }, (e) => {
        this.ch = e.clearinghouseState;
        this.schedule(ACCOUNT_DELAY_MS);
      }),
      subs.spotState({ user }, (e) => {
        this.spot = e.spotState;
        this.schedule(ACCOUNT_DELAY_MS);
      }),
      subs.allMids((e) => {
        Object.assign(this.midsState, e.mids);
        this.schedule(MIDS_DELAY_MS);
      }),
      subs.orderUpdates({ user }, (e) => {
        if (this.running) this.emit('order', e);
      }),
      subs.userFills({ user }, (e) => {
        if (!this.running || e.isSnapshot) return;
        for (const f of e.fills) this.emit('fill', f);
      }),
      subs.outcomeMetaUpdates((e) => {
        if (!this.running) return;
        for (const u of e.updates as OutcomeMetaUpdate[]) {
          this.catalogue.apply(u);
          this.emit('outcomeMeta', u);
        }
        this.schedule(ACCOUNT_DELAY_MS);
      }),
    ]);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
      this.current = this.compute();
      this.emit('view', this.current);
    }, delayMs);
  }

  private compute(): AccountView {
    return buildAccountView({
      clearinghouse: this.ch,
      spot: this.spot,
      mids: this.midsState,
      catalogue: this.catalogue,
      perpMeta: this.deps.perpMeta,
      abstraction: this.deps.abstraction,
      now: this.now(),
    });
  }
}
