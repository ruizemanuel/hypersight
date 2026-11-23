import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { type Config, ConfigError, loadConfig } from './config';
import { createApp } from './http/app';
import { SessionRegistry } from './session/registry';
import { startGateway } from './ws/gateway';

function log(msg: string, err?: unknown): void {
  const ts = new Date().toISOString();
  if (err === undefined) console.log(`${ts} ${msg}`);
  else console.error(`${ts} ${msg}`, err instanceof Error ? err.message : err);
}

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`[config] ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

function main(): void {
  const cfg = readConfig();
  if (!cfg.elevenLabsKey)
    log('[voice] ELEVENLABS_API_KEY not set: voice disabled, tap actions only');
  if (!cfg.anthropicKey) log('[intent] ANTHROPIC_API_KEY not set: fast grammar only');

  const app = createApp({ sessionToken: cfg.sessionToken });
  const registry = new SessionRegistry([cfg.sessionToken]);
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) =>
    log(`[http] listening on :${info.port} · executor ${cfg.executor} · Hyperliquid testnet`),
  ) as Server;

  const gateway = startGateway(
    server,
    registry,
    {
      onClientMsg: (session, msg) => log(`[ws ${session.id.slice(0, 8)}] ${msg.t}`),
      onAudio: () => {},
    },
    { log },
  );

  const shutdown = (signal: string) => {
    log(`[server] ${signal} received, shutting down`);
    void gateway.close().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
