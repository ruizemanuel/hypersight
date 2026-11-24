import type { AlertRule, Intent } from '@hypersight/protocol';
import { fmtPct, fmtPrice, fmtUsd } from '../deck/format';
import type { AccountView, PerpPosition } from '../hl/account';
import { outcomeCoin } from '../hl/ids';
import type { OutcomeMarket } from '../hl/outcomes';

/** Odds history per outcome side coin (`#enc`): keyed by the outcome actually trading, so a daily
 * rotation starts a fresh history instead of faking a move. */
export type OddsHistory = Map<string, { t: number; p: number }[]>;

export type Snapshot = {
  view: AccountView;
  mids: Record<string, string>;
  oddsHistory: OddsHistory;
};

export type AlertEvent = {
  ruleId: string;
  title: string;
  lines: string[];
  action?: Intent;
  /** Cooldown key when one rule can raise several alerts (one per position); else the rule id. */
  key?: string;
};

export type RuleContext = {
  market(key: string): OutcomeMarket | undefined;
  byOutcome(outcome: number): OutcomeMarket | undefined;
};

/** The subset of a `userFills` entry the alert rules read. */
export type FillLike = {
  coin?: unknown;
  dir?: unknown;
  side?: unknown;
  sz?: unknown;
  px?: unknown;
  closedPnl?: unknown;
  crossed?: unknown;
};

const num = (v: unknown): number =>
  typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** "your rule: take half" — suggestions are always phrased as the user's own rule. */
export function ruleVerb(action: Intent): string {
  switch (action.kind) {
    case 'closePerp':
      return action.fraction >= 1
        ? `close ${action.coin}`
        : action.fraction === 0.5
          ? 'take half'
          : action.fraction === 0.25
            ? 'take a quarter'
            : `close ${Math.round(action.fraction * 100)}%`;
    case 'sellOutcome':
      return action.fraction >= 1
        ? 'sell all'
        : action.fraction === 0.5
          ? 'sell half'
          : 'sell some';
    case 'setStop':
      return `stop at ${fmtPrice(action.triggerPx)}`;
    case 'buyOutcome':
      return `buy $${action.usd}`;
    case 'openPerp':
      return `${action.side} $${action.usd}`;
    case 'cancelAll':
      return 'cancel all';
    default:
      return 'review';
  }
}

function withAction(rule: AlertRule, title: string, lines: string[]): AlertEvent {
  const action = rule.action;
  return {
    ruleId: rule.id,
    title,
    lines: action ? [...lines, `your rule: ${ruleVerb(action)}`].slice(0, 3) : lines.slice(0, 3),
    ...(action ? { action } : {}),
  };
}

/** Price move of a position in percent (not leveraged ROE): what "my ETH is up 5%" means. */
function movePct(p: PerpPosition): number | null {
  const basis = Math.abs(p.size) * p.entryPx;
  return basis > 0 ? (p.upnlUsd / basis) * 100 : null;
}

function liqDistancePct(p: PerpPosition): number | null {
  if (p.liqPx === null || p.markPx <= 0) return null;
  return (Math.abs(p.markPx - p.liqPx) / p.markPx) * 100;
}

/** Recurring market titles drop the period: `BTC > 61,509 · daily` → `BTC > 61,509`. */
const marketLabel = (m: OutcomeMarket) => m.short.replace(/ · (daily|hourly|weekly)$/, '');

/**
 * The odds a move is measured from: the price at the start of the window (the last change at or
 * before it — history only stores changes), or the oldest known price when history is younger.
 */
function oddsBase(
  history: { t: number; p: number }[],
  now: number,
  windowMs: number,
): { t: number; p: number } | undefined {
  let base = history[0];
  for (const h of history) {
    if (h.t <= now - windowMs) base = h;
    else break;
  }
  return base;
}

/**
 * Crossing semantics everywhere: a rule fires when the condition becomes true, not while it is.
 * The first snapshot (no `prev`) is not a crossing, except for the liquidation warning: a position
 * already close to liquidation when the server starts must not stay silent.
 */
export function evaluateRule(
  rule: AlertRule,
  prev: Snapshot | null,
  next: Snapshot,
  now: number,
  ctx: RuleContext,
): AlertEvent[] {
  if (!rule.enabled) return [];
  const p = rule.params;
  if (rule.kind === 'liqDistance') {
    const pct = num(p.pct);
    if (!Number.isFinite(pct)) return [];
    const events: AlertEvent[] = [];
    for (const pos of next.view.perps) {
      const b = liqDistancePct(pos);
      if (b === null || b >= pct) continue;
      const before = prev?.view.perps.find((x) => x.coin === pos.coin);
      const a = before ? liqDistancePct(before) : null;
      if (a !== null && a < pct) continue;
      events.push({
        ...withAction(rule, `${pos.coin} ${Math.round(b)}% from liquidation`, [
          `mark ${fmtPrice(pos.markPx)} · liq ${fmtPrice(pos.liqPx as number)}`,
        ]),
        key: `${rule.id}:${pos.coin}`,
      });
    }
    return events;
  }
  if (!prev) return [];
  const ev = crossing(rule, prev, next, now, ctx);
  return ev ? [ev] : [];
}

