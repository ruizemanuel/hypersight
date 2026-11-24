import {
  AudioInputSource,
  DeviceConnectType,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { createPageRenderer } from './bridge/pages';
import { createBridgeQueue } from './bridge/queue';
import { queuedStorage } from './bridge/storage';
import { createInputNormalizer } from './input/normalize';
import { HudSocket } from './net/socket';
import { loadToken, saveToken, type TokenStorage } from './net/token';
import {
  createDeckCache,
  type Effect,
  type HudEvent,
  type HudState,
  initialHudState,
  pageFor,
  step,
} from './state/hud-state';
import { VoiceController } from './voice/controller';

const LIVE_DEBOUNCE_MS = 120;
const VOICE_REPLY_TIMEOUT_MS = 10_000;

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
    if (e.type === 'send') socket?.send(e.msg);
    else if (e.type === 'reconnect') socket?.reconnect();
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
  });
  let localThinkingTimer: ReturnType<typeof setTimeout> | null = null;
  voice.onChange((s) => {
    if (s === 'listening') {
      dispatch({ type: 'overlay', overlay: { kind: 'listening', transcript: '' }, at: Date.now() });
      return;
    }
    // Released: show Thinking until the server answers; never leave it stuck if it does not.
    if (state.overlay?.kind !== 'listening') return;
    const at = Date.now();
    dispatch({ type: 'overlay', overlay: { kind: 'thinking' }, at });
    if (localThinkingTimer) clearTimeout(localThinkingTimer);
    localThinkingTimer = setTimeout(() => {
      if (state.overlay?.kind === 'thinking' && state.overlayAt === at) {
        dispatch({ type: 'overlay', overlay: null, at: Date.now() });
      }
    }, VOICE_REPLY_TIMEOUT_MS);
  });
  voice.onUnavailable(() => {
    dispatch({
      type: 'overlay',
      overlay: { kind: 'error', message: 'Voice unavailable — use TAP actions' },
      at: Date.now(),
    });
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
    const pcm = event.audioEvent?.audioPcm;
    if (pcm) {
      voice.onPcm(pcm);
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
  setInterval(() => {
    const kind = state.overlay?.kind;
    if (kind === 'confirm' || kind === 'listening') render();
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
  socket.onStatus((s) => {
    if (s === 'open') return; // the session is live once `welcome` arrives
    if (s === 'unauthorized') showTokenForm(storage);
    dispatch({ type: 'status', status: s });
  });
  socket.onMessage((m) => {
    if (m.t === 'welcome') dispatch({ type: 'status', status: 'open' });
    else if (m.t === 'deck') {
      deckCache.save(m.cards);
      dispatch({ type: 'deck', cards: m.cards }, true);
    } else if (m.t === 'overlay') dispatch({ type: 'overlay', overlay: m.overlay, at: Date.now() });
    else if (m.t === 'error') console.warn(`[server] ${m.code}: ${m.message}`);
  });
  socket.connect();
}

boot().catch((err: unknown) => {
  phoneStatus(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
});
