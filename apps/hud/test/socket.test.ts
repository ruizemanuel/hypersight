import type { ServerMsg } from '@hypersight/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudSocket } from '../src/net/socket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  push(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  json(): unknown[] {
    return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d as string));
  }
}

const make = () =>
  new HudSocket('ws://server/ws', 'tok', {
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HudSocket', () => {
  it('sends hello without lastSeq on the first open', () => {
    const s = make();
    s.connect();
    FakeWebSocket.instances[0]?.open();
    expect(FakeWebSocket.instances[0]?.json()).toEqual([{ t: 'hello', token: 'tok' }]);
  });

  it('reconnects with backoff and resumes from the highest seq received', () => {
    const s = make();
    const got: ServerMsg[] = [];
    s.onMessage((m) => got.push(m));
    s.connect();
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    first.open();
    first.push({ t: 'welcome', sessionId: 'x', seq: 1 });
    first.push({ t: 'deck', seq: 3, cards: [] });
    first.push({ t: 'overlay', seq: 2, overlay: null });
    first.push({ t: 'pong' });
    expect(got.map((m) => m.t)).toEqual(['welcome', 'deck', 'overlay', 'pong']);
    first.close();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    const second = FakeWebSocket.instances[1] as FakeWebSocket;
    second.open();
    expect(second.json()[0]).toEqual({ t: 'hello', token: 'tok', lastSeq: 3, sessionId: 'x' });
  });

  it('does not advance the resume cursor on welcome (a drop before the replay loses nothing)', () => {
    const s = make();
    s.connect();
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    first.open();
    first.push({ t: 'welcome', sessionId: 'x', seq: 1 });
    first.push({ t: 'deck', seq: 3, cards: [] });
    first.close();
    vi.advanceTimersByTime(500);
    const second = FakeWebSocket.instances[1] as FakeWebSocket;
    second.open();
    // server welcomes with seq 5, then the link drops before the replayed overlay #4 arrives
    second.push({ t: 'welcome', sessionId: 'x', seq: 5 });
    second.close();
    vi.advanceTimersByTime(500);
    const third = FakeWebSocket.instances[2] as FakeWebSocket;
    third.open();
    expect(third.json()[0]).toMatchObject({ lastSeq: 3, sessionId: 'x' });
  });

  it('resets the resume cursor when the server reports a new session', () => {
    const s = make();
    s.connect();
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    first.open();
    first.push({ t: 'welcome', sessionId: 'old', seq: 1 });
    first.push({ t: 'deck', seq: 4000, cards: [] });
    first.close();
    vi.advanceTimersByTime(500);
    const second = FakeWebSocket.instances[1] as FakeWebSocket;
    second.open();
    expect(second.json()[0]).toEqual({ t: 'hello', token: 'tok', lastSeq: 4000, sessionId: 'old' });
    second.push({ t: 'welcome', sessionId: 'new', seq: 1 });
    second.push({ t: 'overlay', seq: 2, overlay: null });
    second.close();
    vi.advanceTimersByTime(500);
    const third = FakeWebSocket.instances[2] as FakeWebSocket;
    third.open();
    expect(third.json()[0]).toEqual({ t: 'hello', token: 'tok', lastSeq: 2, sessionId: 'new' });
  });

  it('stops reconnecting when replaced by another device, until asked to reconnect', () => {
    const s = make();
    const statuses: string[] = [];
    s.onStatus((st) => statuses.push(st));
    s.connect();
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.close(4000);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe('replaced');
    s.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops reconnecting on an authentication failure', () => {
    const s = make();
    const statuses: string[] = [];
    s.onStatus((st) => statuses.push(st));
    s.connect();
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.close(4401);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe('unauthorized');
  });

  it('abandons a silent socket and reconnects (half-open link)', () => {
    const s = make();
    const statuses: string[] = [];
    s.onStatus((st) => statuses.push(st));
    s.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.open();
    vi.advanceTimersByTime(61_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain('closed');
    expect(s.send({ t: 'dismiss' })).toBe(false);
  });

  it('keeps a socket that keeps answering', () => {
    const s = make();
    s.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.open();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20_000);
      ws.push({ t: 'pong' });
    }
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('probes the link on demand and reconnects when nothing answers', () => {
    const s = make();
    s.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.open();
    s.probe();
    expect(ws.json().at(-1)).toEqual({ t: 'ping' });
    vi.advanceTimersByTime(5_100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('keeps the socket when a probe is answered', () => {
    const s = make();
    s.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.open();
    s.probe();
    vi.advanceTimersByTime(1_000);
    ws.push({ t: 'pong' });
    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('doubles the reconnect delay up to 8 s and resets it after a successful open', () => {
    const s = make();
    s.connect();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.instances.at(-1)?.close();
      let waited = 0;
      while (FakeWebSocket.instances.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    FakeWebSocket.instances.at(-1)?.open();
    FakeWebSocket.instances.at(-1)?.close();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(8);
  });

  it('reports status changes and drops messages sent while disconnected', () => {
    const s = make();
    const statuses: string[] = [];
    s.onStatus((st) => statuses.push(st));
    s.connect();
    expect(s.send({ t: 'dismiss' })).toBe(false);
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.open();
    expect(s.send({ t: 'dismiss' })).toBe(true);
    ws.close();
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
    expect(ws.json()).toEqual([{ t: 'hello', token: 'tok' }, { t: 'dismiss' }]);
  });

  it('sends audio as binary frames only while open', () => {
    const s = make();
    s.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    s.sendAudio(new Uint8Array([1]));
    ws.open();
    s.sendAudio(new Uint8Array([2, 3]));
    expect(ws.sent.filter((d) => d instanceof Uint8Array)).toEqual([new Uint8Array([2, 3])]);
  });

  it('pings every 20 s while open', () => {
    const s = make();
    s.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.open();
    vi.advanceTimersByTime(40_000);
    expect(ws.json().filter((m) => (m as { t: string }).t === 'ping')).toHaveLength(2);
  });

  it('ignores malformed server messages', () => {
    const s = make();
    const got: ServerMsg[] = [];
    s.onMessage((m) => got.push(m));
    s.connect();
    const ws = FakeWebSocket.instances[0] as FakeWebSocket;
    ws.open();
    ws.onmessage?.({ data: '{"t":"deck","seq":"x"}' });
    ws.onmessage?.({ data: 'not json' });
    expect(got).toEqual([]);
  });
});
