import type { CardModel, ServerMsg } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import { createDeckPublisher } from '../../src/deck/publisher';
import { Session } from '../../src/session/session';

const card = (value: string): CardModel => ({
  id: 'account',
  kind: 'account',
  title: 'ACCOUNT',
  value,
  lines: [],
  hint: '',
  badge: 'TESTNET',
  actions: [],
});

function attached(id: string) {
  const s = new Session(id);
  const sent: ServerMsg[] = [];
  s.attach({ readyState: 1, send: (d) => sent.push(JSON.parse(d)), close: () => {} });
  return { s, sent, decks: () => sent.filter((m) => m.t === 'deck') };
}

describe('createDeckPublisher', () => {
  it('pushes the deck to every session and skips unchanged decks', () => {
    let value = '$1.00';
    const a = attached('a');
    const b = attached('b');
    const pub = createDeckPublisher({ build: () => [card(value)], sessions: () => [a.s, b.s] });
    pub.publish();
    pub.publish();
    expect(a.decks()).toHaveLength(1);
    expect(b.decks()).toHaveLength(1);
    value = '$2.00';
    pub.publish();
    expect(a.decks()).toHaveLength(2);
    expect(a.decks().at(-1)).toMatchObject({ cards: [{ value: '$2.00' }] });
  });

  it('sends a fresh deck to a session that has none yet', () => {
    const pub = createDeckPublisher({ build: () => [card('$1.00')], sessions: () => [] });
    const a = attached('a');
    pub.publishTo(a.s);
    expect(a.decks()).toHaveLength(1);
  });

  it('does not crash the caller when building the deck fails', () => {
    const a = attached('a');
    const errors: unknown[] = [];
    const pub = createDeckPublisher({
      build: () => {
        throw new Error('no data yet');
      },
      sessions: () => [a.s],
      onError: (e) => errors.push(e),
    });
    expect(() => pub.publish()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(a.decks()).toHaveLength(0);
  });
});
