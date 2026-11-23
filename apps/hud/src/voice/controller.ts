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

const MAX_LISTEN_MS = 12_000;
/** A disconnect this soon after opening the mic is the known iPhone first-open issue. */
const EARLY_DISCONNECT_MS = 2000;
const MENU_SPEAK = 1;

/**
 * Hold-to-talk. Long press (or menu "Speak", stopped by the next tap) opens the mic, streams PCM
 * over the socket between `voice start` and `voice end`, and always closes the mic on release,
 * exit, foreground exit or after 12 s. Voice is optional: every action also works by tap.
 */
export class VoiceController {
  private phase: Phase = 'idle';
  private source: 'hold' | 'menu' | null = null;
  private startedAt = 0;
  private stopRequested = false;
  /** Set after an early disconnect; cleared when the glasses report connected again. */
  private blocked = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unavailableCbs: ((reason: string) => void)[] = [];
  private readonly changeCbs: ((state: 'idle' | 'listening') => void)[] = [];
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

  onChange(cb: (state: 'idle' | 'listening') => void): void {
    this.changeCbs.push(cb);
  }

  /** True when this event belongs to voice and must not reach the deck reducer. */
  consumes(ev: InputEvent): boolean {
    if (ev.type === 'holdStart' || ev.type === 'holdEnd') return true;
    if (ev.type === 'menu') return ev.id === MENU_SPEAK;
    if (ev.type === 'tap') return this.source === 'menu' && this.phase !== 'idle';
    return false;
  }

  onInput(ev: InputEvent): Promise<void> {
    if (ev.type === 'holdStart') return this.start('hold');
    if (ev.type === 'menu' && ev.id === MENU_SPEAK) return this.start('menu');
    const release =
      (ev.type === 'holdEnd' && this.source === 'hold') ||
      (ev.type === 'tap' && this.source === 'menu') ||
      ev.type === 'foregroundExit' ||
      ev.type === 'exit';
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
      this.stopRequested = true;
      this.emitUnavailable('glasses disconnected');
      return;
    }
    if (this.phase !== 'listening') return;
    const early = this.now() - this.startedAt < EARLY_DISCONNECT_MS;
    await this.finish();
    if (early) {
      this.blocked = true;
      this.emitUnavailable('glasses disconnected');
    }
  }

  private async start(source: 'hold' | 'menu'): Promise<void> {
    if (this.phase !== 'idle' || this.blocked) return;
    this.phase = 'starting';
    this.source = source;
    this.stopRequested = false;
    let ok = false;
    try {
      ok = await this.deps.audio(true);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.phase = 'idle';
      this.source = null;
      this.emitUnavailable('microphone unavailable');
      return;
    }
    this.phase = 'listening';
    this.startedAt = this.now();
    this.deps.socket.send({ t: 'voice', phase: 'start' });
    for (const cb of this.changeCbs) cb('listening');
    this.timer = setTimeout(() => void this.stop(), MAX_LISTEN_MS);
    if (this.stopRequested) await this.finish();
  }

  private async stop(): Promise<void> {
    if (this.phase === 'starting') {
      this.stopRequested = true;
      return;
    }
    if (this.phase === 'listening') await this.finish();
  }

  private async finish(): Promise<void> {
    this.phase = 'stopping';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.deps.audio(false);
    } catch {
      // the mic may already be closed
    }
    this.deps.socket.send({ t: 'voice', phase: 'end' });
    this.phase = 'idle';
    this.source = null;
    for (const cb of this.changeCbs) cb('idle');
  }

  private emitUnavailable(reason: string): void {
    for (const cb of this.unavailableCbs) cb(reason);
  }
}
