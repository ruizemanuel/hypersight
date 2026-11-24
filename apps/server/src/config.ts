export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type Executor = 'testnet' | 'paper' | 'fake';

export type Config = {
  port: number;
  hlApiUrl: string;
  hlWsUrl: string;
  /**
   * Master account: every Hyperliquid query uses this address, never the agent's. In pairing mode
   * it is optional and only pins which master may pair.
   */
  accountAddress: string | undefined;
  /** Agent (API wallet) key; only present when the executor is `testnet` (never when pairing). */
  agentPrivateKey: string | undefined;
  /** PAIRING=1: the master and a trade-only agent come from device-code pairing (/link). */
  pairing: boolean;
  /** Speech-to-text language: English, or `multi` to let the provider detect it (Spanish too). */
  voiceLang: 'en' | 'multi';
  /** Missing key disables the Claude intent fallback (the fast grammar still works). */
  anthropicKey: string | undefined;
  /** Missing key disables voice (every action stays reachable by tap). */
  elevenLabsKey: string | undefined;
  encryptionKey: string;
  sessionToken: string;
  executor: Executor;
  dbPath: string;
  intentModel: string;
  tonAddress: string | undefined;
};

const TESTNET_API = 'https://api.hyperliquid-testnet.xyz';
const TESTNET_WS = 'wss://api.hyperliquid-testnet.xyz/ws';
const TESTNET_HOST = 'hyperliquid-testnet.xyz';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX32_RE = /^[0-9a-fA-F]{64}$/;

type Env = Record<string, string | undefined>;

/** Reads the environment. Error messages name the variable but never echo its value. */
export function loadConfig(env: Env): Config {
  const get = (key: string): string | undefined => {
    const v = env[key]?.trim();
    return v ? v : undefined;
  };
  const required = (key: string): string => {
    const v = get(key);
    if (v === undefined) throw new ConfigError(`Missing required environment variable ${key}`);
    return v;
  };
  const matching = (key: string, value: string, re: RegExp, what: string): string => {
    if (!re.test(value)) throw new ConfigError(`${key} must be ${what}`);
    return value;
  };

  const executorRaw = get('EXECUTOR') ?? 'testnet';
  if (executorRaw !== 'testnet' && executorRaw !== 'paper' && executorRaw !== 'fake') {
    throw new ConfigError('EXECUTOR must be one of testnet, paper, fake');
  }
  const executor: Executor = executorRaw;

  const voiceLang = get('VOICE_LANG') ?? 'en';
  if (voiceLang !== 'en' && voiceLang !== 'multi') {
    throw new ConfigError('VOICE_LANG must be en or multi');
  }

  const portRaw = get('PORT') ?? '8787';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('PORT must be an integer between 0 and 65535');
  }

  const pairing = get('PAIRING') === '1';
  const agentRaw =
    executor === 'testnet' && !pairing ? required('HL_AGENT_PRIVATE_KEY') : undefined;
  const accountRaw = pairing ? get('HL_ACCOUNT_ADDRESS') : required('HL_ACCOUNT_ADDRESS');

  return {
    port,
    hlApiUrl: testnetUrl('HL_API_URL', get('HL_API_URL') ?? TESTNET_API, ['https:']),
    hlWsUrl: testnetUrl('HL_WS_URL', get('HL_WS_URL') ?? TESTNET_WS, ['wss:']),
    accountAddress:
      accountRaw === undefined
        ? undefined
        : matching(
            'HL_ACCOUNT_ADDRESS',
            accountRaw,
            ADDRESS_RE,
            'a 0x-prefixed 20-byte hex address',
          ),
    pairing,
    voiceLang,
    agentPrivateKey:
      agentRaw === undefined
        ? undefined
        : matching(
            'HL_AGENT_PRIVATE_KEY',
            agentRaw,
            PRIVATE_KEY_RE,
            'a 0x-prefixed 32-byte hex key',
          ),
    anthropicKey: get('ANTHROPIC_API_KEY'),
    elevenLabsKey: get('ELEVENLABS_API_KEY'),
    encryptionKey: matching(
      'ENCRYPTION_KEY',
      required('ENCRYPTION_KEY'),
      HEX32_RE,
      '32 bytes of hex (openssl rand -hex 32)',
    ),
    sessionToken: matching(
      'SESSION_TOKEN',
      required('SESSION_TOKEN'),
      /^\S{16,}$/,
      'at least 16 non-space characters',
    ),
    executor,
    dbPath: get('DB_PATH') ?? './data/hypersight.sqlite',
    intentModel: get('INTENT_MODEL') ?? 'claude-opus-5-5',
    tonAddress: get('TON_ADDRESS'),
  };
}

/** True only for https:// or wss:// URLs on hyperliquid-testnet.xyz (or a subdomain). */
export function isTestnetUrl(value: string, protocols = ['https:', 'wss:']): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const onTestnet = host === TESTNET_HOST || host.endsWith(`.${TESTNET_HOST}`);
  return onTestnet && protocols.includes(url.protocol);
}

/** Testnet only: any Hyperliquid URL off hyperliquid-testnet.xyz is refused at startup. */
function testnetUrl(key: string, value: string, protocols: string[]): string {
  if (!isTestnetUrl(value, protocols)) {
    throw new ConfigError(`${key} must be a Hyperliquid testnet URL (${TESTNET_HOST})`);
  }
  return value.replace(/\/$/, '');
}
