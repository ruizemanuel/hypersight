import type { Intent, Presets } from '@hypersight/protocol';
import type { AlertEvent, SignalOrigin } from '../alerts/rules';
import type { IntentContext } from '../intent/grammar';
import type { Repos } from '../store/repos';
import type { TelegramApi, TgMessage } from './bot';
import { parseSignal } from './signal';

const TITLE_MAX = 40;
const EXCERPT_MAX = 60;
/**
 * A call older than this is no longer news: after a restart Telegram hands back up to a day of
 * messages, and an edit of an old post ("TP1 hit") keeps its first send time.
 */
const MAX_AGE_MS = 3 * 60_000;
/** Messages already alerted (an edit of one never alerts again); oldest forgotten first. */
const ALERTED_MAX = 500;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Trade signals from the Telegram chats the user follows: each one becomes a glasses alert with
 * the trade proposed (sized from the user's presets, confirmed on the glasses), and a fill can be
 * reported back as a reply to the message.
 */
export class TelegramSignals {
  private readonly alerted = new Set<string>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly deps: {
      chats: Repos['telegramChats'];
      context(): IntentContext;
      presets(): Presets;
      alert(ev: AlertEvent): void;
      api: Pick<TelegramApi, 'sendMessage'>;
      describe(intent: Intent): string;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  onMessage(m: TgMessage): void {
    const chat = this.deps.chats.seen(
      { id: m.chatId, title: m.chatTitle, type: m.chatType },
      this.now(),
    );
    if (!chat.follow || this.now() - m.sentAt > MAX_AGE_MS) return;
    const key = `tg:${m.chatId}:${m.messageId}`;
    if (this.alerted.has(key)) return;
    const intent = parseSignal(m.text, this.deps.context(), this.deps.presets());
    if (!intent) return;
    this.alerted.add(key);
    if (this.alerted.size > ALERTED_MAX) {
      this.alerted.delete(this.alerted.values().next().value as string);
    }
    this.deps.alert({
      ruleId: 'telegram',
      key,
      title: cut(`TELEGRAM · ${chat.title}`, TITLE_MAX),
      lines: [`${m.from}: "${cut(m.text, EXCERPT_MAX)}"`, `→ ${this.deps.describe(intent)}`],
      action: intent,
      origin: { chatId: m.chatId, messageId: m.messageId },
    });
  }

  /** Replies to the signal with the fill, only in a chat that asked for fill replies. */
  onFilled(origin: SignalOrigin, message: string): void {
    const chat = this.deps.chats.get(origin.chatId);
    if (!chat?.replyFills) return;
    this.deps.api
      .sendMessage(chat.id, `✅ ${message} · HyperSight (testnet)`, origin.messageId)
      .catch((e: unknown) =>
        this.log(`[telegram] fill reply failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  }
}
