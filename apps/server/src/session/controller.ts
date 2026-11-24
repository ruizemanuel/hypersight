import type { Badge, ClientMsg, Intent, Overlay, ProposalView } from '@hypersight/protocol';
import { fmtPrice, fmtProb, fmtUsd } from '../deck/format';
import type { AccountView } from '../hl/account';
import { outcomeCoin } from '../hl/ids';
import type { Catalogue } from '../hl/outcomes';
import { describeIntent } from '../intent/describe';
import type { IntentContext } from '../intent/grammar';
import type { Resolution } from '../intent/resolve';
import type { ExecResult } from '../trade/executor';
import { PROPOSAL_TTL_MS, type ProposalService } from '../trade/proposals';
import type { Session } from './session';

export type Focus = { marketKey?: string; coin?: string };

export type ControllerDeps = {
  proposals: Pick<ProposalService, 'propose' | 'confirm' | 'cancel' | 'get'>;
  resolve: (text: string, ctx: IntentContext) => Promise<Resolution>;
  /** Intent context for one utterance, with what is in focus on the glasses. */
  context: (focus?: Focus) => IntentContext;
  view: () => AccountView | null;
  mids: () => Record<string, string>;
  catalogue: Pick<Catalogue, 'byKey' | 'byOutcome'>;
  watch: { add(key: string): void };
  /** Pushes the deck to every attached device (only when it changed). */
  publish: () => void;
  /** Re-reads account state from Hyperliquid. */
  refresh: () => Promise<void>;
  /** Lines for the menu's mode screen (agent validity, limits). */
  modeInfo: () => Promise<string[]>;
  /** Streams audio to speech-to-text; absent in tests that feed transcripts directly. */
  voice?: { start(s: Session): void; end(s: Session): Promise<void>; cancel(s: Session): void };
  badge?: Badge;
  log?: (msg: string, err?: unknown) => void;
  now?: () => number;
};

export type Metrics = { sttMs?: number; intentMs?: number; execMs?: number };

type DeviceState = {
  /** Bumped by every new utterance, dismiss and cancel: a late voice answer is then dropped. */
  gen: number;
  cardFocus?: Focus;
  oddsFocus?: { marketKey: string; at: number };
};

/** "buy 20 dollars of yes" right after "odds on …?" refers to that market for this long. */
const ODDS_FOCUS_MS = 120_000;
const HEARD_MAX = 100;
const PRICE_MOVED = 'Price moved — review again';

const sideLabel = (side: string) => (/^(yes|no)$/i.test(side) ? side.toUpperCase() : side);
const okStatus = (r: ExecResult) =>
  r.status === 'filled' || r.status === 'partial' || r.status === 'resting';

/** `mkt:rb:BTC:1d` → that market; `opos:27321:0` → its market; `perp:ETH` → that coin. */
function focusFromCard(
  cardId: string | undefined,
  catalogue: ControllerDeps['catalogue'],
): Focus | undefined {
  if (!cardId) return undefined;
  if (cardId.startsWith('mkt:')) return { marketKey: cardId.slice(4) };
  if (cardId.startsWith('perp:')) return { coin: cardId.slice(5) };
  const opos = /^opos:(\d+):[01]$/.exec(cardId);
  if (opos) {
    const m = catalogue.byOutcome(Number(opos[1]));
    return m ? { marketKey: m.key } : undefined;
  }
  return undefined;
}

/**
 * The write path for one device: taps and voice become intents, intents become proposals behind
 * a confirm card, and a confirm executes exactly once. Every step answers with an overlay; a
 * dismissed or cancelled step never comes back late.
 */
