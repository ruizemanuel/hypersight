import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AccountView,
  buildAccountView,
  type ClearinghouseLike,
  type SpotLike,
} from './account';
import { type PerpMeta, parsePerpMeta } from './ids';
import type { Book, MarketSource } from './market-stream';
import type { Catalogue, OutcomeMetaLike, OutcomeTemplateLike } from './outcomes';

export type FixtureStreamDeps = {
  catalogue: Catalogue;
  /** Directory with the captured Hyperliquid responses (default: the repo's fixtures/hl). */
  dir?: string;
  /** How often the scripted ETH walk moves (+0.2% each step). */
  stepMs?: number;
  now?: () => number;
};

const DEFAULT_DIR = fileURLToPath(new URL('../../../../fixtures/hl/', import.meta.url));
const STEP_MS = 2000;
const STEP = 1.002;
const PERP_SPREAD = 0.0005;
const OUTCOME_TICK = 0.01;
const DEPTH = 1000;

/**
 * Captured testnet state (account, spot, mids, meta, outcomes) with a scripted ETH price walk:
 * the same surface as MarketStream, for the simulator end-to-end test and a repeatable demo.
 * Nothing here talks to Hyperliquid.
 */
export class FixtureMarketStream extends EventEmitter implements MarketSource {
  readonly catalogue: Catalogue;
  private readonly dir: string;
  private readonly now: () => number;
  private ch: ClearinghouseLike | null = null;
  private spot: SpotLike = { balances: [] };
  private midsState: Record<string, string> = {};
  private meta: PerpMeta[] = [];
  private current: AccountView | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: FixtureStreamDeps) {
    super();
    this.catalogue = deps.catalogue;
    this.dir = deps.dir ?? DEFAULT_DIR;
    this.now = deps.now ?? Date.now;
  }

  private read<T>(name: string): T {
    return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
  }

  async start(): Promise<void> {
    this.ch = this.read<ClearinghouseLike>('clearinghouseState.json');
    this.spot = this.read<SpotLike>('spotState.json');
    this.midsState = { ...this.read<Record<string, string>>('allMids.json') };
    this.meta = parsePerpMeta(this.read('meta.json'));
    this.catalogue.reset(
      this.read<OutcomeMetaLike>('outcomeMeta.json'),
      this.read<OutcomeTemplateLike[]>('outcomeTemplates.json'),
    );
    this.current = this.compute();
    this.timer = setInterval(() => this.step(), this.deps.stepMs ?? STEP_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    this.current = this.compute();
    this.emit('view', this.current);
  }

  /** Perp metadata from the captured `meta` (index.ts shares it with proposals and executor). */
  perpMeta(): PerpMeta[] {
    return this.meta;
  }

  view(): AccountView {
    if (!this.current) throw new Error('fixture stream not started');
    return this.current;
  }

  mids(): Record<string, string> {
    return this.midsState;
  }

  async book(coin: string): Promise<Book> {
    const mid = Number(this.midsState[coin]);
    if (!Number.isFinite(mid) || mid <= 0) return { bids: [], asks: [] };
    if (coin.startsWith('#')) {
      const bid = Math.max(OUTCOME_TICK, Math.floor(mid * 100) / 100 - OUTCOME_TICK);
      const ask = Math.min(1 - OUTCOME_TICK, Math.ceil(mid * 100) / 100 + OUTCOME_TICK);
      return { bids: [{ px: round(bid), sz: DEPTH }], asks: [{ px: round(ask), sz: DEPTH }] };
    }
    return {
      bids: [{ px: mid * (1 - PERP_SPREAD), sz: DEPTH }],
      asks: [{ px: mid * (1 + PERP_SPREAD), sz: DEPTH }],
    };
  }

  /** The fixtures carry no fills. */
  todayFills(_now: number): unknown[] {
    return [];
  }

  private step(): void {
    const eth = Number(this.midsState.ETH);
    if (Number.isFinite(eth)) this.midsState = { ...this.midsState, ETH: String(eth * STEP) };
    this.current = this.compute();
    this.emit('view', this.current);
  }

  private compute(): AccountView {
    return buildAccountView({
      clearinghouse: this.ch as ClearinghouseLike,
      spot: this.spot,
      mids: this.midsState,
      catalogue: this.catalogue,
      perpMeta: this.meta,
      abstraction: 'unifiedAccount',
      now: this.now(),
    });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
