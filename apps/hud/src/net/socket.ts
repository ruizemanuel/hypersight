import { type ClientMsg, type ServerMsg, ServerMsgSchema } from '@hypersight/protocol';

/**
 * `replaced`: another device opened the same session (close 4000) — stays down until `reconnect()`.
 * `unauthorized`: the token was refused (close 4401) — stays down until `reconnect()`.
 */
export type SocketStatus = 'connecting' | 'open' | 'closed' | 'replaced' | 'unauthorized';

type Options = {
  /** Injected in tests; defaults to the browser WebSocket. */
  WebSocketImpl?: typeof WebSocket;
};

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;
const PING_MS = 20_000;
/** No inbound frame for this long (two missed pongs) means the link is half-open. */
const DEAD_MS = 45_000;
const PROBE_MS = 5000;
const OPEN = 1;
const CLOSE_REPLACED = 4000;
const CLOSE_UNAUTHORIZED = 4401;

/**
 * One reconnecting WebSocket to the server. Every open sends `hello` with the session id and the
 * highest deck/overlay `seq` received in it, so the server replays only what was missed.
 */
export class HudSocket {
  private ws: WebSocket | null = null;
  private sessionId: string | undefined;
  private lastSeq: number | undefined;
  private lastRx = 0;
  private rxCount = 0;
  private backoff = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageCbs: ((m: ServerMsg) => void)[] = [];
  private readonly statusCbs: ((s: SocketStatus) => void)[] = [];
  private readonly Impl: typeof WebSocket;

  constructor(
    private readonly url: string,
    private readonly token: string,
    opts: Options = {},
  ) {
    this.Impl = opts.WebSocketImpl ?? WebSocket;
  }

  connect(): void {
    this.clearTimers();
    this.setStatus('connecting');
    const ws = new this.Impl(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = MIN_BACKOFF_MS;
      this.lastRx = Date.now();
      const hello: ClientMsg = { t: 'hello', token: this.token };
      if (this.lastSeq !== undefined) hello.lastSeq = this.lastSeq;
      if (this.sessionId !== undefined) hello.sessionId = this.sessionId;
      ws.send(JSON.stringify(hello));
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastRx > DEAD_MS) this.abandon();
        else this.send({ t: 'ping' });
      }, PING_MS);
      this.setStatus('open');
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.lastRx = Date.now();
      this.rxCount++;
      this.receive(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (ev?.code === CLOSE_REPLACED) return this.setStatus('replaced');
      if (ev?.code === CLOSE_UNAUTHORIZED) return this.setStatus('unauthorized');
      this.setStatus('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  /** Reconnects now (after `replaced`/`unauthorized`, or to skip the backoff wait). */
  reconnect(): void {
    if (this.ws && this.ws.readyState === OPEN) return;
    this.dropSocket();
    this.backoff = MIN_BACKOFF_MS;
    this.connect();
  }

  /** Checks the link now (e.g. when the app returns to the foreground): no answer → reconnect. */
  probe(): void {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    const seen = this.rxCount;
    this.send({ t: 'ping' });
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.rxCount === seen) this.abandon();
    }, PROBE_MS);
  }

  /** Returns false (and drops the message) when not connected: stale commands are never queued. */
  send(msg: ClientMsg): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  sendAudio(pcm: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(pcm);
    return true;
  }

  onMessage(cb: (m: ServerMsg) => void): void {
    this.messageCbs.push(cb);
  }

  onStatus(cb: (s: SocketStatus) => void): void {
    this.statusCbs.push(cb);
  }

  /** A half-open socket may never fire `onclose`: detach it and reconnect right away. */
  private abandon(): void {
    this.dropSocket();
    this.clearTimers();
    this.setStatus('closed');
    this.backoff = MIN_BACKOFF_MS;
    this.connect();
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.probeTimer = null;
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: ServerMsg;
    try {
      const result = ServerMsgSchema.safeParse(JSON.parse(data));
      if (!result.success) return;
      parsed = result.data;
    } catch {
      return;
    }
    if (parsed.t === 'welcome') {
      // A new session id means the server restarted: our cursor belongs to old history.
      if (parsed.sessionId !== this.sessionId) {
        this.sessionId = parsed.sessionId;
        this.lastSeq = undefined;
      }
      // The welcome's own seq is not a cursor: replayed messages (lower seqs) follow it.
    } else if ('seq' in parsed) {
      this.lastSeq = Math.max(this.lastSeq ?? 0, parsed.seq);
    }
    for (const cb of this.messageCbs) cb(parsed);
  }

  private setStatus(s: SocketStatus): void {
    for (const cb of this.statusCbs) cb(s);
  }
}
