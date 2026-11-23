import WebSocket from 'ws';
import type { SttStream } from './stt';

const DEFAULT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
/** 100 ms of 16 kHz s16le mono: the provider's recommended minimum chunk. */
const MIN_CHUNK = 3200;
/** 1 s: the recommended maximum chunk. */
const MAX_CHUNK = 32_000;
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_LEN = 20;
const SAMPLE_RATE = 16_000;

export type ElevenLabsOptions = {
  apiKey: string;
  url?: string;
  /** Defaults to 'en'; `null` lets the provider auto-detect. */
  languageCode?: string | null;
  keyterms?: string[];
  onPartial: (text: string) => void;
  onError: (e: Error) => void;
};

/**
 * ElevenLabs Scribe v2 Realtime with manual commit: push-to-talk release = commit, so the final
 * transcript arrives right after the user lets go. The API key never leaves the server.
 */
export class ElevenLabsStream implements SttStream {
  private readonly ws: WebSocket;
  private started = false;
  private failed = false;
  private closed = false;
  private committing = false;
  private carry: Buffer = Buffer.alloc(0);
  private readonly outbox: Buffer[] = [];
  private lastPartial = '';
  private finishing: {
    resolve: (text: string) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private result: Promise<string> | null = null;

  constructor(private readonly opts: ElevenLabsOptions) {
    const url = new URL(opts.url ?? DEFAULT_URL);
    url.searchParams.set('model_id', 'scribe_v2_realtime');
    url.searchParams.set('audio_format', 'pcm_16000');
    url.searchParams.set('commit_strategy', 'manual');
    const lang = opts.languageCode === undefined ? 'en' : opts.languageCode;
    if (lang) url.searchParams.set('language_code', lang);
    const terms = (opts.keyterms ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= MAX_KEYTERM_LEN)
      .slice(0, MAX_KEYTERMS);
    for (const t of terms) url.searchParams.append('keyterms', t);

    this.ws = new WebSocket(url, { headers: { 'xi-api-key': opts.apiKey } });
    this.ws.on('message', (data) => this.onMessage(String(data)));
    this.ws.on('error', (err) => {
      if (this.closed) return;
      this.failed = true;
      this.opts.onError(err);
      this.settle(this.lastPartial);
    });
    this.ws.on('close', () => {
      this.failed = true;
      this.settle(this.lastPartial);
    });
  }

  send(pcm: Buffer): void {
    if (this.closed || this.committing) return;
    this.carry = this.carry.length ? Buffer.concat([this.carry, pcm]) : Buffer.from(pcm);
    while (this.carry.length >= MIN_CHUNK) {
      const size = Math.min(this.carry.length, MAX_CHUNK);
      this.enqueue(this.carry.subarray(0, size));
      this.carry = this.carry.subarray(size);
    }
  }

  finish(timeoutMs = 3000): Promise<string> {
    if (this.result) return this.result;
    this.result = new Promise<string>((resolve) => {
      if (this.failed || this.closed) {
        resolve(this.lastPartial);
        return;
      }
      const timer = setTimeout(() => this.settle(this.lastPartial), timeoutMs);
      this.finishing = { resolve, timer };
      if (this.started) this.commit();
    });
    return this.result;
  }

  close(): void {
    this.settle(this.lastPartial);
    this.shutdown();
  }

  private enqueue(chunk: Buffer): void {
    if (this.started && this.ws.readyState === WebSocket.OPEN) this.sendChunk(chunk, false);
    else this.outbox.push(Buffer.from(chunk));
  }

  private sendChunk(chunk: Buffer, commit: boolean): void {
    this.ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: chunk.toString('base64'),
        commit,
        sample_rate: SAMPLE_RATE,
      }),
    );
  }

  /** Flushes the remainder (even under 100 ms) and sends the empty commit chunk. */
  private commit(): void {
    if (this.committing) return;
    this.committing = true;
    if (this.carry.length) this.sendChunk(this.carry, false);
    this.carry = Buffer.alloc(0);
    this.sendChunk(Buffer.alloc(0), true);
  }

  private onMessage(raw: string): void {
    let msg: { message_type?: string; text?: string; error?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.error !== undefined) {
      this.opts.onError(new Error(`${msg.message_type ?? 'error'}: ${msg.error}`));
      this.failed = true;
      this.settle(this.lastPartial);
      return;
    }
    switch (msg.message_type) {
      case 'session_started':
        this.started = true;
        for (const chunk of this.outbox.splice(0)) this.sendChunk(chunk, false);
        if (this.finishing) this.commit();
        break;
      case 'partial_transcript':
        if (msg.text) {
          this.lastPartial = msg.text;
          this.opts.onPartial(msg.text);
        }
        break;
      case 'committed_transcript':
        this.settle(msg.text ?? this.lastPartial);
        break;
    }
  }

  private settle(text: string): void {
    const f = this.finishing;
    if (!f) return;
    this.finishing = null;
    clearTimeout(f.timer);
    f.resolve(text);
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
      else this.ws.close();
    } catch {
      // already closed
    }
  }
}
