import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { privateKeyToAccount } from 'viem/accounts';
import { AlertEngine } from './alerts/engine';
import { type Config, ConfigError, loadConfig } from './config';
import { buildDeck } from './deck/build-deck';
import { createDeckPublisher } from './deck/publisher';
import { computeRecap, dayStartUtc, type RecapFill } from './deck/recap';
import { createHlClients } from './hl/clients';
import { FixtureMarketStream } from './hl/fixture-stream';
import { type PerpMeta, parsePerpMeta } from './hl/ids';
import { type MarketSource, MarketStream } from './hl/market-stream';
import { Catalogue, type OutcomeMarket } from './hl/outcomes';
import { createApp } from './http/app';
import { buildIntentContext, keytermsFor } from './intent/aliases';
import type { IntentContext } from './intent/grammar';
import { resolveIntent } from './intent/resolve';
import { PairingCodes } from './pairing/codes';
import { open } from './pairing/crypto';
import { createLinkApi } from './pairing/link-api';
import { type Focus, SessionController } from './session/controller';
import { SessionRegistry } from './session/registry';
import { openDb } from './store/db';
import { createRepos, type DeviceRecord } from './store/repos';
import { createGramBalance } from './ton/balance';
import { type ExecResult, type Executor, FakeExecutor } from './trade/executor';
import { OwnOrders } from './trade/own-orders';
import { PaperExecutor } from './trade/paper-executor';
import { ProposalService } from './trade/proposals';
import { loadUsdcToken, TestnetExecutor } from './trade/testnet-executor';
import { ElevenLabsStream } from './voice/elevenlabs';
import { VoiceRouter } from './voice/router';
import { startGateway } from './ws/gateway';

const MARKET_RETRY_MS = 5000;
/** The built pairing page (apps/link/dist); LINK_DIST overrides it in a container. */
const LINK_DIST = fileURLToPath(new URL('../../link/dist', import.meta.url));

