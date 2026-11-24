import {
  AudioInputSource,
  DeviceConnectType,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { createPageRenderer } from './bridge/pages';
import { createBridgeQueue } from './bridge/queue';
import { queuedStorage } from './bridge/storage';
import { createCompanionApi, httpBaseFromWs } from './companion/api';
import { mountCompanion } from './companion/app';
import './companion/styles.css';
import { createInputNormalizer } from './input/normalize';
import { HudSocket } from './net/socket';
import { loadToken, saveToken, type TokenStorage } from './net/token';
import {
  createDeckCache,
  type Effect,
  type HudEvent,
  type HudState,
  initialHudState,
  offlineOverlayFor,
  pageFor,
  step,
} from './state/hud-state';
import { VoiceController } from './voice/controller';
import { toPcmBytes } from './voice/pcm';

const LIVE_DEBOUNCE_MS = 120;

function serverWsUrl(): string {
  const configured = import.meta.env.VITE_SERVER_WS as string | undefined;
  if (configured) return configured;
  return `ws://${location.hostname || 'localhost'}:8787/ws`;
}

function phoneStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

/** Phone-side form to paste the server token once (stored in bridge storage, never bundled). */
function showTokenForm(storage: TokenStorage): void {
  const app = document.getElementById('app');
  if (!app || document.getElementById('token-form')) return;
  const form = document.createElement('form');
  form.id = 'token-form';
  form.innerHTML =
    '<input id="token-input" type="password" autocomplete="off" placeholder="Server token" />' +
    '<button type="submit">Save</button>';
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = document.getElementById('token-input') as HTMLInputElement | null;
    void saveToken(input?.value ?? '', storage).then((ok) => {
      if (ok) location.reload();
      else phoneStatus('That does not look like a valid token.');
    });
  });
  app.appendChild(form);
}

const PHONE_STATUS: Record<HudState['status'], string> = {
  connecting: 'Connecting to the server…',
  open: 'Connected · check the glasses display.',
  closed: 'Connection lost, retrying…',
  replaced: 'HyperSight was opened on another device.',
  unauthorized: 'The server refused the token. Paste the current one below.',
  setup: 'Setup needed: paste the server token (SESSION_TOKEN) below.',
};

