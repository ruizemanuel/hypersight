import {
  type CardModel,
  type Overlay,
  type ServerMsg,
  ServerMsgSchema,
} from '@hypersight/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AccountView, PerpPosition } from '../../src/hl/account';
import type { PerpMeta } from '../../src/hl/ids';
import type { Book } from '../../src/hl/market-stream';
import { Catalogue } from '../../src/hl/outcomes';
import { buildIntentContext } from '../../src/intent/aliases';
import type { Resolution } from '../../src/intent/resolve';
import { resolveIntent } from '../../src/intent/resolve';
import { SessionController } from '../../src/session/controller';
import { Session } from '../../src/session/session';
import { openDb } from '../../src/store/db';
import { createRepos } from '../../src/store/repos';
import { FakeExecutor } from '../../src/trade/executor';
import { ProposalService } from '../../src/trade/proposals';
import { VoiceRouter } from '../../src/voice/router';

const T0 = Date.UTC(2026, 10, 24, 12, 0);
const perpMeta: PerpMeta[] = [
  { name: 'BTC', index: 3, szDecimals: 5, maxLeverage: 40, onlyIsolated: false },
  { name: 'ETH', index: 4, szDecimals: 4, maxLeverage: 25, onlyIsolated: false },
];
const ethLong: PerpPosition = {
  coin: 'ETH',
  size: 0.5,
  entryPx: 3326.8,
  markPx: 3411,
  upnlUsd: 42.1,
  roe: 0.031,
  leverage: 2,
  isCross: true,
  liqPx: 2950,
  szDecimals: 4,
};

function setup(
  opts: {
    resolve?: (text: string) => Promise<Resolution>;
    onSignalFilled?: (origin: { chatId: number; messageId: number }, message: string) => void;
  } = {},
) {
  const clock = { now: T0 };
  const catalogue = new Catalogue({ now: () => clock.now });
  catalogue.reset(
    {
      outcomes: [
        {
          outcome: 27321,
          name: 'Recurring',
          description:
            'class:priceBinary|underlying:BTC|expiry:20261125-0300|targetPrice:61509|period:1d',
          sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
        },
      ],
      questions: [],
    },
    [],
  );
  const view: AccountView = {
    equityUsd: 1000,
    perpUpnlUsd: 42.1,
    marginRatio: 0.1,
    marginUsage: 0.3,
    perpWithdrawableUsd: 500,
    spotUsdc: 999,
    perps: [ethLong],
    outcomes: [],
    abstraction: 'unifiedAccount',
    updatedAt: T0,
  };
  const books: Record<string, Book> = {
    ETH: { bids: [{ px: 3411, sz: 10 }], asks: [{ px: 3412, sz: 10 }] },
    '#273210': { bids: [{ px: 0.6, sz: 100 }], asks: [{ px: 0.62, sz: 100 }] },
    '#273211': { bids: [{ px: 0.37, sz: 100 }], asks: [{ px: 0.4, sz: 100 }] },
  };
  const mids: Record<string, string> = { ETH: '3411.5', '#273210': '0.61', '#273211': '0.39' };
  const repos = createRepos(openDb(':memory:'));
  const executor = new FakeExecutor();
  const proposals = new ProposalService({
    stream: { view: () => view, book: async (coin) => books[coin] ?? { bids: [], asks: [] } },
    catalogue,
    repos,
    executor,
    perpMeta,
    network: 'testnet',
    now: () => clock.now,
  });
  const publish = vi.fn();
  const refresh = vi.fn(async () => {});
  const controller = new SessionController({
    proposals,
    resolve:
      opts.resolve ??
      ((text, ctx) => resolveIntent(text, ctx, { client: null, model: 'claude-opus-5-5' })),
    context: (focus) =>
      buildIntentContext(view, catalogue, repos.watch.list(), {
        now: clock.now,
        ...(focus ? { focus } : {}),
      }),
    view: () => view,
    mids: () => mids,
    catalogue,
    watch: repos.watch,
    publish,
    refresh,
    modeInfo: async () => ['Agent valid until Dec 20', 'Limits $250/order · $2,000/day'],
    now: () => clock.now,
    ...(opts.onSignalFilled ? { onSignalFilled: opts.onSignalFilled } : {}),
  });
  const session = new Session('s1');
  const sent: ServerMsg[] = [];
  const socket = {
    readyState: 1,
    // Every message the server sends must pass the protocol schema.
    send: (d: string) => sent.push(ServerMsgSchema.parse(JSON.parse(d))),
    close: () => {},
  };
  session.attach(socket);
  controller.attach(session);
  const overlays = () =>
    sent
      .filter((m): m is Extract<ServerMsg, { t: 'overlay' }> => m.t === 'overlay')
      .map((m) => m.overlay);
  return {
    controller,
    session,
    sent,
    overlays,
    executor,
    repos,
    books,
    clock,
    publish,
    refresh,
    catalogue,
  };
}

