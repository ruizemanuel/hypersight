import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { type Config, ConfigError, isTestnetUrl } from '../config';

export type HlClients = {
  info: InfoClient;
  /** Created on first access: constructing the WebSocket transport opens a connection. */
  readonly subs: SubscriptionClient;
  /** Signs with the agent (API wallet) key; null unless the executor is `testnet`. */
  exchange: ExchangeClient | null;
  close(): Promise<void>;
};

/** Testnet only: refuses any non-testnet URL even if config validation was bypassed. */
export function createHlClients(cfg: Config): HlClients {
  if (!isTestnetUrl(cfg.hlApiUrl) || !isTestnetUrl(cfg.hlWsUrl)) {
    throw new ConfigError('Hyperliquid clients are testnet only');
  }
  const http = new HttpTransport({ isTestnet: true, apiUrl: cfg.hlApiUrl });
  const info = new InfoClient({ transport: http });

  let exchange: ExchangeClient | null = null;
  if (cfg.executor === 'testnet') {
    if (!cfg.agentPrivateKey) throw new ConfigError('HL_AGENT_PRIVATE_KEY is required for testnet');
    const wallet = privateKeyToAccount(cfg.agentPrivateKey as `0x${string}`);
    exchange = new ExchangeClient({ transport: http, wallet });
  }

  let ws: WebSocketTransport | null = null;
  let subs: SubscriptionClient | null = null;

  return {
    info,
    exchange,
    get subs(): SubscriptionClient {
      if (!subs) {
        ws = new WebSocketTransport({ isTestnet: true, url: cfg.hlWsUrl });
        subs = new SubscriptionClient({ transport: ws });
      }
      return subs;
    },
    async close(): Promise<void> {
      await ws?.close();
    },
  };
}
