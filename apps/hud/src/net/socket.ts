import { type ClientMsg, type ServerMsg, ServerMsgSchema } from '@hypersight/protocol';

export type SocketStatus = 'connecting' | 'open' | 'closed';

type Options = {
  /** Injected in tests; defaults to the browser WebSocket. */
  WebSocketImpl?: typeof WebSocket;
};

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;
const PING_MS = 20_000;
const OPEN = 1;

/**
 * One reconnecting WebSocket to the server. Every open sends `hello` with the highest `seq`
 * received so far, so the server can replay only what was missed.
 */
export class HudSocket {
  private ws: WebSocket | null = null;
  private lastSeq: number | undefined;
  private backoff = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setStatus('connecting');
    const ws = new this.Impl(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = MIN_BACKOFF_MS;
      const hello: ClientMsg =
        this.lastSeq === undefined
          ? { t: 'hello', token: this.token }
          : { t: 'hello', token: this.token, lastSeq: this.lastSeq };
      ws.send(JSON.stringify(hello));
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_MS);
      this.setStatus('open');
    };
    ws.onmessage = (ev: MessageEvent) => this.receive(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.setStatus('closed');
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
    ws.onerror = () => {};
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
    if ('seq' in parsed) this.lastSeq = Math.max(this.lastSeq ?? 0, parsed.seq);
    for (const cb of this.messageCbs) cb(parsed);
  }

  private setStatus(s: SocketStatus): void {
    for (const cb of this.statusCbs) cb(s);
  }
}
