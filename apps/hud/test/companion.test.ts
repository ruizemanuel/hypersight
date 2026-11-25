import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompanionApi, httpBaseFromWs } from '../src/companion/api';

describe('httpBaseFromWs', () => {
  it('derives the companion API origin from the socket URL', () => {
    expect(httpBaseFromWs('ws://192.168.1.5:8787/ws')).toBe('http://192.168.1.5:8787');
    expect(httpBaseFromWs('wss://hypersight.fly.dev/ws')).toBe('https://hypersight.fly.dev');
  });
});

describe('companion API client — Telegram', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    return calls;
  }

  it('lists the chats the bot has seen', async () => {
    const chat = {
      id: -100,
      title: 'Alpha calls',
      type: 'supergroup',
      follow: false,
      replyFills: false,
      seenAt: 1,
    };
    const calls = stubFetch([chat]);
    const api = createCompanionApi('https://hypersight.fly.dev', 'tok');
    expect(await api.telegramChats()).toEqual([chat]);
    expect(calls[0]?.url).toBe('https://hypersight.fly.dev/api/telegram/chats');
    expect(calls[0]?.init.method).toBe('GET');
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer tok');
  });

  it('follows a chat and turns on fill replies', async () => {
    const calls = stubFetch({ id: -100, follow: true });
    const api = createCompanionApi('https://hypersight.fly.dev', 'tok');
    await api.setTelegramChat(-100, { follow: true });
    await api.setTelegramChat(-100, { replyFills: false });
    expect(calls.map((c) => [c.url, c.init.method, c.init.body])).toEqual([
      ['https://hypersight.fly.dev/api/telegram/chats/-100', 'PUT', '{"follow":true}'],
      ['https://hypersight.fly.dev/api/telegram/chats/-100', 'PUT', '{"replyFills":false}'],
    ]);
  });
});