const confirmOf = (o: Overlay | null | undefined) => {
  if (o?.kind !== 'confirm')
    throw new Error(`expected a confirm overlay, got ${JSON.stringify(o)}`);
  return o.proposal;
};

describe('SessionController — voice to confirm to execute', () => {
  it('proposes, confirms once and reports the result (and a reconnecting client sees it)', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'close half my eth', { sttMs: 230 });
    const [thinking, confirm] = s.overlays();
    expect(thinking).toEqual({ kind: 'thinking' });
    const proposal = confirmOf(confirm);
    expect(proposal.title).toBe('CLOSE 50% ETH LONG');
    expect(proposal.note).toBe('heard: "close half my eth"');

    s.sent.length = 0;
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: proposal.id });
    const [busy, result] = s.overlays();
    expect(busy).toEqual({ kind: 'thinking', sending: true });
    expect(result).toMatchObject({ kind: 'result', ok: true });
    expect(s.executor.plans).toHaveLength(1);
    expect(s.repos.audit.list().map((a) => a.kind)).toEqual(
      expect.arrayContaining(['proposal', 'confirm', 'result']),
    );

    // The snapshot a reconnecting client replays ends on the result.
    const replay = s.session.snapshot().filter((m) => m.t === 'overlay');
    expect(replay.at(-1)).toMatchObject({ overlay: { kind: 'result', ok: true } });

    const m = s.controller.metrics();
    expect(m.sttMs).toBe(230);
    expect(m.intentMs).toBeGreaterThanOrEqual(0);
    expect(m.execMs).toBeGreaterThanOrEqual(0);
  });

  it('answers a question with a single result and no proposal', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, "what's my pnl", {});
    const overlays = s.overlays().filter((o) => o?.kind !== 'thinking');
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({ kind: 'result', ok: true, title: 'Open PnL +$42.10' });
    expect(s.executor.plans).toHaveLength(0);
    expect(s.repos.audit.list()).toHaveLength(0);
  });

  it('shows a blocked proposal with its reason instead of a confirm button', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'close half my btc', {});
    expect(confirmOf(s.overlays().at(-1)).blocked).toBe('No BTC position');
  });

  it('says what it did not understand', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'tell me a joke', {});
    expect(s.overlays().at(-1)).toMatchObject({ kind: 'result', ok: false });
  });

  it('clears the overlay on cancel and dismiss, and a cancelled proposal never executes', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'close half my eth', {});
    const p = confirmOf(s.overlays().at(-1));
    await s.controller.onClientMsg(s.session, { t: 'cancel', proposalId: p.id });
    expect(s.overlays().at(-1)).toBeNull();
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: p.id });
    expect(s.executor.plans).toHaveLength(0);
    await s.controller.onClientMsg(s.session, { t: 'dismiss' });
    expect(s.overlays().at(-1)).toBeNull();
  });

  it('drops a voice answer that arrives after the user dismissed Thinking', async () => {
    let release: (r: Resolution) => void = () => {};
    const s = setup({
      resolve: () =>
        new Promise<Resolution>((r) => {
          release = r;
        }),
    });
    const pending = s.controller.onTranscript(s.session, 'get me out of eth', {});
    await s.controller.onClientMsg(s.session, { t: 'dismiss' });
    release({ intent: { kind: 'closePerp', coin: 'ETH', fraction: 1 }, source: 'llm', ms: 900 });
    await pending;
    expect(s.overlays().at(-1)).toBeNull();
    expect(s.overlays().some((o) => o?.kind === 'confirm')).toBe(false);
  });

  it('drops an utterance dismissed between voice end and the final transcript', async () => {
    const s = setup();
    let finishStt: () => void = () => {};
    const sttDone = new Promise<void>((r) => {
      finishStt = r;
    });
    // The STT finish can take seconds: the dismiss lands before the transcript does.
    (s.controller as unknown as { deps: { voice: unknown } }).deps.voice = {
      start: () => {},
      cancel: () => {},
      end: async (session: typeof s.session) => {
        await sttDone;
        await s.controller.onTranscript(session, 'close half my eth', {});
      },
    };
    const ending = s.controller.onClientMsg(s.session, { t: 'voice', phase: 'end' });
    await s.controller.onClientMsg(s.session, { t: 'dismiss' });
    finishStt();
    await ending;
    expect(s.overlays().at(-1)).toBeNull();
    expect(s.overlays().some((o) => o?.kind === 'confirm' || o?.kind === 'thinking')).toBe(false);
  });

  it('drops a voice answer when the device disconnects while it is being resolved', async () => {
    let release: (r: Resolution) => void = () => {};
    const s = setup({
      resolve: () =>
        new Promise<Resolution>((r) => {
          release = r;
        }),
    });
    const pending = s.controller.onTranscript(s.session, 'get me out of eth', {});
    s.controller.onDetach(s.session);
    release({ intent: { kind: 'closePerp', coin: 'ETH', fraction: 1 }, source: 'llm', ms: 900 });
    await pending;
    expect(s.session.overlay()).toBeNull();
  });

  it('shows "sending" while executing, and an unknown outcome as CHECK POSITIONS', async () => {
    const s = setup();
    s.executor.execute = async () => ({ status: 'error', message: 'Hyperliquid error: 504' });
    await s.controller.onTranscript(s.session, 'close half my eth', {});
    const p = confirmOf(s.overlays().at(-1));
    s.sent.length = 0;
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: p.id });
    const [sending, result] = s.overlays();
    expect(sending).toEqual({ kind: 'thinking', sending: true });
    expect(result).toMatchObject({ kind: 'result', ok: false, unknown: true });
    expect(s.refresh).toHaveBeenCalled();
  });

  it('keeps the sending state for a device that drops mid-execution', async () => {
    const s = setup();
    s.session.send({ t: 'overlay', overlay: { kind: 'thinking', sending: true } });
    s.controller.onDetach(s.session);
    expect(s.session.overlay()).toEqual({ kind: 'thinking', sending: true });
  });

  it('re-proposes at the new price when the price moved before confirm', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'close half my eth', {});
    const first = confirmOf(s.overlays().at(-1));
    s.books.ETH = { bids: [{ px: 3000, sz: 10 }], asks: [{ px: 3001, sz: 10 }] };
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: first.id });
    const again = confirmOf(s.overlays().at(-1));
    expect(again.id).not.toBe(first.id);
    expect(again.note).toBe('Price moved — check the new price');
    expect(s.executor.plans).toHaveLength(0);
  });
});

