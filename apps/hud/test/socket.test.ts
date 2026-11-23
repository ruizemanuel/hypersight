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
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
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
    expect(second.json()[0]).toEqual({ t: 'hello', token: 'tok', lastSeq: 3 });
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
