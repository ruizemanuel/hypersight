import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramApi,
  type TelegramApi,
  TelegramError,
  TelegramPoller,
  type TgMessage,
} from '../../src/telegram/bot';

const TOKEN = '123456:secret-token';

type Reply = object | { status: number; body: object };

function fakeFetch(...responses: Reply[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const next = responses.shift() ?? { ok: true, result: [] };
    const { status, body } =
      'status' in next && 'body' in next
        ? (next as { status: number; body: object })
        : { status: 200, body: next };
    return new Response(JSON.stringify(body), { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('createTelegramApi', () => {
  it('asks for messages and channel posts (and their edits) from the given offset', async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: [] });
    await createTelegramApi(TOKEN, fn).getUpdates(42, 25);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[0]?.body).toEqual({
      offset: 42,
      timeout: 25,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
    });
  });

  it('maps group messages, channel posts and edits; keeps updates without text unmapped', async () => {
    const group = { id: -100, type: 'supergroup', title: 'Alpha calls' };
    const { fn } = fakeFetch({
      ok: true,
      result: [
        {
          update_id: 10,
          message: {
            message_id: 7,
            date: 1_764_072_000,
            chat: group,
            from: { id: 1, username: 'whale', first_name: 'W' },
            text: 'longing ETH here',
          },
        },
        {
          update_id: 11,
          channel_post: {
            message_id: 8,
            date: 1_764_072_001,
            chat: { id: -200, type: 'channel', title: 'Signals' },
            caption: 'short sol',
          },
        },
        {
          update_id: 12,
          edited_message: {
            message_id: 9,
            date: 1_764_070_000,
            edit_date: 1_764_072_002,
            chat: group,
            from: { id: 2, first_name: 'Ana' },
            text: 'compro yes en bitcoin',
          },
        },
        { update_id: 13, message: { message_id: 10, chat: group, sticker: {} } },
        { update_id: 14, my_chat_member: {} },
        {
          update_id: 15,
          message: {
            message_id: 11,
            date: 1_764_072_003,
            chat: { id: 5, type: 'private', first_name: 'Eve' },
            text: 'hi',
          },
        },
      ],
    });
    const updates = await createTelegramApi(TOKEN, fn).getUpdates(0, 25);
    expect(updates).toEqual([
      {
        updateId: 10,
        message: {
          chatId: -100,
          chatTitle: 'Alpha calls',
          chatType: 'supergroup',
          messageId: 7,
          from: 'whale',
          text: 'longing ETH here',
          sentAt: 1_764_072_000_000,
        },
      },
      {
        updateId: 11,
        message: {
          chatId: -200,
          chatTitle: 'Signals',
          chatType: 'channel',
          messageId: 8,
          from: 'Signals',
          text: 'short sol',
          sentAt: 1_764_072_001_000,
        },
      },
      {
        updateId: 12,
        message: {
          chatId: -100,
          chatTitle: 'Alpha calls',
          chatType: 'supergroup',
          messageId: 9,
          from: 'Ana',
          text: 'compro yes en bitcoin',
          // An edit keeps the time the message was first sent.
          sentAt: 1_764_070_000_000,
        },
      },
      { updateId: 13 },
      { updateId: 14 },
      {
        updateId: 15,
        message: {
          chatId: 5,
          chatTitle: 'Eve',
          chatType: 'private',
          messageId: 11,
          from: 'Eve',
          text: 'hi',
          sentAt: 1_764_072_003_000,
        },
      },
    ]);
  });

  it('skips a malformed update and still moves past it', async () => {
    const chat = { id: -100, type: 'group', title: 'G' };
    const { fn } = fakeFetch({
      ok: true,
      result: [
        { update_id: 5, message: { message_id: 1, date: 1, chat, text: 'a' } },
        { update_id: 6, message: { message_id: 2, date: 1, text: 'no chat' } },
        { update_id: 7, message: { message_id: 3, chat, text: 'no date' } },
        { update_id: 8, message: { message_id: 4, date: 1, chat, text: 'b' } },
      ],
    });
    const updates = await createTelegramApi(TOKEN, fn).getUpdates(0, 25);
    expect(updates.map((u) => [u.updateId, u.message?.text])).toEqual([
      [5, 'a'],
      [6, undefined],
      [7, undefined],
      [8, 'b'],
    ]);
  });

  it('fails with the HTTP status and never puts the token in the error', async () => {
    const { fn } = fakeFetch({
      status: 409,
      body: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates' },
    });
    const err = await createTelegramApi(TOKEN, fn)
      .getUpdates(0, 25)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).status).toBe(409);
    expect(String(err)).toMatch(/Conflict/);
    expect(String(err)).not.toContain('secret-token');
  });

  it('reads the bot username', async () => {
    const { fn, calls } = fakeFetch({
      ok: true,
      result: {
        id: 1,
        is_bot: true,
        first_name: 'HyperSight Desk',
        username: 'hypersight_desk_bot',
      },
    });
    expect(await createTelegramApi(TOKEN, fn).getMe()).toEqual({ username: 'hypersight_desk_bot' });
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('replies to a message in its chat', async () => {
    const { fn, calls } = fakeFetch({ ok: true, result: {} });
    await createTelegramApi(TOKEN, fn).sendMessage(-100, '✅ Filled', 7);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toEqual({
      chat_id: -100,
      text: '✅ Filled',
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
    });
  });
});