describe('SessionController — taps and menu', () => {
  const card = (actions: CardModel['actions']): CardModel => ({
    id: 'perp:ETH',
    kind: 'perp',
    title: 'ETH LONG',
    value: '+$42.10',
    lines: [],
    hint: 'TAP actions',
    badge: 'TESTNET',
    actions,
  });

  it('proposes the intent of the tapped card action', async () => {
    const s = setup();
    s.session.send({
      t: 'deck',
      cards: [
        card([
          {
            id: 'c50',
            label: 'Close 50%',
            intent: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 },
          },
        ]),
      ],
    });
    await s.controller.onClientMsg(s.session, { t: 'action', cardId: 'perp:ETH', actionId: 'c50' });
    expect(confirmOf(s.overlays().at(-1)).title).toBe('CLOSE 50% ETH LONG');
  });

  it('says so when the tapped card or action is gone', async () => {
    const s = setup();
    await s.controller.onClientMsg(s.session, { t: 'action', cardId: 'perp:SOL', actionId: 'x' });
    expect(s.overlays().at(-1)).toMatchObject({ kind: 'result', ok: false });
  });

  it('handles the contextual menu: cancel all, refresh and mode info', async () => {
    const s = setup();
    await s.controller.onClientMsg(s.session, {
      t: 'action',
      cardId: 'menu',
      actionId: 'cancelAll',
    });
    expect(confirmOf(s.overlays().at(-1)).title).toBe('CANCEL ALL ORDERS');
    await s.controller.onClientMsg(s.session, { t: 'action', cardId: 'menu', actionId: 'refresh' });
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(s.publish).toHaveBeenCalled();
    await s.controller.onClientMsg(s.session, {
      t: 'action',
      cardId: 'menu',
      actionId: 'modeInfo',
    });
    expect(s.overlays().at(-1)).toMatchObject({
      kind: 'result',
      title: 'TESTNET',
      lines: ['Agent valid until Dec 20', 'Limits $250/order · $2,000/day'],
    });
  });

  it('adds a market to the watchlist by voice and republishes the deck', async () => {
    const s = setup();
    s.repos.watch.remove('rb:BTC:1d');
    await s.controller.onTranscript(s.session, 'watch the bitcoin daily', {});
    expect(s.repos.watch.list()).toContain('rb:BTC:1d');
    expect(s.publish).toHaveBeenCalled();
    expect(s.overlays().at(-1)).toMatchObject({ kind: 'result', ok: true });
  });
});

