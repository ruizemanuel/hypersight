/** A text message (or media caption) from a chat the bot is in. */
export type TgMessage = {
  chatId: number;
  chatTitle: string;
  chatType: string;
  messageId: number;
  from: string;
  text: string;
  /** When the message was first sent (an edit keeps it), ms since epoch. */
  sentAt: number;
};

export type TgUpdate = { updateId: number; message?: TgMessage };

export type TelegramApi = {
  /** Long poll: waits up to `timeoutSec` for updates after `offset`. */
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, replyTo?: number): Promise<void>;
  /** The bot's own @username (the phone tells the user which bot to add to a group). */
  getMe(): Promise<{ username: string }>;
};

/** A failed Bot API call; the message carries the method and Telegram's description, never the token. */
export class TelegramError extends Error {
  override name = 'TelegramError';
  constructor(
    readonly method: string,
    readonly status: number,
    description: string,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
  }
}

type RawChat = { id: number; type: string; title?: string; username?: string; first_name?: string };
type RawMessage = {
  message_id: number;
  date?: number;
  chat?: RawChat;
  from?: { username?: string; first_name?: string };
  text?: string;
  caption?: string;
};
type RawUpdate = {
  update_id: number;
  message?: RawMessage;
  edited_message?: RawMessage;
  channel_post?: RawMessage;
  edited_channel_post?: RawMessage;
};

const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post'];

function chatTitle(chat: RawChat): string {
  return chat.title ?? chat.username ?? chat.first_name ?? String(chat.id);
}

/** A text message, or undefined for anything else (stickers, service messages, malformed). */
function toMessage(raw: RawMessage | undefined): TgMessage | undefined {
  const text = raw?.text ?? raw?.caption;
  if (!raw || typeof text !== 'string' || !text || !raw.chat || typeof raw.date !== 'number') {
    return undefined;
  }
  const title = chatTitle(raw.chat);
  return {
    chatId: raw.chat.id,
    chatTitle: title,
    chatType: raw.chat.type,
    messageId: raw.message_id,
    from: raw.from?.username ?? raw.from?.first_name ?? title,
    text,
    sentAt: raw.date * 1000,
  };
}

export function createTelegramApi(token: string, fetchFn: typeof fetch = fetch): TelegramApi {
  async function call<T>(method: string, body: object, timeoutMs: number): Promise<T> {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!res.ok || json.ok !== true) {
      throw new TelegramError(method, res.status, json.description ?? res.statusText);
    }
    return json.result as T;
  }

  return {
    async getUpdates(offset, timeoutSec) {
      const raw = await call<RawUpdate[]>(
        'getUpdates',
        { offset, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES },
        (timeoutSec + 10) * 1000,
      );
      // One odd update must never stop the offset from moving past it.
      return raw.map((u) => {
        let message: TgMessage | undefined;
        try {
          message = toMessage(
            u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post,
          );
        } catch {
          message = undefined;
        }
        return message ? { updateId: u.update_id, message } : { updateId: u.update_id };
      });
    },
    async sendMessage(chatId, text, replyTo) {
      await call(
        'sendMessage',
        {
          chat_id: chatId,
          text,
          ...(replyTo !== undefined
            ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
            : {}),
        },
        15_000,
      );
    },
    async getMe() {
      const me = await call<{ username?: string }>('getMe', {}, 15_000);
      return { username: me.username ?? '' };
    },
  };
}

const POLL_TIMEOUT_SEC = 25;
const CONFLICT_BACKOFF_MS = 30_000;
const ERROR_BACKOFF_MS = 5_000;

/**
 * Long-polls the bot and hands every text message to `onMessage`. Nothing it meets ends the loop:
 * another server polling the same bot (409), Telegram being unreachable and a handler that throws
 * are logged once per streak and waited out.
 */
export class TelegramPoller {
  private running = false;
  private offset = 0;
  private failing: 'conflict' | 'error' | null = null;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: {
      api: TelegramApi;
      onMessage(m: TgMessage): void;
      log?: (line: string) => void;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let updates: TgUpdate[];
      try {
        updates = await this.deps.api.getUpdates(this.offset, POLL_TIMEOUT_SEC);
        this.failing = null;
      } catch (e) {
        const conflict = e instanceof TelegramError && e.status === 409;
        const kind = conflict ? 'conflict' : 'error';
        if (this.failing !== kind) {
          this.log(
            conflict
              ? '[telegram] another server is polling this bot; retrying every 30 s'
              : `[telegram] poll failed (${e instanceof Error ? e.message : String(e)}); retrying`,
          );
        }
        this.failing = kind;
        await this.sleep(conflict ? CONFLICT_BACKOFF_MS : ERROR_BACKOFF_MS);
        continue;
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.updateId + 1);
        if (!u.message || !this.running) continue;
        try {
          this.deps.onMessage(u.message);
        } catch (e) {
          this.log(`[telegram] message handler failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }
}
