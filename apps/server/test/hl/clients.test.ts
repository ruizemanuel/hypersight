import type { HttpTransport } from '@nktkas/hyperliquid';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config';
import { createHlClients } from '../../src/hl/clients';

const base: Config = {
  port: 0,
  hlApiUrl: 'https://api.hyperliquid-testnet.xyz',
  hlWsUrl: 'wss://api.hyperliquid-testnet.xyz/ws',
  accountAddress: '0x1111111111111111111111111111111111111111',
  agentPrivateKey: `0x${'ab'.repeat(32)}`,
  pairing: false,
  anthropicKey: undefined,
  elevenLabsKey: undefined,
  encryptionKey: 'cd'.repeat(32),
  sessionToken: 'session-token-0123456789',
  executor: 'testnet',
  dbPath: ':memory:',
  intentModel: 'claude-opus-5-5',
  tonAddress: undefined,
};

describe('createHlClients', () => {
  it('has no exchange client unless the executor is testnet', () => {
    expect(
      createHlClients({ ...base, executor: 'paper', agentPrivateKey: undefined }).exchange,
    ).toBeNull();
    expect(
      createHlClients({ ...base, executor: 'fake', agentPrivateKey: undefined }).exchange,
    ).toBeNull();
  });

  it('builds a testnet exchange client signed by the agent key', () => {
    const hl = createHlClients(base);
    expect(hl.exchange).not.toBeNull();
    expect(hl.info.config_.transport.isTestnet).toBe(true);
    expect(String((hl.info.config_.transport as HttpTransport).apiUrl)).toBe(
      'https://api.hyperliquid-testnet.xyz',
    );
  });

  it('refuses to construct clients for a non-testnet URL even if config validation was bypassed', () => {
    expect(() => createHlClients({ ...base, hlApiUrl: 'https://api.hyperliquid.xyz' })).toThrow(
      /testnet/,
    );
    expect(() => createHlClients({ ...base, hlWsUrl: 'wss://api.hyperliquid.xyz/ws' })).toThrow(
      /testnet/,
    );
  });

  it('has no exchange of its own when pairing, and signs with a paired agent key on demand', () => {
    const hl = createHlClients({ ...base, pairing: true, agentPrivateKey: undefined });
    expect(hl.exchange).toBeNull();
    const ex = hl.exchangeFor(`0x${'cd'.repeat(32)}`);
    expect(ex.config_.transport.isTestnet).toBe(true);
  });

  it('fails clearly when the testnet executor has no agent key', () => {
    expect(() => createHlClients({ ...base, agentPrivateKey: undefined })).toThrow(
      /HL_AGENT_PRIVATE_KEY/,
    );
  });
});
