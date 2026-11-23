import type { CardModel } from '@hypersight/protocol';
import type { Session } from '../session/session';

export type DeckPublisherDeps = {
  build: () => CardModel[];
  sessions: () => Session[];
  onError?: (err: unknown) => void;
};

/** Pushes the deck to sessions only when it changed for them (every push is a BLE write). */
export function createDeckPublisher(deps: DeckPublisherDeps) {
  const lastSent = new WeakMap<Session, string>();

  function build(): CardModel[] | null {
    try {
      return deps.build();
    } catch (err) {
      deps.onError?.(err);
      return null;
    }
  }

  function sendIfChanged(session: Session, cards: CardModel[], json: string): void {
    if (lastSent.get(session) === json) return;
    lastSent.set(session, json);
    session.send({ t: 'deck', cards });
  }

  return {
    publish(): void {
      const cards = build();
      if (!cards) return;
      const json = JSON.stringify(cards);
      for (const s of deps.sessions()) sendIfChanged(s, cards, json);
    },
    publishTo(session: Session): void {
      const cards = build();
      if (cards) sendIfChanged(session, cards, JSON.stringify(cards));
    },
  };
}