type Step = { updateId: number; message?: TgMessage }[] | Error;

const msg = (messageId: number, text: string): TgMessage => ({
  chatId: -100,
  chatTitle: 'Alpha calls',
  chatType: 'supergroup',
  messageId,
  from: 'whale',
  text,
  sentAt: 0,
});

/** Runs the poller over scripted getUpdates results, stopping it once the script is used up. */
async function runPoller(steps: Step[], onMessage: (m: TgMessage) => void = () => {}) {
  const offsets: number[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let poller: TelegramPoller | undefined;
  const done = new Promise<void>((resolve) => {
    const api: TelegramApi = {
      async getUpdates(offset) {
        offsets.push(offset);
        const step = steps.shift();
        if (step === undefined) {
          poller?.stop();
          resolve();
          return [];
        }
        if (step instanceof Error) throw step;
        return step;
      },
      async sendMessage() {},
      async getMe() {
        return { username: 'bot' };
      },
    };
    poller = new TelegramPoller({
      api,
      onMessage,
      log: (line) => logs.push(line),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    poller.start();
  });
  await done;
  await new Promise((r) => setTimeout(r, 0));
  return { offsets, sleeps, logs };
}

describe('TelegramPoller', () => {
  it('delivers messages in order and moves the offset past the last update', async () => {
    const seen: string[] = [];
    const { offsets } = await runPoller(
      [
        [
          { updateId: 5, message: msg(1, 'a') },
          { updateId: 6 },
          { updateId: 7, message: msg(2, 'b') },
        ],
      ],
      (m) => seen.push(m.text),
    );
    expect(seen).toEqual(['a', 'b']);
    expect(offsets).toEqual([0, 8]);
  });

  it('backs off 30 s when another server is polling the same bot, logging it once', async () => {
    const conflict = () => new TelegramError('getUpdates', 409, 'Conflict');
    const { sleeps, logs } = await runPoller([conflict(), conflict(), []]);
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/another/i);
  });

  it('retries after 5 s when Telegram is unreachable', async () => {
    const seen: string[] = [];
    const { sleeps, offsets } = await runPoller(
      [new TypeError('fetch failed'), [{ updateId: 9, message: msg(3, 'c') }]],
      (m) => seen.push(m.text),
    );
    expect(sleeps).toEqual([5_000]);
    expect(seen).toEqual(['c']);
    expect(offsets).toEqual([0, 0, 10]);
  });

  it('keeps polling when handling one message throws', async () => {
    const seen: string[] = [];
    const { offsets, logs } = await runPoller(
      [
        [
          { updateId: 1, message: msg(1, 'boom') },
          { updateId: 2, message: msg(2, 'ok') },
        ],
      ],
      (m) => {
        if (m.text === 'boom') throw new Error('handler failed');
        seen.push(m.text);
      },
    );
    expect(seen).toEqual(['ok']);
    expect(offsets).toEqual([0, 3]);
    expect(logs.some((l) => l.includes('handler failed'))).toBe(true);
  });

  it('stops polling once stopped', async () => {
    const { offsets } = await runPoller([[], []]);
    // Two scripted polls, then the poll that stops it: nothing after.
    expect(offsets).toEqual([0, 0, 0]);
  });
});