function crossing(
  rule: AlertRule,
  prev: Snapshot,
  next: Snapshot,
  now: number,
  ctx: RuleContext,
): AlertEvent | null {
  const p = rule.params;
  switch (rule.kind) {
    case 'priceCross': {
      const coin = str(p.coin);
      const px = num(p.px);
      if (!coin || !Number.isFinite(px)) return null;
      const a = num(prev.mids[coin]);
      const b = num(next.mids[coin]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const above = p.dir !== 'below';
      const crossed = above ? a < px && b >= px : a > px && b <= px;
      if (!crossed) return null;
      return withAction(rule, `${coin} ${above ? 'above' : 'below'} ${fmtPrice(px)}`, [
        `now ${fmtPrice(b)}`,
      ]);
    }
    case 'oddsMove': {
      const m = ctx.market(String(p.marketKey ?? ''));
      const points = num(p.points);
      const windowMs = num(p.windowMs);
      if (!m || !Number.isFinite(points) || !Number.isFinite(windowMs)) return null;
      const coin = outcomeCoin(m.outcome, 0);
      const pNow = num(next.mids[coin]);
      const base = oddsBase(next.oddsHistory.get(coin) ?? [], now, windowMs);
      if (!base || !Number.isFinite(pNow)) return null;
      const delta = Math.round((pNow - base.p) * 100);
      if (Math.abs(delta) < points) return null;
      // Fires on entering the moved state only: still moved from the same base is not news.
      const pPrev = num(prev.mids[coin]);
      if (Number.isFinite(pPrev) && Math.abs(Math.round((pPrev - base.p) * 100)) >= points)
        return null;
      const signed = delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
      const ago = Math.round(Math.min(now - base.t, windowMs) / 60_000);
      return withAction(rule, `${marketLabel(m)} · ${Math.round(pNow * 100)}% (${signed})`, [
        `was ${Math.round(base.p * 100)}% ${ago} min ago`,
      ]);
    }
    case 'pnlPct': {
      const coin = str(p.coin);
      const pct = num(p.pct);
      if (!coin || !Number.isFinite(pct)) return null;
      const before = prev.view.perps.find((x) => x.coin === coin);
      const after = next.view.perps.find((x) => x.coin === coin);
      const a = before ? movePct(before) : null;
      const b = after ? movePct(after) : null;
      if (after === undefined || b === null) return null;
      const crossed =
        pct >= 0 ? (a === null || a < pct) && b >= pct : (a === null || a > pct) && b <= pct;
      if (!crossed) return null;
      return withAction(rule, `${coin} ${fmtPct(b / 100, { sign: true })}`, [
        `PnL ${fmtUsd(after.upnlUsd, { sign: true })}`,
      ]);
    }
    default:
      return null;
  }
}

/**
 * Fill-driven rules. `settled`: the synthetic `dir: "Settlement"` fill (spike §5; px = payout per
 * share). `fill`: only resting orders (`crossed: false`) — immediate fills already showed a result.
 */
export function evaluateFill(rule: AlertRule, fill: FillLike, ctx: RuleContext): AlertEvent | null {
  if (!rule.enabled || typeof fill !== 'object' || fill === null) return null;
  const coin = str(fill.coin);
  if (!coin) return null;
  const settlement = fill.dir === 'Settlement';
  if (rule.kind === 'settled') {
    if (!settlement || !coin.startsWith('#')) return null;
    const enc = Number(coin.slice(1));
    const outcome = Math.floor(enc / 10);
    const side = (enc % 10) as 0 | 1;
    const m = ctx.byOutcome(outcome);
    const label = m ? m.sides[side] : side === 0 ? 'Yes' : 'No';
    const shown = /^(yes|no)$/i.test(label) ? label.toUpperCase() : label;
    const payout = num(fill.px);
    const shares = num(fill.sz);
    const won = payout >= 0.5;
    const pnl = num(fill.closedPnl);
    return withAction(
      rule,
      `${shown} ${won ? 'won' : 'lost'} · ${fmtUsd(Number.isFinite(pnl) ? pnl : 0, { sign: true })}`,
      [m?.short ?? `Outcome ${outcome}`, `${shares} shares · paid ${fmtUsd(payout * shares)}`],
    );
  }
  if (rule.kind === 'fill') {
    if (settlement || fill.crossed !== false) return null;
    const side = fill.side === 'B' ? 'Bought' : 'Sold';
    const name = coin.startsWith('#')
      ? (ctx.byOutcome(Math.floor(Number(coin.slice(1)) / 10))?.short ?? coin)
      : coin;
    return withAction(rule, 'Order filled', [
      `${side} ${num(fill.sz)} ${name} @ ${fmtPrice(num(fill.px))}`,
    ]);
  }
  return null;
}
