import type { AlertRule } from '@hypersight/protocol';
import type { AccountView } from '../hl/account';
import { outcomeCoin } from '../hl/ids';
import type { Catalogue } from '../hl/outcomes';
import {
  type AlertEvent,
  evaluateFill,
  evaluateRule,
  type FillLike,
  type OddsHistory,
  type RuleContext,
  type Snapshot,
} from './rules';

/** The market-stream surface the engine listens to (structural, so tests can fake it). */
export type AlertSource = {
  view(): AccountView;
  mids(): Record<string, string>;
  on(event: 'view' | 'fill' | 'outcomeMeta', l: (arg: unknown) => void): unknown;
  off(event: 'view' | 'fill' | 'outcomeMeta', l: (arg: unknown) => void): unknown;
};

export type AlertEngineDeps = {
  stream: AlertSource;
  rules: { list(): AlertRule[] };
  catalogue: Pick<Catalogue, 'byKey' | 'byOutcome'>;
  push: (ev: AlertEvent) => void;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
};

const SNAPSHOT_KINDS = new Set(['priceCross', 'oddsMove', 'pnlPct', 'liqDistance']);
const FILL_KINDS = new Set(['fill', 'settled']);
/** Odds history kept per watched outcome (longest sensible oddsMove window). */
const HISTORY_MS = 60 * 60_000;

/**
 * Evaluates the user's rules on every account/mids update and every fill, with a cooldown per
 * rule, and pushes alerts. An alert only suggests; its action goes through the normal confirm.
 */
export class AlertEngine {
  private prev: Snapshot | null = null;
  private readonly odds: OddsHistory = new Map();
  private readonly lastFired = new Map<string, number>();
  private readonly now: () => number;
  private readonly ctx: RuleContext;
  private readonly onView = () => this.guard('view', () => this.evaluateSnapshot());
  private readonly onFill = (f: unknown) => this.guard('fill', () => this.evaluateFill(f));

  constructor(private readonly deps: AlertEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.ctx = {
      market: (key) => deps.catalogue.byKey(key),
      byOutcome: (o) => deps.catalogue.byOutcome(o),
    };
  }

  start(): void {
    this.deps.stream.on('view', this.onView);
    this.deps.stream.on('outcomeMeta', this.onView);
    this.deps.stream.on('fill', this.onFill);
  }

  stop(): void {
    this.deps.stream.off('view', this.onView);
    this.deps.stream.off('outcomeMeta', this.onView);
    this.deps.stream.off('fill', this.onFill);
  }

  private evaluateSnapshot(): void {
    const now = this.now();
    const rules = this.deps.rules.list().filter((r) => r.enabled && SNAPSHOT_KINDS.has(r.kind));
    // Copied: a source that updates its mids in place would make prev === next (no crossing).
    const next: Snapshot = {
      view: this.deps.stream.view(),
      mids: { ...this.deps.stream.mids() },
      oddsHistory: this.odds,
    };
    for (const rule of rules) {
      const ev = evaluateRule(rule, this.prev, next, now, this.ctx);
      if (ev) this.fire(rule, ev, now);
    }
    this.recordOdds(rules, next.mids, now);
    this.prev = { ...next, oddsHistory: this.odds };
  }

  private evaluateFill(fill: unknown): void {
    if (typeof fill !== 'object' || fill === null) return;
    const now = this.now();
    for (const rule of this.deps.rules.list()) {
      if (!rule.enabled || !FILL_KINDS.has(rule.kind)) continue;
      const ev = evaluateFill(rule, fill as FillLike, this.ctx);
      if (ev) this.fire(rule, ev, now);
    }
  }

  /** History is only kept for markets an oddsMove rule watches. */
  private recordOdds(rules: AlertRule[], mids: Record<string, string>, now: number): void {
    for (const rule of rules) {
      if (rule.kind !== 'oddsMove') continue;
      const m = this.deps.catalogue.byKey(String(rule.params.marketKey ?? ''));
      if (!m) continue;
      const coin = outcomeCoin(m.outcome, 0);
      const p = Number(mids[coin]);
      if (!Number.isFinite(p)) continue;
      const list = (this.odds.get(coin) ?? []).filter((h) => now - h.t <= HISTORY_MS);
      if (list.at(-1)?.p !== p) list.push({ t: now, p });
      this.odds.set(coin, list);
    }
  }

  private fire(rule: AlertRule, ev: AlertEvent, now: number): void {
    const last = this.lastFired.get(rule.id);
    if (last !== undefined && now - last < rule.cooldownMs) return;
    this.lastFired.set(rule.id, now);
    try {
      this.deps.push(ev);
    } catch (err) {
      this.deps.log?.(`[alerts] push failed for ${rule.id}`, err);
    }
  }

  /** Stream listeners run inside the SDK's event dispatch: a throw must never escape. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.log?.(`[alerts] ${what} evaluation failed`, err);
    }
  }
}
