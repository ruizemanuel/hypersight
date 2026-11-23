import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { createPageRenderer } from './bridge/pages';
import { createBridgeQueue } from './bridge/queue';
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
  const storage: TokenStorage = {
    get: (k) => bridge.getLocalStorage(k),
    set: (k, v) => bridge.setLocalStorage(k, v),
  };
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

  bridge.onEvenHubEvent((event) => {
    const input = normalizer.normalize(event, Date.now());
    if (input) dispatch(input);
  });

  // Countdown (confirm) and elapsed time (listening) tick once a second: footer/body upgrades only.
  setInterval(() => {
    const kind = state.overlay?.kind;
    if (kind === 'confirm' || kind === 'listening') render();
  }, 1000);

  render(); // creates the startup page ("Connecting…")
  const cached = await deckCache.load();
  if (cached) dispatch({ type: 'deck', cards: cached });

  const devToken = (import.meta.env.VITE_SESSION_TOKEN as string | undefined) ?? '';
  const token = await loadToken(devToken, storage).catch(() => null);
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
