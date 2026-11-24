import type { Badge, CardModel, Presets, QuickAction } from '@hypersight/protocol';
import type { AccountView, OutcomePosition, PerpPosition } from '../hl/account';
import { outcomeCoin } from '../hl/ids';
import type { OutcomeMarket } from '../hl/outcomes';
import { fmtPct, fmtPrice, fmtProb, fmtSize, fmtUntil, fmtUsd } from './format';

export type DeckInput = {
  view: AccountView;
  watch: OutcomeMarket[];
  mids: Record<string, string>;
  presets: Presets;
  badge: Badge;
  now: number;
  /** Read-only Gram (TON testnet) balance, when TON_ADDRESS is set. */
  gram?: { gram: number } | { error: string };
};

const HINT_ACTIONS = 'TAP actions · HOLD speak';
const HINT_NO_ACTIONS = 'HOLD speak · swipe for cards';
const HINT_EMPTY = 'HOLD to speak · TAP for markets';
const LABEL_MAX = 24;
const MAX_ACTIONS = 5;

function label(text: string): string {
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

/** `Yes`/`No` sides read as `YES`/`NO` on buttons; team names stay as they are. */
function sideLabel(side: string): string {
  return /^(yes|no)$/i.test(side) ? side.toUpperCase() : side;
}

function midOf(mids: Record<string, string>, market: OutcomeMarket, side: 0 | 1): number | null {
  const raw = mids[outcomeCoin(market.outcome, side)];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function prob(mid: number | null): string {
  return mid === null ? '—' : fmtProb(mid);
}

function accountCard(view: AccountView, badge: Badge): CardModel {
  const openPnl = view.perpUpnlUsd + view.outcomes.reduce((s, o) => s + o.upnlUsd, 0);
  const positions = view.perps.length + view.outcomes.length;
  return {
    id: 'account',
    kind: 'account',
    title: 'ACCOUNT',
    value: fmtUsd(view.equityUsd),
    lines: [
      `Open PnL ${fmtUsd(openPnl, { sign: true })}`,
      `Margin used ${fmtPct(view.marginUsage)}`,
      `USDC ${fmtUsd(view.spotUsdc)} · ${positions} open`,
    ],
    hint: HINT_NO_ACTIONS,
    badge,
    actions: [],
  };
}

function closeLabel(fraction: number): string {
  return fraction >= 1 ? 'Close all' : `Close ${Math.round(fraction * 100)}%`;
}

function perpCard(p: PerpPosition, presets: Presets, badge: Badge): CardModel {
  const side = p.size >= 0 ? 'LONG' : 'SHORT';
  const lines = [
    `${fmtSize(p.size, p.szDecimals)} ${p.coin} · ${fmtPrice(p.entryPx)} → ${fmtPrice(p.markPx)}`,
  ];
  if (p.liqPx !== null && p.markPx > 0) {
    const away = Math.abs(p.markPx - p.liqPx) / p.markPx;
    lines.push(`liq $${fmtPrice(p.liqPx)} · ${fmtPct(away)} away`);
  } else {
    lines.push('no liquidation price');
  }
  return {
    id: `perp:${p.coin}`,
    kind: 'perp',
    title: `${p.coin} ${side} ${p.leverage}×`,
    value: `${fmtUsd(p.upnlUsd, { sign: true })} (${fmtPct(p.roe, { sign: true })})`,
    lines,
    hint: HINT_ACTIONS,
    badge,
    actions: presets.closeFractions.slice(0, MAX_ACTIONS).map((fraction) => ({
      id: `close-${Math.round(fraction * 100)}`,
      label: closeLabel(fraction),
      intent: { kind: 'closePerp', coin: p.coin, fraction },
    })),
  };
}

function outcomePositionCard(o: OutcomePosition, badge: Badge, now: number): CardModel {
  const side = o.market.sides[o.sideIndex];
  const lines = [
    `${o.shares} shares · value ${fmtUsd(o.valueUsd)}`,
    `PnL ${fmtUsd(o.upnlUsd, { sign: true })} · pays ${fmtUsd(o.maxPayoutUsd)}`,
  ];
  if (o.market.expiresAt !== undefined) lines.push(`resolves ${fmtUntil(o.market.expiresAt, now)}`);
  const sell = (fraction: number, text: string): QuickAction => ({
    id: `sell-${fraction * 100}`,
    label: text,
    intent: {
      kind: 'sellOutcome',
      marketKey: o.market.key,
      sideIndex: o.sideIndex,
      fraction,
    },
  });
  return {
    id: `opos:${o.market.outcome}:${o.sideIndex}`,
    kind: 'outcomePosition',
    title: o.market.short,
    value: `${side} ${fmtProb(o.mid)}`,
    lines,
    hint: HINT_ACTIONS,
    badge,
    actions: [sell(0.5, 'Sell half'), sell(1, 'Sell all')],
  };
}

function buyAction(
  market: OutcomeMarket,
  side: 0 | 1,
  usd: number,
  withMarket = false,
): QuickAction {
  const base = `Buy ${sideLabel(market.sides[side])} $${usd}`;
  return {
    id: withMarket ? `buy${side}-${usd}-${market.outcome}` : `buy${side}-${usd}`,
    label: label(withMarket ? `${sideLabel(market.sides[side])} $${usd} · ${market.short}` : base),
    intent: { kind: 'buyOutcome', marketKey: market.key, sideIndex: side, usd },
  };
}

function marketCard(m: OutcomeMarket, input: DeckInput): CardModel {
  const { mids, presets, badge, now } = input;
  const yes = midOf(mids, m, 0);
  const no = midOf(mids, m, 1);
  const second = [`${m.sides[1]} ${prob(no)}`];
  if (m.expiresAt !== undefined) second.push(fmtUntil(m.expiresAt, now));
  const middle = presets.outcomeUsd[Math.min(1, presets.outcomeUsd.length - 1)] ?? 10;
  return {
    id: `mkt:${m.key}`,
    kind: 'market',
    title: m.short,
    value: `${sideLabel(m.sides[0])} ${prob(yes)}`,
    lines: [m.title, second.join(' · ')],
    hint: HINT_ACTIONS,
    badge,
    actions: [
      ...presets.outcomeUsd.slice(0, MAX_ACTIONS - 1).map((usd) => buyAction(m, 0, usd)),
      buyAction(m, 1, middle),
    ],
  };
}

/** A fresh account never sees a blank screen: an empty card with quick buys on watched markets. */
function emptyCard(watch: OutcomeMarket[], presets: Presets, badge: Badge): CardModel {
  const usd = presets.outcomeUsd[0] ?? 5;
  return {
    id: 'empty',
    kind: 'empty',
    title: 'NO POSITIONS',
    value: 'Ready to trade',
    lines: ['Swipe for watched markets', 'Say "buy 10 on bitcoin daily"'],
    hint: HINT_EMPTY,
    badge,
    actions: watch.slice(0, MAX_ACTIONS).map((m) => buyAction(m, 0, usd, true)),
  };
}

/** Deck order: account, perps, outcome positions, watched markets. */
export function buildDeck(input: DeckInput): CardModel[] {
  const { view, watch, presets, badge, now } = input;
  const cards: CardModel[] = [accountCard(view, badge)];
  for (const p of view.perps) cards.push(perpCard(p, presets, badge));
  for (const o of view.outcomes) cards.push(outcomePositionCard(o, badge, now));
  if (view.perps.length === 0 && view.outcomes.length === 0) {
    cards.push(emptyCard(watch, presets, badge));
  }
  for (const m of watch) cards.push(marketCard(m, input));
  if (input.gram) cards.push(gramCard(input.gram, badge));
  return cards;
}

function gramCard(g: { gram: number } | { error: string }, badge: Badge): CardModel {
  const value =
    'gram' in g
      ? `${Number(g.gram.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 })} GRAM`
      : g.error;
  return {
    id: 'gram',
    kind: 'gram',
    title: 'GRAM · TON TESTNET',
    value,
    lines: ['Read-only · Gram Wallet'],
    hint: HINT_NO_ACTIONS,
    badge,
    actions: [],
  };
}