export class SessionController {
  private readonly devices = new WeakMap<Session, DeviceState>();
  private last: Metrics = {};
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
  }

  attach(session: Session): void {
    this.device(session);
    session.on('detach', () => this.onDetach(session));
  }

  /** Listening/Thinking never outlive the connection (a reconnect would replay a dead state). */
  onDetach(session: Session): void {
    this.deps.voice?.cancel(session);
    const kind = session.overlay()?.kind;
    if (kind === 'listening' || kind === 'thinking') session.send({ t: 'overlay', overlay: null });
  }

  metrics(): Metrics {
    return { ...this.last };
  }

  async onClientMsg(session: Session, msg: ClientMsg): Promise<void> {
    const dev = this.device(session);
    switch (msg.t) {
      case 'action':
        if (msg.cardId === 'menu') return this.onMenu(session, msg.actionId);
        return this.onCardAction(session, msg.cardId, msg.actionId);
      case 'confirm':
        return this.onConfirm(session, msg.proposalId);
      case 'cancel':
        dev.gen++;
        this.deps.proposals.cancel(msg.proposalId);
        this.show(session, null);
        return;
      case 'dismiss':
        dev.gen++;
        this.show(session, null);
        return;
      case 'voice':
        if (msg.phase === 'start') {
          dev.gen++;
          const focus = focusFromCard(msg.cardId, this.deps.catalogue);
          if (focus) dev.cardFocus = focus;
          else delete dev.cardFocus;
          this.deps.voice?.start(session);
        } else if (msg.phase === 'end') {
          await this.deps.voice?.end(session);
        } else {
          dev.gen++;
          this.deps.voice?.cancel(session);
        }
        return;
      default:
        return;
    }
  }

  async onTranscript(session: Session, text: string, timing: { sttMs?: number }): Promise<void> {
    const dev = this.device(session);
    const gen = dev.gen;
    this.show(session, { kind: 'thinking' });
    const r = await this.deps.resolve(text, this.deps.context(this.focus(dev)));
    if (dev.gen !== gen) return;
    this.last = { ...(timing.sttMs !== undefined ? { sttMs: timing.sttMs } : {}), intentMs: r.ms };
    this.deps.log?.(
      `[intent ${session.id.slice(0, 8)}] "${text}" → ${r.source} ${Math.round(r.ms)}ms ${JSON.stringify(r.intent)}`,
    );
    await this.handle(session, r.intent, { heard: text, gen });
  }

  private async onCardAction(session: Session, cardId: string, actionId: string): Promise<void> {
    const dev = this.device(session);
    let intent: Intent | undefined;
    if (cardId === 'alert') {
      const o = session.overlay();
      if (o?.kind === 'alert' && o.action?.id === actionId) intent = o.action.intent;
    } else {
      const card = session.cards().find((c) => c.id === cardId);
      intent = card?.actions.find((a) => a.id === actionId)?.intent;
    }
    if (!intent) {
      this.result(session, false, 'Card changed — try again', []);
      return;
    }
    dev.gen++;
    await this.handle(session, intent, { gen: dev.gen });
  }

  private async onMenu(session: Session, actionId: string): Promise<void> {
    const dev = this.device(session);
    if (actionId === 'cancelAll') {
      dev.gen++;
      await this.handle(session, { kind: 'cancelAll' }, { gen: dev.gen });
    } else if (actionId === 'refresh') {
      try {
        await this.deps.refresh();
      } catch (err) {
        this.deps.log?.('[controller] refresh failed', err);
      }
      this.deps.publish();
    } else if (actionId === 'modeInfo') {
      this.result(session, true, this.deps.badge ?? 'TESTNET', await this.deps.modeInfo());
    }
  }

  private async onConfirm(session: Session, proposalId: string): Promise<void> {
    const dev = this.device(session);
    dev.gen++;
    this.show(session, { kind: 'thinking' });
    const t0 = this.now();
    let result: ExecResult;
    try {
      result = await this.deps.proposals.confirm(proposalId);
    } catch (err) {
      this.deps.log?.('[controller] confirm failed', err);
      result = { status: 'error', message: 'Something went wrong — check your positions' };
    }
    this.last = { ...this.last, execMs: this.now() - t0 };
    const p = this.deps.proposals.get(proposalId);
    this.deps.log?.(
      `[exec ${session.id.slice(0, 8)}] ${p?.view.title ?? proposalId} → ${result.status} ${this.last.execMs}ms ${result.message}`,
    );
    if (result.message === PRICE_MOVED && p) {
      await this.propose(session, p.intent, { note: 'Price moved — check the new price' });
      return;
    }
    this.result(session, okStatus(result), result.message, p ? [p.view.title] : []);
  }

  private async handle(
    session: Session,
    intent: Intent,
    opts: { heard?: string; gen: number },
  ): Promise<void> {
    const dev = this.device(session);
    const heard = opts.heard ? `"${opts.heard.slice(0, HEARD_MAX)}"` : undefined;
    switch (intent.kind) {
      case 'unknown':
        this.result(
          session,
          false,
          "Didn't understand",
          heard ? [intent.reason, heard] : [intent.reason],
        );
        return;
      case 'query':
        this.answer(session, dev, intent);
        return;
      case 'watch': {
        this.deps.watch.add(intent.marketKey);
        this.deps.publish();
        const m = this.deps.catalogue.byKey(intent.marketKey);
        this.result(session, true, `Watching ${m?.short ?? intent.marketKey}`, []);
        return;
      }
      default: {
        const note = opts.heard ? `heard: ${heard}` : undefined;
        await this.propose(session, intent, { ...(note ? { note } : {}), gen: opts.gen });
      }
    }
  }

  private async propose(
    session: Session,
    intent: Intent,
    opts: { note?: string; gen?: number },
  ): Promise<void> {
    const dev = this.device(session);
    const gen = opts.gen ?? dev.gen;
    const p = await this.deps.proposals.propose(intent);
    if (dev.gen !== gen) return;
    const note = opts.note ? { note: opts.note } : {};
    let proposal: ProposalView;
    if ('blocked' in p) {
      proposal = {
        id: `blocked:${this.now()}`,
        title: describeIntent(intent, (k) => this.deps.catalogue.byKey(k)),
        lines: [],
        expiresAt: this.now() + PROPOSAL_TTL_MS,
        blocked: p.blocked,
        ...note,
      };
    } else {
      proposal = { ...p.view, ...note };
    }
    this.show(session, { kind: 'confirm', proposal });
  }

  private answer(session: Session, dev: DeviceState, q: Extract<Intent, { kind: 'query' }>): void {
    const view = this.deps.view();
    const mids = this.deps.mids();
    if (q.topic === 'odds') {
      const m = q.marketKey ? this.deps.catalogue.byKey(q.marketKey) : undefined;
      if (!m) {
        this.result(session, false, 'Market not found', []);
        return;
      }
      dev.oddsFocus = { marketKey: m.key, at: this.now() };
      const prob = (side: 0 | 1) => {
        const raw = Number(mids[outcomeCoin(m.outcome, side)]);
        return Number.isFinite(raw) && raw > 0 ? fmtProb(raw) : '—';
      };
      const title = `${sideLabel(m.sides[0])} ${prob(0)} · ${sideLabel(m.sides[1])} ${prob(1)}`;
      this.result(session, true, title, [m.short]);
      return;
    }
    if (q.topic === 'price') {
      const raw = q.coin ? Number(mids[q.coin]) : Number.NaN;
      if (!q.coin || !Number.isFinite(raw)) {
        this.result(session, false, `No price for ${q.coin ?? 'that'}`, []);
        return;
      }
      this.result(session, true, `${q.coin} ${fmtPrice(raw)}`, []);
      return;
    }
    if (!view) {
      this.result(session, false, 'Account data not ready', []);
      return;
    }
    if (q.topic === 'pnl') {
      const outcomes = view.outcomes.reduce((s, o) => s + o.upnlUsd, 0);
      this.result(
        session,
        true,
        `Open PnL ${fmtUsd(view.perpUpnlUsd + outcomes, { sign: true })}`,
        [
          `Perps ${fmtUsd(view.perpUpnlUsd, { sign: true })} · Outcomes ${fmtUsd(outcomes, { sign: true })}`,
        ],
      );
      return;
    }
    this.result(session, true, `Equity ${fmtUsd(view.equityUsd)}`, [
      `USDC ${fmtUsd(view.spotUsdc)}`,
    ]);
  }

  private focus(dev: DeviceState): Focus | undefined {
    if (dev.cardFocus) return dev.cardFocus;
    const odds = dev.oddsFocus;
    if (odds && this.now() - odds.at <= ODDS_FOCUS_MS) return { marketKey: odds.marketKey };
    return undefined;
  }

  private result(session: Session, ok: boolean, title: string, lines: string[]): void {
    this.show(session, { kind: 'result', ok, title, lines: lines.slice(0, 3) });
  }

  private show(session: Session, overlay: Overlay | null): void {
    session.send({ t: 'overlay', overlay });
  }

  private device(session: Session): DeviceState {
    let d = this.devices.get(session);
    if (!d) {
      d = { gen: 0 };
      this.devices.set(session, d);
    }
    return d;
  }
}
