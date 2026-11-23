import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { createMainScreen } from './bridge/pages';
import { createBridgeQueue } from './bridge/queue';
import { createInputNormalizer, type InputEvent } from './input/normalize';
import { HudSocket, type SocketStatus } from './net/socket';

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

async function boot(): Promise<void> {
  phoneStatus('Waiting for the glasses…');
  const bridge = await waitForEvenAppBridge();
  const queue = createBridgeQueue();
  const normalizer = createInputNormalizer();
  const screen = createMainScreen(bridge, queue, () => normalizer.markTextUpdate(Date.now()));

  let statusText = 'HyperSight\nConnecting…';
  let view: 'status' | 'exit' = 'status';
  let exiting = false;
  const render = () => screen.show(view === 'exit' ? EXIT_CARD : statusText).catch(() => {});

  await screen.start(statusText);

  const token = (import.meta.env.VITE_SESSION_TOKEN as string | undefined) ?? '';
  if (!token) {
    statusText = 'HyperSight\nSetup needed: no session token';
    phoneStatus('Setup needed: SESSION_TOKEN is not configured.');
    await render();
    return;
  }

  const socket = new HudSocket(serverWsUrl(), token);
  socket.onStatus((s: SocketStatus) => {
    if (s === 'open') return; // wait for `welcome`
    statusText = s === 'connecting' ? 'HyperSight\nConnecting…' : 'HyperSight\nReconnecting…';
    phoneStatus(s === 'connecting' ? 'Connecting to the server…' : 'Connection lost, retrying…');
    void render();
  });
  socket.onMessage((m) => {
    if (m.t === 'welcome') {
      statusText = 'HyperSight\nConnected · TESTNET';
      phoneStatus('Connected · TESTNET. Check the glasses display.');
      void render();
    }
  });

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
    }
  };

  bridge.onEvenHubEvent((event) => {
    const input = normalizer.normalize(event, Date.now());
    if (input) onInput(input);
  });

  socket.connect();
}

boot().catch((err: unknown) => {
  phoneStatus(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
});
