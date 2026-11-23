import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type ClientMsg, ClientMsgSchema } from '@hypersight/protocol';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { SessionRegistry } from '../session/registry';
import type { Session } from '../session/session';

export type SessionHandlers = {
  onClientMsg(session: Session, msg: ClientMsg): void | Promise<void>;
  onAudio(session: Session, pcm: Buffer): void;
};

export type GatewayOptions = {
  /** A connection must send a valid `hello` within this window or it is closed with 4401. */
  helloTimeoutMs?: number;
  /** Protocol-level ping interval; a connection that misses one pong is terminated. */
  heartbeatMs?: number;
  log?: (msg: string, err?: unknown) => void;
};

export const CLOSE_UNAUTHORIZED = 4401;
const MAX_PAYLOAD = 256 * 1024;

/** Accepts WebSocket upgrades on `/ws` only; the first message must authenticate with `hello`. */
export function startGateway(
  server: Server,
  registry: SessionRegistry,
  handlers: SessionHandlers,
  opts: GatewayOptions = {},
): { close(): Promise<void> } {
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  // Half-open sockets (phone asleep, network switch) never close by themselves: ping every
  // interval and terminate whoever missed the previous pong, so `session.attached` stays true.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  };
  server.on('upgrade', onUpgrade);

  function onConnection(ws: WebSocket): void {
    let session: Session | null = null;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const helloTimer = setTimeout(
      () => ws.close(CLOSE_UNAUTHORIZED, 'hello required'),
      helloTimeoutMs,
    );

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!session) {
        session = authenticate(ws, data, isBinary);
        if (session) clearTimeout(helloTimer);
        return;
      }
      if (isBinary) {
        try {
          handlers.onAudio(session, toBuffer(data));
        } catch (err) {
          log('audio handler failed', err);
        }
        return;
      }
      route(session, data);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      session?.detach(ws);
    });
    ws.on('error', (err) => log('socket error', err));
  }

  function authenticate(ws: WebSocket, data: RawData, isBinary: boolean): Session | null {
    const msg = isBinary ? null : parse(data);
    const session = msg?.t === 'hello' ? registry.getOrCreate(msg.token) : null;
    if (!session || msg?.t !== 'hello') {
      ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return null;
    }
    session.attach(ws, msg.lastSeq, msg.sessionId);
    return session;
  }

  function route(session: Session, data: RawData): void {
    const msg = parse(data);
    if (!msg || msg.t === 'hello') {
      session.send({ t: 'error', code: 'bad_message', message: 'Invalid message' });
      return;
    }
    if (msg.t === 'ping') {
      session.send({ t: 'pong' });
      return;
    }
    Promise.resolve()
      .then(() => handlers.onClientMsg(session, msg))
      .catch((err) => {
        log(`handler failed for ${msg.t}`, err);
        session.send({ t: 'error', code: 'internal', message: 'Something went wrong' });
      });
  }

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        server.off('upgrade', onUpgrade);
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

function parse(data: RawData): ClientMsg | null {
  try {
    const result = ClientMsgSchema.safeParse(JSON.parse(toBuffer(data).toString('utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
