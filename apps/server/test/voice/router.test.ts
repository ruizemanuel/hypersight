import type { ServerMsg } from '@hypersight/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/session/session';
import { VoiceRouter } from '../../src/voice/router';
import type { SttFactory, SttStream } from '../../src/voice/stt';

class FakeStt implements SttStream {
  audio: Buffer[] = [];
  closed = false;
  constructor(
    readonly opts: Parameters<SttFactory>[0],
    private readonly final: string,
  ) {}
  send(pcm: Buffer): void {
    this.audio.push(pcm);
  }
  async finish(): Promise<string> {
    return this.final;
  }
  close(): void {
    this.closed = true;
  }
}

function setup(final = 'close half my eth') {
  const streams: FakeStt[] = [];
  const factory: SttFactory = (opts) => {
    const s = new FakeStt(opts, final);
    streams.push(s);
    return s;
  };
  const transcripts: string[] = [];
  const timings: { sttMs?: number }[] = [];
  const router = new VoiceRouter({
    factory,
    keyterms: () => ['ETH'],
    onTranscript: async (_session, text, timing) => {
      transcripts.push(text);
      timings.push(timing);
    },
  });
  const session = new Session('s1');
  const sent: ServerMsg[] = [];
  session.attach({ readyState: 1, send: (d) => sent.push(JSON.parse(d)), close: () => {} });
  return { router, session, streams, transcripts, timings, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceRouter', () => {
  it('opens a stream on voice start, routes audio and hands the final transcript on voice end', async () => {
    const { router, session, streams, transcripts } = setup();
    router.start(session);
    router.audio(session, Buffer.from([1, 2]));
    await router.end(session);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.opts.keyterms).toEqual(['ETH']);
    expect(streams[0]?.audio).toEqual([Buffer.from([1, 2])]);
    expect(transcripts).toEqual(['close half my eth']);
  });

  it('measures voice end → final transcript for the stage timings', async () => {
    const { router, session, timings } = setup();
    router.start(session);
    await router.end(session);
    expect(timings[0]?.sttMs).toBeGreaterThanOrEqual(0);
  });

  it('pushes partial transcripts as a debounced listening overlay', () => {
    const { router, session, streams, sent } = setup();
    router.start(session);
    const onPartial = streams[0]?.opts.onPartial as (t: string) => void;
    onPartial('close');
    onPartial('close half');
    vi.advanceTimersByTime(100);
    onPartial('close half my');
    vi.advanceTimersByTime(200);
    const listening = sent.filter((m) => m.t === 'overlay');
    expect(listening).toHaveLength(1);
    expect(listening[0]).toMatchObject({
      overlay: { kind: 'listening', transcript: 'close half my' },
    });
  });

  // 2×TAP while listening abandons the utterance.
  it('drops the stream, skips the transcript and clears the overlay on voice cancel', async () => {
    const { router, session, streams, transcripts, sent } = setup();
    router.start(session);
    const onPartial = streams[0]?.opts.onPartial as (t: string) => void;
    onPartial('close half');
    router.cancel(session);
    await vi.advanceTimersByTimeAsync(500);
    expect(streams[0]?.closed).toBe(true);
    expect(transcripts).toEqual([]);
    const overlays = sent.filter((m) => m.t === 'overlay');
    expect(overlays).toEqual([expect.objectContaining({ overlay: null })]);
  });

  it('ignores audio without an open stream and replaces a stale stream on a new start', () => {
    const { router, session, streams } = setup();
    router.audio(session, Buffer.from([9]));
    router.start(session);
    router.start(session);
    expect(streams).toHaveLength(2);
    expect(streams[0]?.closed).toBe(true);
  });

  it('closes the stream when the session detaches', () => {
    const { router, session, streams } = setup();
    router.start(session);
    router.drop(session);
    expect(streams[0]?.closed).toBe(true);
  });

  it('reports an empty transcript as "Didn\'t catch that" and skips intent parsing', async () => {
    const { router, session, transcripts, sent } = setup('  ');
    router.start(session);
    await router.end(session);
    expect(transcripts).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ t: 'overlay', overlay: { kind: 'result', ok: false } });
  });

  it('tells the HUD voice is unavailable when no provider is configured', async () => {
    const session = new Session('s1');
    const sent: ServerMsg[] = [];
    session.attach({ readyState: 1, send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    const router = new VoiceRouter({
      factory: null,
      keyterms: () => [],
      onTranscript: async () => {},
    });
    router.start(session);
    await router.end(session);
    expect(sent.filter((m) => m.t === 'overlay')).toEqual([
      expect.objectContaining({
        overlay: { kind: 'error', message: 'Voice unavailable — use TAP actions' },
      }),
    ]);
  });
});
