import { describe, expect, it } from 'vitest';
import {
  type CardModel,
  ClientMsgSchema,
  DEFAULT_RISK_LIMITS,
  DEFAULT_SETTINGS,
  ServerMsgSchema,
  SettingsSchema,
} from '../src/index';

const card: CardModel = {
  id: 'perp:ETH',
  kind: 'perp',
  title: 'ETH LONG 2×',
  value: '+$42.10 (+3.1%)',
  lines: ['0.5 ETH @ 3,370', 'liq $2,950'],
  hint: 'TAP actions · HOLD speak',
  badge: 'TESTNET',
  actions: [
    {
      id: 'close-50',
      label: 'Close 50%',
      intent: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 },
    },
  ],
};

describe('ClientMsgSchema', () => {
  it('accepts a hello without lastSeq', () => {
    expect(ClientMsgSchema.parse({ t: 'hello', token: 'x' })).toEqual({ t: 'hello', token: 'x' });
  });

  it('accepts a resuming hello and a voice phase', () => {
    expect(ClientMsgSchema.parse({ t: 'hello', token: 'x', lastSeq: 7 })).toMatchObject({
      lastSeq: 7,
    });
    expect(ClientMsgSchema.parse({ t: 'voice', phase: 'end' })).toEqual({
      t: 'voice',
      phase: 'end',
    });
  });

  it('rejects an unknown message type', () => {
    expect(() => ClientMsgSchema.parse({ t: 'order', coin: 'ETH' })).toThrow();
  });
});

describe('ServerMsgSchema', () => {
  it('accepts a deck of valid cards', () => {
    expect(ServerMsgSchema.parse({ t: 'deck', seq: 1, cards: [card] })).toMatchObject({
      t: 'deck',
      seq: 1,
    });
  });

  it('rejects a card with more than 3 lines', () => {
    expect(() =>
      ServerMsgSchema.parse({
        t: 'deck',
        seq: 1,
        cards: [{ ...card, lines: ['a', 'b', 'c', 'd'] }],
      }),
    ).toThrow();
  });

  it('rejects a quick action label longer than 24 characters', () => {
    const action = { ...card.actions[0], label: 'Close fifty percent of ETH' };
    expect(() =>
      ServerMsgSchema.parse({ t: 'deck', seq: 1, cards: [{ ...card, actions: [action] }] }),
    ).toThrow();
  });

  it('rejects a card with more than 5 actions', () => {
    const action = card.actions[0];
    expect(() =>
      ServerMsgSchema.parse({
        t: 'deck',
        seq: 1,
        cards: [{ ...card, actions: [action, action, action, action, action, action] }],
      }),
    ).toThrow();
  });

  it('accepts a confirm overlay and a cleared overlay', () => {
    const confirm = {
      t: 'overlay',
      seq: 2,
      overlay: {
        kind: 'confirm',
        proposal: {
          id: 'p1',
          title: 'CLOSE 50% ETH LONG',
          lines: ['0.25 ETH ≈ $852 @ ~3,411'],
          expiresAt: 1_700_000_015_000,
        },
      },
    };
    expect(ServerMsgSchema.parse(confirm)).toMatchObject({ overlay: { kind: 'confirm' } });
    expect(ServerMsgSchema.parse({ t: 'overlay', seq: 3, overlay: null })).toEqual({
      t: 'overlay',
      seq: 3,
      overlay: null,
    });
  });
});

describe('settings defaults', () => {
  it('are valid against their own schema', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('enable only the core perp coins', () => {
    expect(DEFAULT_RISK_LIMITS.allowedCoins).toEqual(['BTC', 'ETH', 'SOL', 'HYPE']);
  });
});