async function boot(): Promise<void> {
  phoneStatus('Waiting for the glasses…');
  const bridge = await waitForEvenAppBridge();
  const queue = createBridgeQueue();
  const normalizer = createInputNormalizer();
  const renderer = createPageRenderer(bridge, queue, () => normalizer.markTextUpdate(Date.now()));
  // Storage shares the bridge path with rendering: serialized, with the queue timeout.
  const storage: TokenStorage = queuedStorage(bridge, queue);
  const deckCache = createDeckCache(storage);

  let state: HudState = initialHudState;
  let socket: HudSocket | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;

  const render = (): void => {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
    void renderer.render(pageFor(state, Date.now()));
  };
  /** Server pushes are debounced so bursts become one BLE write. */
  const renderSoon = (): void => {
    if (!liveTimer) liveTimer = setTimeout(render, LIVE_DEBOUNCE_MS);
  };

  const runEffect = (e: Effect): void => {
    if (e.type === 'send') {
      const sent = socket?.send(e.msg) ?? false;
      const offline = sent ? null : offlineOverlayFor(e.msg);
      // Deferred: runEffect is called from inside dispatch.
      if (offline)
        queueMicrotask(() => dispatch({ type: 'overlay', overlay: offline, at: Date.now() }));
    } else if (e.type === 'reconnect') socket?.reconnect();
    else if (e.type === 'probe') socket?.probe();
    else if (e.type === 'exit') {
      void queue
        .run(() => bridge.shutDownPageContainer(1))
        .then((ok) => {
          if (!ok) dispatch({ type: 'exitFailed' });
        })
        .catch(() => dispatch({ type: 'exitFailed' }));
    }
  };

  function dispatch(ev: HudEvent, live = false): void {
    const prevStatus = state.status;
    const r = step(state, ev);
    state = r.state;
    for (const e of r.effects) runEffect(e);
    if (state.status !== prevStatus) phoneStatus(PHONE_STATUS[state.status]);
    if (live) renderSoon();
    else render();
  }

  const voice = new VoiceController({
    audio: (on) =>
      queue.run(() =>
        on ? bridge.audioControl(true, AudioInputSource.Glasses) : bridge.audioControl(false),
      ),
    socket: {
      send: (m) => socket?.send(m) ?? false,
      sendAudio: (pcm) => socket?.sendAudio(pcm) ?? false,
    },
    // The card on screen is the focus of "buy 20 of yes" (not when an overlay covers it).
    cardId: () =>
      state.overlay || state.mode !== 'deck' ? undefined : state.cards[state.index]?.id,
  });
  voice.onChange((change, source) => {
    if (change === 'listening') {
      const overlay = { kind: 'listening' as const, transcript: '', source };
      dispatch({ type: 'overlay', overlay, at: Date.now() });
      return;
    }
    if (state.overlay?.kind !== 'listening') return;
    // Sent: show Thinking until the server answers (the 1 s tick expires it if it never does).
    // Cancelled: back to the deck; the server drops the utterance.
    const overlay = change === 'sent' ? { kind: 'thinking' as const } : null;
    dispatch({ type: 'overlay', overlay, at: Date.now() });
  });
  voice.onUnavailable((reason) => {
    const message =
      reason === 'offline'
        ? 'Offline — voice needs the server'
        : 'Voice unavailable — use TAP actions';
    dispatch({ type: 'overlay', overlay: { kind: 'error', message }, at: Date.now() });
  });
  bridge.onDeviceStatusChanged((status) => {
    const t = status.connectType;
    if (t === DeviceConnectType.Connected) void voice.onDevice('connected');
    else if (t === DeviceConnectType.Disconnected || t === DeviceConnectType.ConnectionFailed) {
      void voice.onDevice('disconnected');
    }
  });
  window.addEventListener('beforeunload', () => void bridge.audioControl(false));

  bridge.onEvenHubEvent((event) => {
    // Audio first: PCM frames arrive many times a second and must never reach the input path.
    if (event.audioEvent) {
      const pcm = toPcmBytes(event.audioEvent.audioPcm);
      if (pcm) voice.onPcm(pcm);
      return;
    }
    const input = normalizer.normalize(event, Date.now());
    if (!input) return;
    // Voice sees every event first (including exit while the exit dialog is up) so the mic
    // is always closed; events it owns never reach the deck.
    const consumed = voice.consumes(input);
    void voice.onInput(input);
    if (!consumed) dispatch(input);
  });

  // Countdown (confirm) and elapsed time (listening) tick once a second: footer/body upgrades only.
  // Thinking is expired by the reducer so it can never stay up forever.
  setInterval(() => {
    const kind = state.overlay?.kind;
    if (kind === 'thinking' || kind === 'result' || kind === 'confirm') {
      dispatch({ type: 'tick', now: Date.now() });
    } else if (kind === 'listening') render();
  }, 1000);

  render(); // creates the startup page ("Connecting…")
  const cached = await deckCache.load().catch(() => null);
  if (cached) dispatch({ type: 'deck', cards: cached, cached: true });

  const devToken = (import.meta.env.VITE_SESSION_TOKEN as string | undefined) ?? '';
  // One retry: a single slow BLE hop must not send the user to the setup screen.
  const token = await loadToken(devToken, storage)
    .catch(() => loadToken(devToken, storage))
    .catch(() => null);
  if (!token) {
    showTokenForm(storage);
    dispatch({ type: 'status', status: 'setup' });
    return;
  }

  socket = new HudSocket(serverWsUrl(), token);
  // Phone-side setup screen (status, watchlist, presets, limits, alerts, history).
  const appEl = document.getElementById('app');
  if (appEl) {
    mountCompanion(appEl, createCompanionApi(httpBaseFromWs(serverWsUrl()), token));
    phoneStatus(PHONE_STATUS[state.status]);
  }
  socket.onStatus((s) => {
    if (s === 'open') return; // the session is live once `welcome` arrives
    if (s === 'unauthorized') showTokenForm(storage);
    dispatch({ type: 'status', status: s });
  });
  socket.onMessage((m) => {
    if (m.t === 'welcome') {
      if (m.serverTime !== undefined) {
        dispatch({ type: 'clock', serverTime: m.serverTime, at: Date.now() });
      }
      dispatch({ type: 'status', status: 'open' });
    } else if (m.t === 'deck') {
      deckCache.save(m.cards);
      dispatch({ type: 'deck', cards: m.cards }, true);
    } else if (m.t === 'overlay') {
      // Live words belong to an utterance in progress; a replayed Listening is a dead state.
      if (m.overlay?.kind === 'listening' && voice.state === 'idle') return;
      dispatch({ type: 'overlay', overlay: m.overlay, at: Date.now() });
    } else if (m.t === 'error') console.warn(`[server] ${m.code}: ${m.message}`);
  });
  socket.connect();
}

boot().catch((err: unknown) => {
  phoneStatus(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
});