// "odds on …?" then "buy 20 dollars of yes".
describe('SessionController — focus', () => {
  it('uses the market from the last odds answer when the next command names none', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'odds on the bitcoin daily', {});
    expect(s.overlays().at(-1)).toMatchObject({ kind: 'result', title: 'YES 61% · NO 39%' });
    await s.controller.onTranscript(s.session, 'buy 20 dollars of yes', {});
    expect(confirmOf(s.overlays().at(-1)).title).toBe('BUY YES · BTC > 61,509 · daily');
  });

  it('uses the card on screen when voice started there', async () => {
    const s = setup();
    await s.controller.onClientMsg(s.session, {
      t: 'voice',
      phase: 'start',
      cardId: 'mkt:rb:BTC:1d',
    });
    await s.controller.onTranscript(s.session, 'buy 10 dollars of no', {});
    expect(confirmOf(s.overlays().at(-1)).title).toBe('BUY NO · BTC > 61,509 · daily');
  });
});

describe('SessionController — alerts', () => {
  const takeHalf = {
    ruleId: 'eth-pnl',
    title: 'ETH +5.5%',
    lines: ['PnL +$82.50', 'your rule: take half'],
    action: { kind: 'closePerp' as const, coin: 'ETH', fraction: 0.5 },
  };

  it('shows an alert with a quick action, and tapping it goes through the normal confirm', async () => {
    const s = setup();
    s.controller.alert(s.session, takeHalf);
    const alert = s.overlays().at(-1);
    if (alert?.kind !== 'alert' || !alert.action)
      throw new Error('expected an alert with an action');
    expect(alert.title).toBe('ETH +5.5%');
    expect(alert.action.label).toBe('take half');
    await s.controller.onClientMsg(s.session, {
      t: 'action',
      cardId: 'alert',
      actionId: alert.action.id,
    });
    expect(confirmOf(s.overlays().at(-1)).title).toBe('CLOSE 50% ETH LONG');
    expect(s.executor.plans).toHaveLength(0);
  });

  it('never covers a confirm card: the alert waits until it is answered', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'close half my eth', {});
    const p = confirmOf(s.overlays().at(-1));
    s.controller.alert(s.session, takeHalf);
    expect(s.overlays().at(-1)?.kind).toBe('confirm');
    await s.controller.onClientMsg(s.session, { t: 'cancel', proposalId: p.id });
    expect(s.overlays().at(-1)).toMatchObject({ kind: 'alert', title: 'ETH +5.5%' });
  });
});

