import { describe, expect, it } from 'vitest';
import { linkUrlFor, pairDevice, serverPairs } from '../src/net/pairing';

type Reply = { status: number; body?: unknown } | Error;

/** A scripted fetch: each route answers from its own queue (the last answer repeats). */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: { method?: string }) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const queue = key ? routes[key] : undefined;
    const next = (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? { status: 404 };
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const BASE = 'http://192.168.1.5:8787';
const noSleep = async () => {};

describe('serverPairs', () => {
  it('asks the server whether it pairs devices', async () => {
    const yes = fakeFetch({ '/health': [{ status: 200, body: { ok: true, pairing: true } }] });
    expect(await serverPairs(BASE, yes.fetch, noSleep)).toBe(true);
    const no = fakeFetch({ '/health': [{ status: 200, body: { ok: true, pairing: false } }] });
    expect(await serverPairs(BASE, no.fetch, noSleep)).toBe(false);
  });

  it('retries a server that is still starting, then gives up', async () => {
    const late = fakeFetch({
      '/health': [new Error('offline'), { status: 200, body: { pairing: true } }],
    });
    expect(await serverPairs(BASE, late.fetch, noSleep)).toBe(true);
    const down = fakeFetch({ '/health': [new Error('offline')] });
    expect(await serverPairs(BASE, down.fetch, noSleep)).toBe(false);
  });
});

describe('pairDevice', () => {
  it('shows the code, polls until the wallet approved it, and returns the device token', async () => {
    const { fetch } = fakeFetch({
      '/link/start': [
        { status: 200, body: { code: 'K7Q-4MD', deviceToken: 'tok-0123456789abcdef' } },
      ],
      '/link/status/': [
        { status: 200, body: { paired: false } },
        new Error('blip'),
        { status: 200, body: { paired: true } },
      ],
    });
    const shown: string[] = [];
    const token = await pairDevice({
      base: BASE,
      fetch,
      sleep: noSleep,
      onCode: (c) => shown.push(c),
    });
    expect(token).toBe('tok-0123456789abcdef');
    expect(shown).toEqual(['K7Q-4MD']);
  });

  it('starts over with a fresh code when the old one expires', async () => {
    const { fetch, calls } = fakeFetch({
      '/link/start': [
        { status: 200, body: { code: 'AAA-AAA', deviceToken: 'old-0123456789abcdef' } },
        { status: 200, body: { code: 'BBB-BBB', deviceToken: 'new-0123456789abcdef' } },
      ],
      '/link/status/AAA': [{ status: 404 }],
      '/link/status/BBB': [{ status: 200, body: { paired: true } }],
    });
    const shown: string[] = [];
    const token = await pairDevice({
      base: BASE,
      fetch,
      sleep: noSleep,
      onCode: (c) => shown.push(c),
    });
    expect(shown).toEqual(['AAA-AAA', 'BBB-BBB']);
    expect(token).toBe('new-0123456789abcdef');
    expect(calls.filter((c) => c === 'POST /link/start')).toHaveLength(2);
  });

  it('waits and retries when the server limits pairing starts', async () => {
    const { fetch } = fakeFetch({
      '/link/start': [
        { status: 429 },
        { status: 200, body: { code: 'CCC-CCC', deviceToken: 'tok-0123456789abcdef' } },
      ],
      '/link/status/': [{ status: 200, body: { paired: true } }],
    });
    const waits: number[] = [];
    const token = await pairDevice({
      base: BASE,
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      onCode: () => {},
    });
    expect(token).toBe('tok-0123456789abcdef');
    expect(waits[0]).toBeGreaterThanOrEqual(5000);
  });
});

describe('linkUrlFor', () => {
  it('shows the link page address without the scheme (it is typed on a computer)', () => {
    expect(linkUrlFor('http://192.168.1.5:8787')).toBe('192.168.1.5:8787/link');
    expect(linkUrlFor('https://hypersight.fly.dev')).toBe('hypersight.fly.dev/link');
  });
});
