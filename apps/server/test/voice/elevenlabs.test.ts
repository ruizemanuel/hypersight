import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { ElevenLabsStream } from '../../src/voice/elevenlabs';

type Chunk = { message_type: string; audio_base_64: string; commit: boolean; sample_rate: number };

type FakeServer = {
  url: string;
  req: () => IncomingMessage;
  socket: () => WebSocket;
  chunks: Chunk[];
  close: () => Promise<void>;
};

let server: FakeServer | null = null;

async function fakeElevenLabs(onChunk?: (c: Chunk, ws: WebSocket) => void, autoStart = true) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  let lastReq: IncomingMessage | null = null;
  let lastWs: WebSocket | null = null;
  const chunks: Chunk[] = [];
  wss.on('connection', (ws, req) => {
    lastReq = req;
    lastWs = ws;
    ws.on('message', (data) => {
      const c = JSON.parse(String(data)) as Chunk;
      chunks.push(c);
      onChunk?.(c, ws);
    });
    if (autoStart) ws.send(JSON.stringify({ message_type: 'session_started', session_id: 's' }));
  });
  const { port } = wss.address() as AddressInfo;
  server = {
    url: `ws://127.0.0.1:${port}/v1/speech-to-text/realtime`,
    req: () => lastReq as IncomingMessage,
    socket: () => lastWs as WebSocket,
    chunks,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
  return server;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

const decode = (c: Chunk) => Buffer.from(c.audio_base_64, 'base64');
const frame = (i: number) => Buffer.alloc(1600, i);

function stream(
  url: string,
  extra: Partial<ConstructorParameters<typeof ElevenLabsStream>[0]> = {},
) {
  const partials: string[] = [];
  const errors: Error[] = [];
  const s = new ElevenLabsStream({
    apiKey: 'test-key',
    url,
    onPartial: (t) => partials.push(t),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { s, partials, errors };
}

describe('ElevenLabsStream', () => {
  it('connects with the manual-commit realtime query, keyterms and the API key header', async () => {
    const fake = await fakeElevenLabs();
    const { s } = stream(fake.url, { keyterms: ['ETH', 'BTC'] });
    await expect.poll(() => fake.chunks.length >= 0 && fake.req() !== null).toBe(true);
    await expect.poll(() => !!fake.req()).toBe(true);
    const url = new URL(fake.req().url ?? '', 'http://x');
    expect(url.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
    expect(url.searchParams.get('commit_strategy')).toBe('manual');
    expect(url.searchParams.get('language_code')).toBe('en');
    expect(url.searchParams.getAll('keyterms')).toEqual(['ETH', 'BTC']);
    expect(fake.req().headers['xi-api-key']).toBe('test-key');
    s.close();
  });

  it('buffers audio until session_started and re-chunks to at least 100 ms, in order', async () => {
    const fake = await fakeElevenLabs(undefined, false);
    const { s } = stream(fake.url);
    for (let i = 0; i < 4; i++) s.send(frame(i));
    await expect.poll(() => !!fake.socket()).toBe(true);
    expect(fake.chunks).toHaveLength(0);
    fake.socket().send(JSON.stringify({ message_type: 'session_started', session_id: 's' }));
    for (let i = 4; i < 10; i++) s.send(frame(i));
    await expect.poll(() => fake.chunks.reduce((n, c) => n + decode(c).length, 0)).toBe(16_000);
    for (const c of fake.chunks) {
      expect(decode(c).length).toBeGreaterThanOrEqual(3200);
      expect(c).toMatchObject({
        message_type: 'input_audio_chunk',
        commit: false,
        sample_rate: 16000,
      });
    }
    const all = Buffer.concat(fake.chunks.map(decode));
    expect(all.equals(Buffer.concat(Array.from({ length: 10 }, (_, i) => frame(i))))).toBe(true);
    s.close();
  });

  it('commits on finish and resolves with the committed transcript', async () => {
    const fake = await fakeElevenLabs((c, ws) => {
      if (c.commit) {
        ws.send(JSON.stringify({ message_type: 'partial_transcript', text: 'close half' }));
        ws.send(
          JSON.stringify({ message_type: 'committed_transcript', text: 'close half my eth' }),
        );
      }
    });
    const { s, partials } = stream(fake.url);
    s.send(frame(1));
    s.send(frame(2));
    s.send(frame(3)); // 1600 bytes left over: flushed on finish
    const text = await s.finish();
    expect(text).toBe('close half my eth');
    expect(partials).toContain('close half');
    const last = fake.chunks.at(-1) as Chunk;
    expect(last).toMatchObject({ audio_base_64: '', commit: true, sample_rate: 16000 });
    expect(fake.chunks.reduce((n, c) => n + decode(c).length, 0)).toBe(4800);
  });

  it('reports a provider error and resolves finish with the last partial', async () => {
    const fake = await fakeElevenLabs((c, ws) => {
      if (!c.commit) {
        ws.send(JSON.stringify({ message_type: 'partial_transcript', text: 'buy twenty' }));
        ws.send(JSON.stringify({ message_type: 'quota_exceeded', error: 'Quota exceeded' }));
      }
    });
    const { s, errors } = stream(fake.url);
    s.send(Buffer.alloc(3200));
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/quota_exceeded/);
    expect(await s.finish()).toBe('buy twenty');
  });

  it('resolves with the last partial when the provider never commits', async () => {
    const fake = await fakeElevenLabs((c, ws) => {
      if (!c.commit)
        ws.send(JSON.stringify({ message_type: 'partial_transcript', text: 'odds on' }));
    });
    const { s } = stream(fake.url);
    s.send(Buffer.alloc(3200));
    await expect.poll(() => fake.chunks.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.finish(200)).toBe('odds on');
  });

  it('resolves empty when the connection fails', async () => {
    const { s, errors } = stream('ws://127.0.0.1:9/v1/speech-to-text/realtime');
    expect(await s.finish(500)).toBe('');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('caps keyterms at 50 terms of at most 20 characters', async () => {
    const fake = await fakeElevenLabs();
    const terms = Array.from({ length: 60 }, (_, i) => `term${i}`).concat(['x'.repeat(25)]);
    const { s } = stream(fake.url, { keyterms: terms });
    await expect.poll(() => !!fake.req()).toBe(true);
    const sent = new URL(fake.req().url ?? '', 'http://x').searchParams.getAll('keyterms');
    expect(sent).toHaveLength(50);
    expect(sent.every((t) => t.length <= 20)).toBe(true);
    s.close();
  });
});
