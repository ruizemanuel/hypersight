import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { ClientMsg, ServerMsg } from '@hypersight/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/http/app';
import { SessionRegistry } from '../src/session/registry';
import type { Session } from '../src/session/session';
import { startGateway } from '../src/ws/gateway';

const TOKEN = 'good-token-0123456789';

type Harness = {
  url: string;
  received: { session: Session; msg: ClientMsg }[];
  audio: Buffer[];
  close: () => Promise<void>;
};

let harness: Harness | null = null;

async function start(
  opts: { helloTimeoutMs?: number; heartbeatMs?: number } = {},
): Promise<Harness> {
  const app = createApp({ sessionToken: TOKEN });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    );
  });
  const received: Harness['received'] = [];
  const audio: Buffer[] = [];
  const gateway = startGateway(
    server,
    new SessionRegistry([TOKEN]),
    {
      onClientMsg: (session, msg) => {
        received.push({ session, msg });
      },
      onAudio: (_session, pcm) => {
        audio.push(pcm);
      },
    },
    opts,
  );
  const { port } = server.address() as AddressInfo;
  harness = {
    url: `ws://127.0.0.1:${port}`,
    received,
    audio,
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function connect(url: string, opts: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket): Promise<{ code: number; at: number }> {
  return new Promise((resolve) => ws.once('close', (code) => resolve({ code, at: Date.now() })));
}

function nextMessage(ws: WebSocket): Promise<ServerMsg> {
  return new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(String(data)))));
}

async function hello(h: Harness, lastSeq?: number): Promise<{ ws: WebSocket; welcome: ServerMsg }> {
  const ws = await connect(`${h.url}/ws`);
  const msg = nextMessage(ws);
  ws.send(JSON.stringify({ t: 'hello', token: TOKEN, lastSeq }));
  return { ws, welcome: await msg };
}

describe('startGateway', () => {
  it('closes a silent connection with 4401 after the hello timeout', async () => {
    const h = await start({ helloTimeoutMs: 300 });
    const t0 = Date.now();
    const ws = await connect(`${h.url}/ws`);
    const { code, at } = await closed(ws);
    expect(code).toBe(4401);
    expect(at - t0).toBeGreaterThanOrEqual(250);
  });

  it('closes with 4401 when the hello carries a wrong token', async () => {
    const h = await start();
    const ws = await connect(`${h.url}/ws`);
    const done = closed(ws);
    ws.send(JSON.stringify({ t: 'hello', token: 'wrong-token' }));
    expect((await done).code).toBe(4401);
  });

  it('closes with 4401 when the first message is not a hello', async () => {
    const h = await start();
    const ws = await connect(`${h.url}/ws`);
    const done = closed(ws);
    ws.send(JSON.stringify({ t: 'ping' }));
    expect((await done).code).toBe(4401);
  });

  it('welcomes a client with a good token', async () => {
    const h = await start();
    const { ws, welcome } = await hello(h);
    expect(welcome).toMatchObject({ t: 'welcome', seq: 1 });
    ws.close();
  });

  it('refuses upgrades on any path other than /ws', async () => {
    const h = await start();
    await expect(connect(`${h.url}/other`)).rejects.toThrow();
  });

  it('routes text messages to onClientMsg and binary frames to onAudio', async () => {
    const h = await start();
    const { ws } = await hello(h);
    ws.send(JSON.stringify({ t: 'voice', phase: 'start' }));
    ws.send(Buffer.from([1, 2, 3, 4]));
    ws.send(JSON.stringify({ t: 'voice', phase: 'end' }));
    await expect.poll(() => h.received.length).toBe(2);
    expect(h.received.map((r) => r.msg)).toEqual([
      { t: 'voice', phase: 'start' },
      { t: 'voice', phase: 'end' },
    ]);
    expect(h.audio).toEqual([Buffer.from([1, 2, 3, 4])]);
    ws.close();
  });

  it('answers an invalid message with bad_message and keeps the connection', async () => {
    const h = await start();
    const { ws } = await hello(h);
    const reply = nextMessage(ws);
    ws.send('{"t":"order","coin":"ETH"}');
    expect(await reply).toMatchObject({ t: 'error', code: 'bad_message' });
    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'ping' }));
    expect(await pong).toEqual({ t: 'pong' });
    ws.close();
  });

  it('resumes the same session for the same token and replays what was missed', async () => {
    const h = await start();
    const first = await hello(h);
    const session = h.received[0]?.session;
    expect(session).toBeUndefined();
    first.ws.send(JSON.stringify({ t: 'dismiss' }));
    await expect.poll(() => h.received.length).toBe(1);
    const s = h.received[0]?.session as Session;
    s.send({ t: 'overlay', overlay: { kind: 'thinking' } });
    first.ws.close();
    await expect.poll(() => s.attached).toBe(false);
    const ws = await connect(`${h.url}/ws`);
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: 'hello', token: TOKEN, lastSeq: 1 }));
    await expect.poll(() => msgs.length).toBe(2);
    expect(msgs).toEqual([
      { t: 'welcome', sessionId: s.id, seq: 3, serverTime: expect.any(Number) },
      { t: 'overlay', seq: 2, overlay: { kind: 'thinking' } },
    ]);
    ws.close();
  });

  it('replays everything to a client that resumes an unknown session id', async () => {
    const h = await start();
    const first = await hello(h);
    first.ws.send(JSON.stringify({ t: 'dismiss' }));
    await expect.poll(() => h.received.length).toBe(1);
    const s = h.received[0]?.session as Session;
    s.send({ t: 'overlay', overlay: { kind: 'thinking' } });
    first.ws.close();
    await expect.poll(() => s.attached).toBe(false);
    const ws = await connect(`${h.url}/ws`);
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: 'hello', token: TOKEN, lastSeq: 2, sessionId: 'previous-server' }));
    await expect.poll(() => msgs.length).toBe(2);
    expect(msgs.map((m) => m.t)).toEqual(['welcome', 'overlay']);
    ws.close();
  });

  it('terminates a connection that stops answering heartbeat pings', async () => {
    const h = await start({ heartbeatMs: 100 });
    const ws = await connect(`${h.url}/ws`, { autoPong: false });
    const done = closed(ws);
    ws.send(JSON.stringify({ t: 'hello', token: TOKEN }));
    const { at } = await done;
    expect(at).toBeGreaterThan(0);
  });

  it('keeps a connection that answers heartbeat pings', async () => {
    const h = await start({ heartbeatMs: 100 });
    const { ws } = await hello(h);
    await new Promise((r) => setTimeout(r, 450));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
