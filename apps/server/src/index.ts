import type { Server } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { privateKeyToAccount } from 'viem/accounts';
import { AlertEngine } from './alerts/engine';
import { type Config, ConfigError, loadConfig } from './config';
import { buildDeck } from './deck/build-deck';
import { createDeckPublisher } from './deck/publisher';
import { createHlClients } from './hl/clients';
import { type PerpMeta, parsePerpMeta } from './hl/ids';
import { MarketStream } from './hl/market-stream';
import { Catalogue, type OutcomeMarket } from './hl/outcomes';
import { createApp } from './http/app';
import { buildIntentContext, keytermsFor } from './intent/aliases';
import type { IntentContext } from './intent/grammar';
import { resolveIntent } from './intent/resolve';
import { type Focus, SessionController } from './session/controller';
import { SessionRegistry } from './session/registry';
import { openDb } from './store/db';
import { createRepos } from './store/repos';
import { createGramBalance } from './ton/balance';
import { type ExecResult, type Executor, FakeExecutor } from './trade/executor';
import { PaperExecutor } from './trade/paper-executor';
import { ProposalService } from './trade/proposals';
import { loadUsdcToken, TestnetExecutor } from './trade/testnet-executor';
import { ElevenLabsStream } from './voice/elevenlabs';
import { VoiceRouter } from './voice/router';
import { startGateway } from './ws/gateway';

const MARKET_RETRY_MS = 5000;
const NOT_READY: ExecResult = { status: 'none', message: 'Trading not ready yet — nothing sent' };