type Addr = `0x${string}`;
/** The account the server reads and trades: from .env, or from the latest paired device. */
type Account = { master: Addr; agentKey: Addr | null };
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
  let stream: MarketSource | null = null;
  let alerts: AlertEngine | null = null;

  const watched = (): OutcomeMarket[] =>
    repos.watch
      .list()
      .map((k) => catalogue.byKey(k))
      .filter((m): m is OutcomeMarket => m !== undefined);

  /** `ETH` stays `ETH`; an outcome side coin `#273210` reads as its market (period dropped). */
  const recapName = (coin: string): string => {
    if (!coin.startsWith('#')) return coin;
    const m = catalogue.byOutcome(Math.floor(Number(coin.slice(1)) / 10));
    return m ? m.short.replace(/ · (daily|hourly|weekly)$/, '') : coin;
  };

  // Read-only Gram (TON testnet) card, only when TON_ADDRESS is set.
  const gram = cfg.tonAddress ? createGramBalance(cfg.tonAddress) : null;
  const publisher = createDeckPublisher({
    build: () => {
      if (!stream) throw new Error('market data not ready yet');
      const now = Date.now();
      const recap = computeRecap({
        entries: repos.audit.since(dayStartUtc(now)),
        fills: stream.todayFills(now) as RecapFill[],
        now,
        nameOf: recapName,
      });
      return buildDeck({
        view: stream.view(),
        watch: watched(),
        mids: stream.mids(),
        presets: repos.settings.get().presets,
        badge,
        now,
        ...(recap ? { recap } : {}),
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
  const pinned = cfg.accountAddress?.toLowerCase();
  const accountOf = (d: DeviceRecord): Account | null => {
    if (pinned && d.master !== pinned) {
      log('[pairing] the paired device belongs to another account than HL_ACCOUNT_ADDRESS');
      return null;
    }
    return {
      master: d.master as Addr,
      agentKey: open(d.agentKeySealed, cfg.encryptionKey) as Addr,
    };
  };
  let account: Account | null = cfg.pairing
    ? (() => {
        const d = repos.devices.latest();
        return d ? accountOf(d) : null;
      })()
    : {
        master: cfg.accountAddress as Addr,
        agentKey: (cfg.agentPrivateKey as Addr | undefined) ?? null,
      };
  if (cfg.pairing) {
    log(
      account
        ? `[pairing] trading with the latest paired device's agent`
        : '[pairing] no device paired yet: open /link from the glasses code',
    );
  }
  let usdcToken: string | null = null;
  let executor: Executor | null = cfg.executor === 'fake' ? new FakeExecutor() : null;
  const notReady = (): never => {
    throw new Error('market data not ready yet');
  };
  // Fill alerts skip the orders the user just confirmed (shared by proposals and alerts).
  const ownOrders = new OwnOrders();
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
    ownOrders,
  });

  async function modeInfo(): Promise<string[]> {
    const risk = repos.settings.get().risk;
    const limits = `Limits ${usdText(risk.maxOrderUsd)}/order · ${usdText(risk.maxDailyUsd)}/day`;
    const agentAddress = account?.agentKey
      ? privateKeyToAccount(account.agentKey).address.toLowerCase()
      : null;
    if (!account || !agentAddress) return [`${cfg.executor} executor · no agent wallet`, limits];
    try {
      const agents = await hl.info.extraAgents({ user: account.master });
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
      ? (opts) =>
          new ElevenLabsStream({
            apiKey: elevenLabsKey,
            // VOICE_LANG=multi: the provider detects the language (Spanish commands too).
            languageCode: cfg.voiceLang === 'multi' ? null : 'en',
            ...opts,
          })
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
      // A liquidation warning that fired before this device connected still applies: show it.
      for (const ev of alerts?.activeWarnings() ?? []) sessionController.alert(session, ev);
    },
    devices: repos.devices,
  });

  /** A device just paired: start market data with its account, or switch to its agent. */
  function onPaired(device: DeviceRecord): void {
    const next = accountOf(device);
    if (!next) return;
    const first = account === null;
    account = next;
    log(`[pairing] device paired · agent ${device.agentAddress}`);
    if (first) void startMarket();
    else
      void useAgent(next).catch((err) => log('[pairing] could not switch to the new agent', err));
  }

  const app = createApp({
    sessionToken: cfg.sessionToken,
    authorize: (token) => registry.isValid(token),
    pairing: cfg.pairing,
    ...(cfg.pairing
      ? {
          link: {
            routes: createLinkApi({
              codes: new PairingCodes(cfg.encryptionKey),
              devices: repos.devices,
              userRole: (agent) => hl.info.userRole({ user: agent as Addr }),
              ...(pinned ? { pinnedMaster: pinned } : {}),
              onPaired,
              log,
            }),
            distDir: process.env.LINK_DIST || LINK_DIST,
          },
        }
      : {}),
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

  /** The testnet executor signs with the account's agent (re-created when a new one pairs). */
  async function useAgent(acc: Account): Promise<void> {
    if (cfg.executor !== 'testnet' || !acc.agentKey) return;
    usdcToken ??= await loadUsdcToken(hl.info);
    executor = new TestnetExecutor({
      exchange: hl.exchangeFor(acc.agentKey),
      info: hl.info,
      master: acc.master,
      usdcToken,
      perpMeta,
      now: Date.now,
    });
  }

  async function startMarket(): Promise<void> {
    const acc = account;
    if (!acc) return; // pairing mode: starts once a device pairs
    const user = acc.master;
    try {
      let s: MarketSource;
      let abstraction: string;
      if (cfg.fixtures) {
        // Captured data and a scripted price walk: nothing is read from Hyperliquid.
        const f = new FixtureMarketStream({ catalogue });
        await f.start();
        perpMeta.splice(0, perpMeta.length, ...f.perpMeta());
        s = f;
        abstraction = 'fixtures';
      } else {
        const [meta, mode] = await Promise.all([hl.info.meta(), hl.info.userAbstraction({ user })]);
        await catalogue.load(hl.info);
        perpMeta.splice(0, perpMeta.length, ...parsePerpMeta(meta));
        const live = new MarketStream({
          info: hl.info,
          subs: hl.subs,
          user,
          catalogue,
          perpMeta,
          abstraction: mode,
          log,
        });
        await live.start();
        s = live;
        abstraction = mode;
      }
      s.on('view', () => publisher.publish());
      s.on('outcomeMeta', () => publisher.publish());
      stream = s;
      alerts = new AlertEngine({
        stream: s,
        rules: repos.rules,
        catalogue,
        // Detached devices keep the alert in their snapshot and see it when they reconnect.
        push: (ev) => {
          for (const session of registry.all()) sessionController.alert(session, ev);
        },
        ownOrders,
        log,
      });
      alerts.start();
      if (cfg.executor === 'testnet' && !executor) {
        await useAgent(account ?? acc);
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
