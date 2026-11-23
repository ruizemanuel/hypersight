import type { Server } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { DEFAULT_PRESETS } from '@hypersight/protocol';
import { type Config, ConfigError, loadConfig } from './config';
import { buildDeck } from './deck/build-deck';
import { createDeckPublisher } from './deck/publisher';
import { createHlClients } from './hl/clients';
import { parsePerpMeta } from './hl/ids';
import { MarketStream } from './hl/market-stream';
import { Catalogue, type OutcomeMarket } from './hl/outcomes';
import { createApp } from './http/app';
import { buildIntentContext, keytermsFor } from './intent/aliases';
import { describeIntent } from './intent/describe';
import { type IntentContext, parseIntentFast } from './intent/grammar';
import { resolveIntent } from './intent/resolve';
import { SessionRegistry } from './session/registry';
import { ElevenLabsStream } from './voice/elevenlabs';
import { VoiceRouter } from './voice/router';
import { startGateway } from './ws/gateway';

const MARKET_RETRY_MS = 5000;
/** Default watchlist until Task 14 persists it. */
const DEFAULT_WATCH = ['rb:BTC:1d', 'rb:ETH:1d'];

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

  const hl = createHlClients(cfg);
  const catalogue = new Catalogue();
  const badge = cfg.executor === 'paper' ? 'PAPER' : 'TESTNET';
  let stream: MarketStream | null = null;

  const watched = (): OutcomeMarket[] =>
    DEFAULT_WATCH.map((k) => catalogue.byKey(k)).filter((m): m is OutcomeMarket => m !== undefined);

  const publisher = createDeckPublisher({
    build: () => {
      if (!stream) throw new Error('market data not ready yet');
      return buildDeck({
        view: stream.view(),
        watch: watched(),
        mids: stream.mids(),
        presets: DEFAULT_PRESETS,
        badge,
        now: Date.now(),
      });
    },
    sessions: () => registry.all().filter((s) => s.attached),
    onError: (err) => log('[deck] not published', err),
  });

  const anthropic = cfg.anthropicKey ? new Anthropic({ apiKey: cfg.anthropicKey }) : null;
  const intentContext = (): IntentContext =>
    stream
      ? buildIntentContext(stream.view(), catalogue, DEFAULT_WATCH)
      : {
          perpCoins: ['BTC', 'ETH', 'SOL', 'HYPE'],
          positions: [],
          outcomePositions: [],
          markets: [],
        };
  const marketLookup = (key: string) => catalogue.byKey(key);

  const elevenLabsKey = cfg.elevenLabsKey;
  const voice = new VoiceRouter({
    factory: elevenLabsKey
      ? (opts) => new ElevenLabsStream({ apiKey: elevenLabsKey, ...opts })
      : null,
    keyterms: () => keytermsFor(intentContext()),
    onTranscript: async (session, text) => {
      const ctx = intentContext();
      // The grammar answers instantly; show Thinking only while Claude works (≈ 2–3 s).
      if (anthropic && !parseIntentFast(text, ctx)) {
        session.send({ t: 'overlay', overlay: { kind: 'thinking' } });
      }
      const r = await resolveIntent(text, ctx, { client: anthropic, model: cfg.intentModel, log });
      log(
        `[intent ${session.id.slice(0, 8)}] "${text}" → ${r.source} ${Math.round(r.ms)}ms ${JSON.stringify(r.intent)}`,
      );
      // Task 17/19 turn the intent into a proposal; until then echo what was understood.
      const understood = r.intent.kind !== 'unknown';
      session.send({
        t: 'overlay',
        overlay: {
          kind: 'result',
          ok: understood,
          title: understood ? 'Understood' : "Didn't understand",
          lines: [describeIntent(r.intent, marketLookup), `"${text}"`],
        },
      });
    },
    log,
  });

  const registry = new SessionRegistry([cfg.sessionToken], {
    onCreate: (session) => {
      session.on('attach', () => publisher.publishTo(session));
      session.on('detach', () => voice.drop(session));
    },
  });

  const app = createApp({ sessionToken: cfg.sessionToken });
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) =>
    log(`[http] listening on :${info.port} · executor ${cfg.executor} · Hyperliquid testnet`),
  ) as Server;

  const gateway = startGateway(
    server,
    registry,
    {
      onClientMsg: async (session, msg) => {
        log(`[ws ${session.id.slice(0, 8)}] ${msg.t}${msg.t === 'voice' ? ` ${msg.phase}` : ''}`);
        if (msg.t === 'voice' && msg.phase === 'start') voice.start(session);
        else if (msg.t === 'voice' && msg.phase === 'end') await voice.end(session);
      },
      onAudio: (session, pcm) => voice.audio(session, pcm),
    },
    { log },
  );

  async function startMarket(): Promise<void> {
    const user = cfg.accountAddress as `0x${string}`;
    try {
      const [meta, abstraction] = await Promise.all([
        hl.info.meta(),
        hl.info.userAbstraction({ user }),
      ]);
      await catalogue.load(hl.info);
      const s = new MarketStream({
        info: hl.info,
        subs: hl.subs,
        user,
        catalogue,
        perpMeta: parsePerpMeta(meta),
        abstraction,
      });
      s.on('view', () => publisher.publish());
      s.on('outcomeMeta', () => publisher.publish());
      await s.start();
      stream = s;
      log(`[hl] live: ${abstraction} account, ${catalogue.all().length} outcome markets`);
      publisher.publish();
    } catch (err) {
      log(`[hl] market data unavailable, retrying in ${MARKET_RETRY_MS / 1000}s`, err);
      setTimeout(() => void startMarket(), MARKET_RETRY_MS).unref();
    }
  }
  void startMarket();

  const shutdown = (signal: string) => {
    log(`[server] ${signal} received, shutting down`);
    void Promise.allSettled([stream?.stop(), gateway.close()])
      .then(() => hl.close())
      .finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
