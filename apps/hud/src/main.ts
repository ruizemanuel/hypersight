import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { createMainScreen } from './bridge/pages';
import { createBridgeQueue } from './bridge/queue';
import { createInputNormalizer, type InputEvent } from './input/normalize';
import { HudSocket, type SocketStatus } from './net/socket';
import { loadToken, saveToken, type TokenStorage } from './net/token';

const EXIT_CARD = 'Exit HyperSight?\n\nTAP exit · 2×TAP stay';

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

async function boot(): Promise<void> {
  phoneStatus('Waiting for the glasses…');
  const bridge = await waitForEvenAppBridge();
  const queue = createBridgeQueue();
  const normalizer = createInputNormalizer();
  const screen = createMainScreen(bridge, queue, () => normalizer.markTextUpdate(Date.now()));
  const storage: TokenStorage = {
    get: (k) => bridge.getLocalStorage(k),
    set: (k, v) => bridge.setLocalStorage(k, v),
  };

  let statusText = 'HyperSight\nConnecting…';
  let view: 'status' | 'exit' = 'status';
  let exiting = false;
  let socket: HudSocket | null = null;
  let linkDown: 'replaced' | 'unauthorized' | null = null;
  const render = () => screen.show(view === 'exit' ? EXIT_CARD : statusText).catch(() => {});

  const onInput = (input: InputEvent): void => {
    if (exiting) {
      // The system exit dialog is up: FOREGROUND_EXIT means the user answered "No".
      if (input.type === 'foregroundExit') {
        exiting = false;
        view = 'status';
        void render();
      }
      return;
    }
    if (input.type === 'foregroundEnter') socket?.probe();
    if (input.type === 'doubleTap') {
      // Root double tap opens our own Exit card: cancelling the system exit dialog is known to
      // break the mic and image updates until restart (Even Discord, Nov 2026).
      view = view === 'exit' ? 'status' : 'exit';
      void render();
      return;
    }
    if (input.type === 'tap' && view === 'exit') {
      exiting = true;
      void queue
        .run(() => bridge.shutDownPageContainer(1))
        .catch(() => {
          exiting = false;
        });
      return;
    }
    if (input.type === 'tap' && linkDown === 'replaced') {
      linkDown = null;
      socket?.reconnect();
    }
  };
  bridge.onEvenHubEvent((event) => {
    const input = normalizer.normalize(event, Date.now());
    if (input) onInput(input);
  });

  await screen.start(statusText);

  const devToken = (import.meta.env.VITE_SESSION_TOKEN as string | undefined) ?? '';
  const token = await loadToken(devToken, storage).catch(() => null);
  if (!token) {
    statusText = 'HyperSight\nSetup: paste your server token\non the phone screen';
    phoneStatus('Setup needed: paste the server token (SESSION_TOKEN) below.');
    showTokenForm(storage);
    await render();
    return;
  }

  socket = new HudSocket(serverWsUrl(), token);
  socket.onStatus((s: SocketStatus) => {
    if (s === 'open') return; // wait for `welcome`
    if (s === 'replaced') {
      linkDown = 'replaced';
      statusText = 'HyperSight\nOpened on another device\nTAP to reconnect';
      phoneStatus('HyperSight was opened on another device.');
    } else if (s === 'unauthorized') {
      linkDown = 'unauthorized';
      statusText = 'HyperSight\nToken refused\nCheck setup on the phone';
      phoneStatus('The server refused the token. Paste the current one below.');
      showTokenForm(storage);
    } else {
      statusText = s === 'connecting' ? 'HyperSight\nConnecting…' : 'HyperSight\nReconnecting…';
      phoneStatus(s === 'connecting' ? 'Connecting to the server…' : 'Connection lost, retrying…');
    }
    void render();
  });
  socket.onMessage((m) => {
    if (m.t === 'welcome') {
      linkDown = null;
      statusText = 'HyperSight\nConnected · TESTNET';
      phoneStatus('Connected · TESTNET. Check the glasses display.');
      void render();
    }
  });
  socket.connect();
}

boot().catch((err: unknown) => {
  phoneStatus(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
});