const usdText = (n: number) => `$${n.toLocaleString('en-US')}`;
const dateText = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

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

  const db = openDb(cfg.dbPath);
  const repos = createRepos(db);
  const hl = createHlClients(cfg);
  const catalogue = new Catalogue();
  const badge = cfg.executor === 'paper' ? 'PAPER' : 'TESTNET';
  let stream: MarketStream | null = null;
  let alerts: AlertEngine | null = null;

  const watched = (): OutcomeMarket[] =>
    repos.watch
      .list()
      .map((k) => catalogue.byKey(k))
      .filter((m): m is OutcomeMarket => m !== undefined);

  // Read-only Gram (TON testnet) card, only when TON_ADDRESS is set.
  const gram = cfg.tonAddress ? createGramBalance(cfg.tonAddress) : null;
  const publisher = createDeckPublisher({
    build: () => {
      if (!stream) throw new Error('market data not ready yet');
      return buildDeck({
        view: stream.view(),
        watch: watched(),
        mids: stream.mids(),
        presets: repos.settings.get().presets,
        badge,
        now: Date.now(),
        ...(gram?.current()
          ? { gram: gram.current() as NonNullable<ReturnType<typeof gram.current>> }
          : {}),
      });
    },
    sessions: () => registry.all().filter((s) => s.attached),
    onError: (err) => log('[deck] not published', err),
  });

  const anthropic = cfg.anthropicKey ? new Anthropic({ apiKey: cfg.anthropicKey }) : null;
  const intentContext = (focus?: Focus): IntentContext =>
    stream
      ? buildIntentContext(stream.view(), catalogue, repos.watch.list(), focus ? { focus } : {})
      : {
          perpCoins: ['BTC', 'ETH', 'SOL', 'HYPE'],
          positions: [],
          outcomePositions: [],
          markets: [],
        };

  // Filled from `meta` once market data is up (shared by reference with proposals and executor).
  const perpMeta: PerpMeta[] = [];
  const user = cfg.accountAddress as `0x${string}`;
  let executor: Executor | null = cfg.executor === 'fake' ? new FakeExecutor() : null;
  const notReady = (): never => {
    throw new Error('market data not ready yet');
  };
  const proposals = new ProposalService({
    stream: {
      view: () => stream?.view() ?? notReady(),
      book: async (coin) => (stream ?? notReady()).book(coin),
    },
    catalogue,
    repos,
    executor: {
      execute: async (plan) => (executor ? executor.execute(plan) : NOT_READY),
      cancelAll: async () => (executor ? executor.cancelAll() : NOT_READY),
    },
    perpMeta,
    network: 'testnet',
    now: Date.now,
  });

  const agentAddress = cfg.agentPrivateKey
    ? privateKeyToAccount(cfg.agentPrivateKey as `0x${string}`).address.toLowerCase()
    : null;
  async function modeInfo(): Promise<string[]> {
    const risk = repos.settings.get().risk;
    const limits = `Limits ${usdText(risk.maxOrderUsd)}/order · ${usdText(risk.maxDailyUsd)}/day`;
    if (!agentAddress) return [`${cfg.executor} executor · no agent wallet`, limits];
    try {
      const agents = await hl.info.extraAgents({ user });
      const a = agents.find((x) => x.address.toLowerCase() === agentAddress);
      const agent = !a
        ? 'Agent wallet not approved'
        : a.validUntil
          ? `Agent valid until ${dateText(a.validUntil)}`
          : 'Agent wallet approved';
      return [agent, limits, 'Agent cannot withdraw funds'];
    } catch (err) {
      log('[mode] agent lookup failed', err);
      return ['Agent status unavailable', limits];
    }
  }

  // The router hands transcripts to the controller, which is built right after it.
  let controller: SessionController | null = null;

  const elevenLabsKey = cfg.elevenLabsKey;
  const voice = new VoiceRouter({
    factory: elevenLabsKey
      ? (opts) => new ElevenLabsStream({ apiKey: elevenLabsKey, ...opts })
      : null,
    keyterms: () => keytermsFor(intentContext()),
    onTranscript: async (session, text, timing) => {
      await controller?.onTranscript(session, text, timing);
    },
    log,
  });

  const sessionController = new SessionController({
    proposals,
    resolve: (text, ctx) =>
      resolveIntent(text, ctx, { client: anthropic, model: cfg.intentModel, log }),
    context: intentContext,
    view: () => stream?.view() ?? null,
    mids: () => stream?.mids() ?? {},
    catalogue,
    watch: repos.watch,
    publish: () => publisher.publish(),
    refresh: async () => {
      await stream?.refresh();
    },
    modeInfo,
    voice,
    badge,
    log,
  });
  controller = sessionController;

  const registry = new SessionRegistry([cfg.sessionToken], {
    onCreate: (session) => {
      session.on('attach', () => publisher.publishTo(session));
      sessionController.attach(session);
    },
  });

  const app = createApp({
    sessionToken: cfg.sessionToken,
    api: {
      repos,
      catalogue,
      onChange: () => publisher.publish(),
      status: () => ({
        mode: cfg.executor,
        network: 'testnet',
        connected: registry.all().some((s) => s.attached),
        latency: sessionController.metrics(),
      }),
    },
  });
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) =>
    log(`[http] listening on :${info.port} · executor ${cfg.executor} · Hyperliquid testnet`),
  ) as Server;

  const gateway = startGateway(
    server,
    registry,
    {
      onClientMsg: async (session, msg) => {
        log(`[ws ${session.id.slice(0, 8)}] ${msg.t}${msg.t === 'voice' ? ` ${msg.phase}` : ''}`);
        await sessionController.onClientMsg(session, msg);
      },
      onAudio: (session, pcm) => voice.audio(session, pcm),
    },
    { log },
  );

  async function startMarket(): Promise<void> {
    try {
      const [meta, abstraction] = await Promise.all([
        hl.info.meta(),
        hl.info.userAbstraction({ user }),
      ]);
      await catalogue.load(hl.info);
      perpMeta.splice(0, perpMeta.length, ...parsePerpMeta(meta));
      const s = new MarketStream({
        info: hl.info,
        subs: hl.subs,
        user,
        catalogue,
        perpMeta,
        abstraction,
        log,
      });
      s.on('view', () => publisher.publish());
      s.on('outcomeMeta', () => publisher.publish());
      await s.start();
      stream = s;
      alerts = new AlertEngine({
        stream: s,
        rules: repos.rules,
        catalogue,
        // Detached devices keep the alert in their snapshot and see it when they reconnect.
        push: (ev) => {
          for (const session of registry.all()) sessionController.alert(session, ev);
        },
        log,
      });
      alerts.start();
      if (cfg.executor === 'testnet' && hl.exchange && !executor) {
        executor = new TestnetExecutor({
          exchange: hl.exchange,
          info: hl.info,
          master: user,
          usdcToken: await loadUsdcToken(hl.info),
          perpMeta,
          now: Date.now,
        });
      } else if (cfg.executor === 'paper' && !executor) {
        executor = new PaperExecutor({
          book: (coin) => s.book(coin),
          ledger: repos.ledger,
          now: Date.now,
        });
      }
      log(`[hl] live: ${abstraction} account, ${catalogue.all().length} outcome markets`);
      publisher.publish();
    } catch (err) {
      log(`[hl] market data unavailable, retrying in ${MARKET_RETRY_MS / 1000}s`, err);
      setTimeout(() => void startMarket(), MARKET_RETRY_MS).unref();
    }
  }
  void startMarket();
  if (gram) {
    const refreshGram = () =>
      void gram
        .refresh()
        .then(() => publisher.publish())
        .catch((err) => log('[ton] balance refresh failed', err));
    refreshGram();
    setInterval(refreshGram, 60_000).unref();
  }

  const shutdown = (signal: string) => {
    log(`[server] ${signal} received, shutting down`);
    alerts?.stop();
    void Promise.allSettled([stream?.stop(), gateway.close()])
      .then(() => hl.close())
      .then(() => db.close())
      .finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
