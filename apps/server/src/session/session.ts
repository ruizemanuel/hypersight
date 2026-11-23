import { EventEmitter } from 'node:events';
import type { ServerMsg } from '@hypersight/protocol';

/** The subset of a `ws` WebSocket a session needs (keeps sessions testable without sockets). */
export type SessionSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

/** A server message as handed to `send`: sequenced types get their `seq` stamped by the session. */
export type OutgoingMsg = ServerMsg extends infer M
  ? M extends { seq: number }
    ? Omit<M, 'seq'>
    : M
  : never;

const OPEN = 1;
export const CLOSE_REPLACED = 4000;

/**
 * Per-device state that survives reconnects. Every `welcome`, `deck` and `overlay` gets the next
 * `seq`; the latest deck and overlay are kept so a reconnecting HUD can resume where it left off.
 * Emits `attach` and `detach`.
 */
export class Session extends EventEmitter {
  seq = 0;
  private socket: SessionSocket | null = null;
  private lastDeck: Extract<ServerMsg, { t: 'deck' }> | null = null;
  private lastOverlay: Extract<ServerMsg, { t: 'overlay' }> | null = null;

  constructor(readonly id: string) {
    super();
  }

  get attached(): boolean {
    return this.socket !== null;
  }

  send(msg: OutgoingMsg): void {
    let wire: ServerMsg;
    if (msg.t === 'deck') {
      this.lastDeck = { ...msg, seq: ++this.seq };
      wire = this.lastDeck;
    } else if (msg.t === 'overlay') {
      this.lastOverlay = { ...msg, seq: ++this.seq };
      wire = this.lastOverlay;
    } else if (msg.t === 'welcome') {
      wire = { ...msg, seq: ++this.seq };
    } else {
      wire = msg;
    }
    this.write(wire);
  }

  /** Latest deck and overlay, in sequence order. */
  snapshot(): ServerMsg[] {
    const items: ServerMsg[] = [];
    if (this.lastDeck) items.push(this.lastDeck);
    if (this.lastOverlay) items.push(this.lastOverlay);
    return items.sort((a, b) => seqOf(a) - seqOf(b));
  }

  /**
   * Binds a new connection (closing any previous one), welcomes it and replays what it missed.
   * A cursor from another session (`knownSessionId` mismatch) or ahead of this one (the server
   * restarted) means unknown history, so the whole snapshot is replayed.
   */
  attach(socket: SessionSocket, lastSeq?: number, knownSessionId?: string): void {
    const previous = this.socket;
    this.socket = socket;
    if (previous && previous !== socket)
      previous.close(CLOSE_REPLACED, 'replaced by a new connection');
    const foreign = knownSessionId !== undefined && knownSessionId !== this.id;
    const cursor = foreign || (lastSeq ?? 0) > this.seq ? 0 : (lastSeq ?? 0);
    const missed = this.snapshot().filter((m) => seqOf(m) > cursor);
    this.send({ t: 'welcome', sessionId: this.id });
    for (const m of missed) this.write(m);
    this.safeEmit('attach');
  }

  /** Unbinds `socket` if it is still the current connection (stale detaches are ignored). */
  detach(socket: SessionSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.safeEmit('detach');
  }

  /** Listeners run inside socket handlers: a throwing listener must not crash the server. */
  private safeEmit(event: 'attach' | 'detach'): void {
    try {
      this.emit(event);
    } catch (err) {
      console.error(`session ${event} listener failed:`, err instanceof Error ? err.message : err);
    }
  }

  private write(msg: ServerMsg): void {
    const s = this.socket;
    if (s && s.readyState === OPEN) s.send(JSON.stringify(msg));
  }
}

function seqOf(m: ServerMsg): number {
  return 'seq' in m ? m.seq : 0;
}
