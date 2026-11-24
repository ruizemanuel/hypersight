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
  /** Signs with the agent (API wallet) key from the environment; null when pairing or not testnet. */
  exchange: ExchangeClient | null;
  /** An exchange client signed by another agent key (a paired device's). */
  exchangeFor(agentKey: `0x${string}`): ExchangeClient;
  close(): Promise<void>;
};

/** Testnet only: refuses any non-testnet URL even if config validation was bypassed. */
export function createHlClients(cfg: Config): HlClients {
  if (!isTestnetUrl(cfg.hlApiUrl) || !isTestnetUrl(cfg.hlWsUrl)) {
    throw new ConfigError('Hyperliquid clients are testnet only');
  }
  const http = new HttpTransport({ isTestnet: true, apiUrl: cfg.hlApiUrl });
  const info = new InfoClient({ transport: http });

  const exchangeFor = (agentKey: `0x${string}`): ExchangeClient =>
    new ExchangeClient({ transport: http, wallet: privateKeyToAccount(agentKey) });
  let exchange: ExchangeClient | null = null;
  if (cfg.executor === 'testnet' && !cfg.pairing) {
    if (!cfg.agentPrivateKey) throw new ConfigError('HL_AGENT_PRIVATE_KEY is required for testnet');
    exchange = exchangeFor(cfg.agentPrivateKey as `0x${string}`);
  }

  let ws: WebSocketTransport | null = null;
  let subs: SubscriptionClient | null = null;

  return {
    info,
    exchange,
    exchangeFor,
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