describe('SessionController — trades from chat signals', () => {
  const origin = { chatId: -100, messageId: 7 };
  const signal = {
    ruleId: 'telegram',
    key: 'tg:-100:7',
    title: 'TELEGRAM · Alpha calls',
    lines: ['whale: "closing half my eth"'],
    action: { kind: 'closePerp' as const, coin: 'ETH', fraction: 0.5 },
    origin,
  };

  async function tapSignal(s: ReturnType<typeof setup>) {
    s.controller.alert(s.session, signal);
    const alert = s.overlays().at(-1);
    if (alert?.kind !== 'alert' || !alert.action) throw new Error('expected an alert action');
    await s.controller.onClientMsg(s.session, {
      t: 'action',
      cardId: 'alert',
      actionId: alert.action.id,
    });
    return confirmOf(s.overlays().at(-1));
  }

  it('reports the fill of a trade proposed from a chat signal back to that message', async () => {
    const onSignalFilled = vi.fn();
    const s = setup({ onSignalFilled });
    s.executor.result = { status: 'filled', message: 'Filled 0.25 @ 3411' };
    const p = await tapSignal(s);
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: p.id });
    expect(onSignalFilled).toHaveBeenCalledTimes(1);
    expect(onSignalFilled).toHaveBeenCalledWith(origin, 'Close 50% of ETH · Filled 0.25 @ 3411');

    // A trade the user started themselves is never reported anywhere.
    await s.controller.onTranscript(s.session, 'close half my eth', {});
    const own = confirmOf(s.overlays().at(-1));
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: own.id });
    expect(onSignalFilled).toHaveBeenCalledTimes(1);
  });

  it('reports a partial fill, but not a refused, resting or unknown result', async () => {
    for (const [result, reported] of [
      [{ status: 'partial', message: 'Partially filled 0.1/0.25 @ 3411' }, true],
      [{ status: 'none', message: 'No liquidity — nothing executed' }, false],
      [{ status: 'resting', message: 'Resting' }, false],
      [{ status: 'error', message: 'Hyperliquid error: 504' }, false],
    ] as const) {
      const onSignalFilled = vi.fn();
      const s = setup({ onSignalFilled });
      s.executor.result = { ...result };
      const p = await tapSignal(s);
      await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: p.id });
      expect(onSignalFilled).toHaveBeenCalledTimes(reported ? 1 : 0);
    }
  });

  it('keeps each signal with its own chat when two alerts arrive in the same millisecond', async () => {
    const onSignalFilled = vi.fn();
    const s = setup({ onSignalFilled });
    // The clock stands still: both alerts are raised at the same instant.
    s.controller.alert(s.session, signal);
    s.controller.alert(s.session, {
      ...signal,
      key: 'tg:-200:9',
      title: 'TELEGRAM · Other room',
      action: { kind: 'closePerp', coin: 'ETH', fraction: 1 },
      origin: { chatId: -200, messageId: 9 },
    });
    const shown = s.overlays().at(-1);
    if (shown?.kind !== 'alert' || !shown.action) throw new Error('expected an alert action');
    expect(shown.title).toBe('TELEGRAM · Alpha calls');
    await s.controller.onClientMsg(s.session, {
      t: 'action',
      cardId: 'alert',
      actionId: shown.action.id,
    });
    const p = confirmOf(s.overlays().at(-1));
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: p.id });
    expect(onSignalFilled).toHaveBeenCalledWith(origin, 'Close 50% of ETH · Filled');
  });

  it('never gives a chat origin to a rule alert raised in the same millisecond', async () => {
    const onSignalFilled = vi.fn();
    const s = setup({ onSignalFilled });
    s.controller.alert(s.session, {
      ruleId: 'eth-pnl',
      title: 'ETH +5.5%',
      lines: ['your rule: take half'],
      action: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 },
    });
    s.controller.alert(s.session, signal);
    const shown = s.overlays().at(-1);
    if (shown?.kind !== 'alert' || !shown.action) throw new Error('expected an alert action');
    expect(shown.title).toBe('ETH +5.5%');
    await s.controller.onClientMsg(s.session, {
      t: 'action',
      cardId: 'alert',
      actionId: shown.action.id,
    });
    const p = confirmOf(s.overlays().at(-1));
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: p.id });
    expect(onSignalFilled).not.toHaveBeenCalled();
  });

  it('keeps the chat origin when the price moved and the trade is proposed again', async () => {
    const onSignalFilled = vi.fn();
    const s = setup({ onSignalFilled });
    const first = await tapSignal(s);
    s.books.ETH = { bids: [{ px: 3000, sz: 10 }], asks: [{ px: 3001, sz: 10 }] };
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: first.id });
    const again = confirmOf(s.overlays().at(-1));
    expect(onSignalFilled).not.toHaveBeenCalled();
    await s.controller.onClientMsg(s.session, { t: 'confirm', proposalId: again.id });
    expect(onSignalFilled).toHaveBeenCalledWith(origin, 'Close 50% of ETH · Filled');
  });
});

