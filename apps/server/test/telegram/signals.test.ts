import { DEFAULT_PRESETS } from '@hypersight/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../../src/alerts/rules';
import { describeIntent } from '../../src/intent/describe';
import type { IntentContext } from '../../src/intent/grammar';
import { openDb } from '../../src/store/db';
import { createRepos } from '../../src/store/repos';
import type { TgMessage } from '../../src/telegram/bot';
import { TelegramSignals } from '../../src/telegram/signals';

const NOW = Date.UTC(2026, 10, 25, 12);

const ctx: IntentContext = {
  perpCoins: ['BTC', 'ETH', 'SOL'],
  positions: [{ coin: 'ETH' }],
  outcomePositions: [],
  markets: [],
};

const msg = (over: Partial<TgMessage> = {}): TgMessage => ({
  chatId: -100,
  chatTitle: 'Alpha calls',
  chatType: 'supergroup',
  messageId: 7,
  from: 'whale',
  text: 'longing ETH here',
  sentAt: NOW - 5_000,
  ...over,
});

function setup() {
  const repos = createRepos(openDb(':memory:'));
  const alerts: AlertEvent[] = [];
  const sendMessage = vi.fn(async (_chat: number, _text: string, _replyTo?: number) => {});
  const logs: string[] = [];
  const signals = new TelegramSignals({
    chats: repos.telegramChats,
    context: () => ctx,
    presets: () => DEFAULT_PRESETS,
    alert: (ev) => alerts.push(ev),
    api: { sendMessage },
    describe: (intent) => describeIntent(intent),
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  const follow = (patch: { replyFills?: boolean } = {}) => {
    repos.telegramChats.seen({ id: -100, title: 'Alpha calls', type: 'supergroup' }, NOW - 1);
    repos.telegramChats.set(-100, { follow: true, ...patch });
  };
  return { repos, alerts, sendMessage, logs, signals, follow };
}

describe('TelegramSignals', () => {
  it('remembers a chat it has not been told to follow, and sends nothing to the glasses', () => {
    const s = setup();
    s.signals.onMessage(msg());
    expect(s.repos.telegramChats.get(-100)).toMatchObject({
      title: 'Alpha calls',
      follow: false,
      seenAt: NOW,
    });
    expect(s.alerts).toEqual([]);
  });

  it('turns a signal in a followed chat into one alert with the trade proposed', () => {
    const s = setup();
    s.follow();
    s.signals.onMessage(msg());
    expect(s.alerts).toEqual([
      {
        ruleId: 'telegram',
        key: 'tg:-100:7',
        title: 'TELEGRAM · Alpha calls',
        lines: ['whale: "longing ETH here"', '→ Long ETH $50 at 2×'],
        action: { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 50, leverage: 2 },
        origin: { chatId: -100, messageId: 7 },
      },
    ]);
  });

  it('cuts a long chat title and a long message to fit the glasses', () => {
    const s = setup();
    s.follow();
    s.signals.onMessage(
      msg({
        chatTitle: 'Hyperliquid perps alpha calls — premium room',
        text: 'ETH LONG\nEntry 2450   TP 2600 / 2750\nSL 2400 — not financial advice, size small',
      }),
    );
    expect(s.alerts[0]?.title).toBe('TELEGRAM · Hyperliquid perps alpha call…');
    expect(s.alerts[0]?.lines[0]).toBe(
      'whale: "ETH LONG Entry 2450 TP 2600 / 2750 SL 2400 — not financial…"',
    );
  });

  it('ignores chatter in a followed chat', () => {
    const s = setup();
    s.follow();
    s.signals.onMessage(msg({ text: 'gm everyone' }));
    s.signals.onMessage(msg({ messageId: 8, text: 'close btc' }));
    expect(s.alerts).toEqual([]);
  });

  it('ignores a call sent minutes ago (a backlog after a restart), but still lists its chat', () => {
    const s = setup();
    s.follow();
    s.signals.onMessage(msg({ sentAt: NOW - 10 * 60_000, chatTitle: 'Alpha calls VIP' }));
    expect(s.alerts).toEqual([]);
    expect(s.repos.telegramChats.get(-100)).toMatchObject({
      title: 'Alpha calls VIP',
      seenAt: NOW,
    });
    // Still fresh at two minutes.
    s.signals.onMessage(msg({ messageId: 8, sentAt: NOW - 2 * 60_000 }));
    expect(s.alerts).toHaveLength(1);
  });

  it('alerts once per message: an edited signal does not alert again', () => {
    const s = setup();
    s.follow();
    s.signals.onMessage(msg({ text: 'lnog eth' }));
    s.signals.onMessage(msg({ text: 'long eth' }));
    s.signals.onMessage(msg({ text: 'long eth!' }));
    expect(s.alerts).toHaveLength(1);
  });

  it('replies to the signal with the fill when the chat asked for it', () => {
    const s = setup();
    s.follow({ replyFills: true });
    s.signals.onFilled({ chatId: -100, messageId: 7 }, 'Long ETH $50 at 2× · Filled 0.0146 @ 3412');
    expect(s.sendMessage).toHaveBeenCalledWith(
      -100,
      '✅ Long ETH $50 at 2× · Filled 0.0146 @ 3412 · HyperSight (testnet)',
      7,
    );
  });

  it('stays quiet in a chat that did not ask for fill replies, or that it does not know', () => {
    const s = setup();
    s.follow();
    s.signals.onFilled({ chatId: -100, messageId: 7 }, 'Filled');
    s.signals.onFilled({ chatId: -999, messageId: 1 }, 'Filled');
    expect(s.sendMessage).not.toHaveBeenCalled();
  });

  it('logs a reply that Telegram refuses instead of throwing', async () => {
    const s = setup();
    s.follow({ replyFills: true });
    s.sendMessage.mockRejectedValueOnce(new Error('Forbidden: bot was kicked'));
    expect(() => s.signals.onFilled({ chatId: -100, messageId: 7 }, 'Filled')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.logs.some((l) => l.includes('bot was kicked'))).toBe(true);
  });
});
