import type { CardModel, ServerMsg } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session/session';

class FakeWs {
  readyState = 1;
  sent: ServerMsg[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

const card: CardModel = {
  id: 'account',
  kind: 'account',
  title: 'ACCOUNT',
  value: '$999.73',
  lines: [],
  hint: 'HOLD to speak',
  badge: 'TESTNET',
  actions: [],
};

describe('Session', () => {
  it('stamps sequenced messages with increasing seq and leaves error/pong unsequenced', () => {
    const s = new Session('s1');
    const ws = new FakeWs();
    s.attach(ws);
    s.send({ t: 'deck', cards: [card] });
    s.send({ t: 'error', code: 'x', message: 'y' });
    s.send({ t: 'overlay', overlay: { kind: 'thinking' } });
    expect(ws.sent).toEqual([
      { t: 'welcome', sessionId: 's1', seq: 1, serverTime: expect.any(Number) },
      { t: 'deck', seq: 2, cards: [card] },
      { t: 'error', code: 'x', message: 'y' },
      { t: 'overlay', seq: 3, overlay: { kind: 'thinking' } },
    ]);
  });

  it('replays the latest deck and overlay to a client resuming from lastSeq 0', () => {
    const s = new Session('s1');
    s.send({ t: 'deck', cards: [] });
    s.send({ t: 'deck', cards: [card] });
    s.send({ t: 'overlay', overlay: { kind: 'thinking' } });
    const ws = new FakeWs();
    s.attach(ws, 0);
    expect(ws.sent).toEqual([
      { t: 'welcome', sessionId: 's1', seq: 4, serverTime: expect.any(Number) },
      { t: 'deck', seq: 2, cards: [card] },
      { t: 'overlay', seq: 3, overlay: { kind: 'thinking' } },
    ]);
  });

  it('sends only welcome to a client that already has everything', () => {
    const s = new Session('s1');
    const first = new FakeWs();
    s.attach(first);
    s.send({ t: 'deck', cards: [card] });
    s.send({ t: 'overlay', overlay: null });
    s.detach(first);
    const again = new FakeWs();
    s.attach(again, 3);
    expect(again.sent).toEqual([
      { t: 'welcome', sessionId: 's1', seq: 4, serverTime: expect.any(Number) },
    ]);
  });

  it('replays only what the client missed', () => {
    const s = new Session('s1');
    s.send({ t: 'deck', cards: [card] }); // seq 1
    s.send({ t: 'overlay', overlay: { kind: 'thinking' } }); // seq 2
    const ws = new FakeWs();
    s.attach(ws, 1);
    expect(ws.sent.map((m) => m.t)).toEqual(['welcome', 'overlay']);
  });

  it('drops messages while detached but keeps them for the snapshot', () => {
    const s = new Session('s1');
    const ws = new FakeWs();
    s.attach(ws);
    s.detach(ws);
    s.send({ t: 'deck', cards: [card] });
    expect(ws.sent).toHaveLength(1);
    expect(s.snapshot()).toEqual([{ t: 'deck', seq: 2, cards: [card] }]);
  });

  it('closes a previous connection when a new one attaches', () => {
    const s = new Session('s1');
    const a = new FakeWs();
    const b = new FakeWs();
    s.attach(a);
    s.attach(b);
    expect(a.closed?.code).toBe(4000);
    s.send({ t: 'pong' });
    expect(b.sent.at(-1)).toEqual({ t: 'pong' });
    expect(a.sent.at(-1)).toEqual({
      t: 'welcome',
      sessionId: 's1',
      seq: 1,
      serverTime: expect.any(Number),
    });
  });

  it('ignores a stale detach from a replaced connection', () => {
    const s = new Session('s1');
    const a = new FakeWs();
    const b = new FakeWs();
    s.attach(a);
    s.attach(b);
    s.detach(a);
    expect(s.attached).toBe(true);
  });

  it('replays the full snapshot when the client cursor is ahead of this session (server restarted)', () => {
    const s = new Session('s2');
    s.send({ t: 'deck', cards: [card] }); // seq 1
    s.send({ t: 'overlay', overlay: { kind: 'thinking' } }); // seq 2
    const ws = new FakeWs();
    s.attach(ws, 4000);
    expect(ws.sent.map((m) => m.t)).toEqual(['welcome', 'deck', 'overlay']);
  });

  it('replays the full snapshot when the client resumes a different session id', () => {
    const s = new Session('s2');
    s.send({ t: 'deck', cards: [card] }); // seq 1
    s.send({ t: 'overlay', overlay: { kind: 'thinking' } }); // seq 2
    s.send({ t: 'overlay', overlay: null }); // seq 3
    const ws = new FakeWs();
    s.attach(ws, 2, 'old-session');
    expect(ws.sent.map((m) => m.t)).toEqual(['welcome', 'deck', 'overlay']);
    const same = new FakeWs();
    s.attach(same, 3, 's2');
    expect(same.sent.map((m) => m.t)).toEqual(['welcome']);
  });

  it('survives a throwing attach/detach listener', () => {
    const s = new Session('s1');
    s.on('attach', () => {
      throw new Error('listener bug');
    });
    s.on('detach', () => {
      throw new Error('listener bug');
    });
    const ws = new FakeWs();
    expect(() => s.attach(ws)).not.toThrow();
    expect(() => s.detach(ws)).not.toThrow();
  });
});