describe('SessionController — held alerts are never stranded', () => {
  const takeHalf = {
    ruleId: 'eth-pnl',
    title: 'ETH +5.5%',
    lines: ['PnL +$82.50', 'your rule: take half'],
    action: { kind: 'closePerp' as const, coin: 'ETH', fraction: 0.5 },
  };
  const voiceStub = { start: () => {}, end: async () => {}, cancel: () => {}, drop: () => {} };
  const withVoice = (s: ReturnType<typeof setup>, voice: unknown) => {
    (s.controller as unknown as { deps: { voice: unknown } }).deps.voice = voice;
  };

  it('shows an alert at once when the confirm on screen has already expired', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'close half my eth', {});
    s.clock.now += 16_000;
    s.controller.alert(s.session, takeHalf);
    expect(s.session.overlay()).toMatchObject({ kind: 'alert', title: 'ETH +5.5%' });
  });

  it('releases a held alert when its confirm expires unanswered (the device is gone)', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      await s.controller.onTranscript(s.session, 'close half my eth', {});
      s.controller.alert(s.session, takeHalf);
      expect(s.session.overlay()?.kind).toBe('confirm');
      s.clock.now += 17_000;
      vi.advanceTimersByTime(17_000);
      expect(s.session.overlay()).toMatchObject({ kind: 'alert', title: 'ETH +5.5%' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a released alert when a late cancel arrives for the confirm it replaced', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      await s.controller.onTranscript(s.session, 'close half my eth', {});
      const p = confirmOf(s.overlays().at(-1));
      s.controller.alert(s.session, takeHalf);
      s.clock.now += 17_000;
      vi.advanceTimersByTime(17_000);
      await s.controller.onClientMsg(s.session, { t: 'cancel', proposalId: p.id });
      expect(s.session.overlay()).toMatchObject({ kind: 'alert', title: 'ETH +5.5%' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a held alert when the user abandons the voice step (2×TAP)', async () => {
    const s = setup();
    withVoice(s, voiceStub);
    s.session.send({ t: 'overlay', overlay: { kind: 'listening', transcript: 'close' } });
    s.controller.alert(s.session, takeHalf);
    await s.controller.onClientMsg(s.session, { t: 'voice', phase: 'cancel' });
    expect(s.session.overlay()).toMatchObject({ kind: 'alert', title: 'ETH +5.5%' });
  });

  it('leaves a held alert in the snapshot when the device drops while listening', async () => {
    const s = setup();
    withVoice(s, voiceStub);
    s.session.send({ t: 'overlay', overlay: { kind: 'listening', transcript: 'close' } });
    s.controller.alert(s.session, takeHalf);
    s.controller.onDetach(s.session);
    const replay = s.session.snapshot().filter((m) => m.t === 'overlay');
    expect(replay.at(-1)).toMatchObject({ overlay: { kind: 'alert', title: 'ETH +5.5%' } });
  });

  it('keeps a result on screen when the device drops (the voice router does not clear it)', async () => {
    const s = setup();
    withVoice(
      s,
      new VoiceRouter({ factory: null, keyterms: () => [], onTranscript: async () => {} }),
    );
    s.session.send({
      t: 'overlay',
      overlay: { kind: 'result', ok: true, title: 'Filled', lines: [] },
    });
    s.controller.onDetach(s.session);
    expect(s.session.overlay()).toMatchObject({ kind: 'result', title: 'Filled' });
  });

  it('queues an alert behind one already on screen instead of replacing it', async () => {
    const s = setup();
    s.controller.alert(s.session, takeHalf);
    s.controller.alert(s.session, { ruleId: 'btc', title: 'BTC above 62,000', lines: [] });
    expect(s.session.overlay()).toMatchObject({ title: 'ETH +5.5%' });
    await s.controller.onClientMsg(s.session, { t: 'dismiss' });
    expect(s.session.overlay()).toMatchObject({ title: 'BTC above 62,000' });
    await s.controller.onClientMsg(s.session, { t: 'dismiss' });
    expect(s.session.overlay()).toBeNull();
  });

  it('shows liquidation warnings first, one per coin, when the user is free', async () => {
    const s = setup();
    await s.controller.onTranscript(s.session, 'close half my eth', {});
    const p = confirmOf(s.overlays().at(-1));
    s.controller.alert(s.session, takeHalf);
    s.controller.alert(s.session, {
      ruleId: 'liq',
      key: 'liq:ETH',
      urgent: true,
      title: 'ETH 7% from liquidation',
      lines: [],
    });
    s.controller.alert(s.session, {
      ruleId: 'liq',
      key: 'liq:SOL',
      urgent: true,
      title: 'SOL 8% from liquidation',
      lines: [],
    });
    await s.controller.onClientMsg(s.session, { t: 'cancel', proposalId: p.id });
    const titles: string[] = [];
    for (let i = 0; i < 3; i++) {
      titles.push((s.session.overlay() as { title: string }).title);
      await s.controller.onClientMsg(s.session, { t: 'dismiss' });
    }
    expect(titles).toEqual(['ETH 7% from liquidation', 'SOL 8% from liquidation', 'ETH +5.5%']);
  });

  it('drops a held alert that is too old to matter once the user is free', async () => {
    const s = setup();
    s.session.send({ t: 'overlay', overlay: { kind: 'thinking' } });
    s.controller.alert(s.session, takeHalf);
    s.clock.now += 6 * 60_000;
    await s.controller.onClientMsg(s.session, { t: 'dismiss' });
    expect(s.session.overlay()).toBeNull();
  });
});

describe('SessionController — stale overlays', () => {
  it('clears Listening/Thinking from the snapshot when the client goes away', async () => {
    const s = setup();
    s.session.send({ t: 'overlay', overlay: { kind: 'listening', transcript: 'close' } });
    s.controller.onDetach(s.session);
    const replay = s.session.snapshot().filter((m) => m.t === 'overlay');
    expect(replay.at(-1)).toMatchObject({ overlay: null });
  });

  it('keeps a result in the snapshot when the client goes away', async () => {
    const s = setup();
    s.session.send({
      t: 'overlay',
      overlay: { kind: 'result', ok: true, title: 'Filled', lines: [] },
    });
    s.controller.onDetach(s.session);
    expect(
      s.session
        .snapshot()
        .filter((m) => m.t === 'overlay')
        .at(-1),
    ).toMatchObject({
      overlay: { kind: 'result' },
    });
  });
});
