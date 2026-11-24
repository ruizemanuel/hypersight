import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const valid = {
  HL_ACCOUNT_ADDRESS: '0x1111111111111111111111111111111111111111',
  HL_AGENT_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ELEVENLABS_API_KEY: 'el-test',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  SESSION_TOKEN: 'session-token-0123456789',
};

describe('loadConfig', () => {
  it('defaults to the testnet executor, testnet endpoints and documented defaults', () => {
    const cfg = loadConfig(valid);
    expect(cfg.executor).toBe('testnet');
    expect(cfg.hlApiUrl).toBe('https://api.hyperliquid-testnet.xyz');
    expect(cfg.hlWsUrl).toBe('wss://api.hyperliquid-testnet.xyz/ws');
    expect(cfg.port).toBe(8787);
    expect(cfg.dbPath).toBe('./data/hypersight.sqlite');
    expect(cfg.intentModel).toBe('claude-opus-5-5');
    expect(cfg.tonAddress).toBeUndefined();
  });

  it.each([
    ['HL_API_URL', 'https://api.hyperliquid.xyz'],
    ['HL_WS_URL', 'wss://api.hyperliquid.xyz/ws'],
    ['HL_API_URL', 'https://api.hyperliquid-testnet.xyz.evil.com'],
    ['HL_API_URL', 'not a url'],
  ])('refuses a non-testnet Hyperliquid URL in %s (%s)', (key, url) => {
    expect(() => loadConfig({ ...valid, [key]: url })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, [key]: url })).toThrow(/testnet/);
  });

  it('names a missing required variable without echoing any secret value', () => {
    const { SESSION_TOKEN: _omit, ...env } = valid;
    expect(() => loadConfig(env)).toThrow(/SESSION_TOKEN/);
  });

  it('treats empty strings as unset (as copied from .env.example)', () => {
    expect(() => loadConfig({ ...valid, ENCRYPTION_KEY: '' })).toThrow(/ENCRYPTION_KEY/);
    expect(loadConfig({ ...valid, EXECUTOR: '', PORT: '' }).executor).toBe('testnet');
  });

  it('rejects malformed keys without including the value in the message', () => {
    try {
      loadConfig({ ...valid, HL_AGENT_PRIVATE_KEY: '0xdeadbeef' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String(e)).toMatch(/HL_AGENT_PRIVATE_KEY/);
      expect(String(e)).not.toMatch(/deadbeef/);
    }
    expect(() => loadConfig({ ...valid, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...valid, HL_ACCOUNT_ADDRESS: '0x123' })).toThrow(
      /HL_ACCOUNT_ADDRESS/,
    );
  });

  it('does not need the agent key unless the executor is testnet', () => {
    const { HL_AGENT_PRIVATE_KEY: _omit, ...env } = valid;
    expect(() => loadConfig(env)).toThrow(/HL_AGENT_PRIVATE_KEY/);
    expect(loadConfig({ ...env, EXECUTOR: 'paper' }).agentPrivateKey).toBeUndefined();
  });

  it('pairs devices instead of using an agent key from the environment when PAIRING=1', () => {
    const cfg = loadConfig({ ...valid, PAIRING: '1' });
    expect(cfg.pairing).toBe(true);
    expect(cfg.agentPrivateKey).toBeUndefined();
    // The account address then only pins which master may pair.
    expect(cfg.accountAddress).toBe(valid.HL_ACCOUNT_ADDRESS);
    const { HL_AGENT_PRIVATE_KEY: _k, HL_ACCOUNT_ADDRESS: _a, ...bare } = valid;
    const open = loadConfig({ ...bare, PAIRING: '1' });
    expect(open.accountAddress).toBeUndefined();
    expect(loadConfig(valid).pairing).toBe(false);
  });

  it('transcribes English by default and lets the provider detect the language with VOICE_LANG=multi', () => {
    expect(loadConfig(valid).voiceLang).toBe('en');
    expect(loadConfig({ ...valid, VOICE_LANG: 'multi' }).voiceLang).toBe('multi');
    expect(() => loadConfig({ ...valid, VOICE_LANG: 'es' })).toThrow(/VOICE_LANG/);
  });

  it('rejects an unknown executor', () => {
    expect(() => loadConfig({ ...valid, EXECUTOR: 'mainnet' })).toThrow(/EXECUTOR/);
  });

  it('reads optional overrides', () => {
    const cfg = loadConfig({
      ...valid,
      PORT: '9000',
      EXECUTOR: 'fake',
      DB_PATH: ':memory:',
      INTENT_MODEL: 'claude-sonnet-5-5',
      TON_ADDRESS: 'EQabc',
    });
    expect(cfg).toMatchObject({
      port: 9000,
      executor: 'fake',
      dbPath: ':memory:',
      intentModel: 'claude-sonnet-5-5',
      tonAddress: 'EQabc',
    });
  });
});
