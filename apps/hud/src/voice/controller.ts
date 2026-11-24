import type { ClientMsg } from '@hypersight/protocol';
import type { InputEvent } from '../input/normalize';

export type VoiceDeps = {
  /** Opens/closes the glasses mic; resolves false (or throws) when it could not. */
  audio: (on: boolean) => Promise<boolean>;
  socket: {
    send(msg: ClientMsg): boolean;
    sendAudio(pcm: Uint8Array): boolean;
  };
  now?: () => number;
};

type Phase = 'idle' | 'starting' | 'listening' | 'stopping';
export type VoiceSource = 'hold' | 'menu';
/** listening: the mic is open; sent: the utterance went to the server; cancelled: abandoned. */
export type VoiceChange = 'listening' | 'sent' | 'cancelled';

const MAX_LISTEN_MS = 12_000;
/** A disconnect this soon after opening the mic is the known iPhone first-open issue. */
const EARLY_DISCONNECT_MS = 2000;
const MENU_SPEAK = 1;

/**
 * Hold-to-talk. Long press (or menu "Speak", stopped by the next tap) opens the mic, streams PCM
 * over the socket between `voice start` and `voice end`, and always closes the mic on release or
 * after 12 s. A double tap, exit, foreground exit or disconnect abandons the utterance instead
 * (`voice cancel`). Voice is optional: every action also works by tap.
 */
export class VoiceController {
  private phase: Phase = 'idle';
  private source: VoiceSource | null = null;
  private startedAt = 0;
  /** Released while the mic was still opening: send once it is open. */
  private stopRequested = false;
  /** Cancelled (or disconnected) while the mic was still opening: close it, never start. */
  private abortRequested = false;
  /** Set after an early disconnect; cleared when the glasses report connected again. */
  private blocked = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unavailableCbs: ((reason: string) => void)[] = [];
  private readonly changeCbs: ((change: VoiceChange, source: VoiceSource) => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: VoiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  get state(): 'idle' | 'listening' {
    return this.phase === 'listening' ? 'listening' : 'idle';
  }

  onUnavailable(cb: (reason: string) => void): void {
    this.unavailableCbs.push(cb);
  }

  onChange(cb: (change: VoiceChange, source: VoiceSource) => void): void {
    this.changeCbs.push(cb);
  }

  /** True when this event belongs to voice and must not reach the deck reducer. */
  consumes(ev: InputEvent): boolean {
    if (ev.type === 'holdStart' || ev.type === 'holdEnd') return true;
    if (ev.type === 'menu') return ev.id === MENU_SPEAK;
    if (ev.type === 'tap') return this.source === 'menu' && this.phase !== 'idle';
    if (ev.type === 'doubleTap') return this.phase === 'starting' || this.phase === 'listening';
    return false;
  }

  onInput(ev: InputEvent): Promise<void> {
    if (ev.type === 'holdStart') return this.start('hold');
    if (ev.type === 'menu' && ev.id === MENU_SPEAK) return this.start('menu');
    if (ev.type === 'doubleTap' || ev.type === 'foregroundExit' || ev.type === 'exit') {
      return this.cancel();
    }
    const release =
      (ev.type === 'holdEnd' && this.source === 'hold') ||
      (ev.type === 'tap' && this.source === 'menu');
    return release ? this.stop() : Promise.resolve();
  }

  onPcm(pcm: Uint8Array): void {
    if (this.phase === 'listening') this.deps.socket.sendAudio(pcm);
  }

  async onDevice(status: 'connected' | 'disconnected'): Promise<void> {
    if (status === 'connected') {
      this.blocked = false;
      return;
    }
    if (this.phase === 'starting') {
      this.blocked = true;
      this.abortRequested = true;
      this.emitUnavailable('glasses disconnected');
      return;
    }
    if (this.phase !== 'listening') return;
    const early = this.now() - this.startedAt < EARLY_DISCONNECT_MS;
    // The user cannot see a confirm card on disconnected glasses: never send a half utterance.
    await this.finish('cancel');
    if (early) {
      this.blocked = true;
      this.emitUnavailable('glasses disconnected');
    }
  }

  private async start(source: VoiceSource): Promise<void> {
    if (this.phase !== 'idle' || this.blocked) return;
    this.phase = 'starting';
    this.source = source;
    this.stopRequested = false;
    this.abortRequested = false;
    let ok = false;
    try {
      ok = await this.deps.audio(true);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.reset();
      // A disconnect while opening already reported it.
      if (!this.abortRequested) this.emitUnavailable('microphone unavailable');
      return;
    }
    if (this.abortRequested) {
      await this.closeMic();
      this.reset();
      return;
    }
    this.phase = 'listening';
    this.startedAt = this.now();
    this.deps.socket.send({ t: 'voice', phase: 'start' });
    this.emit('listening', source);
    this.timer = setTimeout(() => void this.stop(), MAX_LISTEN_MS);
    if (this.stopRequested) await this.finish('end');
  }

  private async stop(): Promise<void> {
    if (this.phase === 'starting') {
      this.stopRequested = true;
      return;
    }
    if (this.phase === 'listening') await this.finish('end');
  }

  private async cancel(): Promise<void> {
    if (this.phase === 'starting') {
      this.abortRequested = true;
      return;
    }
    if (this.phase === 'listening') await this.finish('cancel');
  }

  private async finish(how: 'end' | 'cancel'): Promise<void> {
    const source = this.source ?? 'hold';
    this.phase = 'stopping';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.closeMic();
    this.deps.socket.send({ t: 'voice', phase: how });
    this.reset();
    this.emit(how === 'end' ? 'sent' : 'cancelled', source);
  }

  private async closeMic(): Promise<void> {
    try {
      await this.deps.audio(false);
    } catch {
      // the mic may already be closed
    }
  }

  private reset(): void {
    this.phase = 'idle';
    this.source = null;
  }

  private emit(change: VoiceChange, source: VoiceSource): void {
    for (const cb of this.changeCbs) cb(change, source);
  }

  private emitUnavailable(reason: string): void {
    for (const cb of this.unavailableCbs) cb(reason);
  }
}
