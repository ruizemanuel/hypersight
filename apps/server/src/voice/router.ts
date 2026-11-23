import type { Session } from '../session/session';
import type { SttFactory, SttStream } from './stt';

export type VoiceRouterDeps = {
  /** null when no STT provider is configured: voice reports unavailable, taps still work. */
  factory: SttFactory | null;
  keyterms: () => string[];
  onTranscript: (session: Session, text: string) => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
};

const PARTIAL_MS = 150;

type Active = { stream: SttStream; timer: ReturnType<typeof setTimeout> | null; partial: string };

/** One STT stream per session between `voice start` and `voice end`. */
export class VoiceRouter {
  private readonly active = new Map<Session, Active>();

  constructor(private readonly deps: VoiceRouterDeps) {}

  start(session: Session): void {
    this.drop(session);
    const factory = this.deps.factory;
    if (!factory) {
      session.send({
        t: 'overlay',
        overlay: { kind: 'error', message: 'Voice unavailable — use TAP actions' },
      });
      return;
    }
    let entry: Active | null = null;
    const stream = factory({
      keyterms: this.deps.keyterms(),
      // Coalesced (not reset on every partial) so a fast talker still sees live words.
      onPartial: (text) => {
        const e = entry;
        if (!e) return;
        e.partial = text;
        if (e.timer) return;
        e.timer = setTimeout(() => {
          e.timer = null;
          if (this.active.get(session) !== e) return;
          session.send({ t: 'overlay', overlay: { kind: 'listening', transcript: e.partial } });
        }, PARTIAL_MS);
      },
      onError: (err) => this.deps.log?.('[voice] provider error', err),
    });
    entry = { stream, timer: null, partial: '' };
    this.active.set(session, entry);
  }

  audio(session: Session, pcm: Buffer): void {
    this.active.get(session)?.stream.send(pcm);
  }

  async end(session: Session): Promise<void> {
    const entry = this.active.get(session);
    if (!entry) return;
    this.active.delete(session);
    if (entry.timer) clearTimeout(entry.timer);
    const text = (await entry.stream.finish()).trim();
    if (!text) {
      session.send({
        t: 'overlay',
        overlay: {
          kind: 'result',
          ok: false,
          title: "Didn't catch that",
          lines: ['Hold and speak again, or use TAP actions'],
        },
      });
      return;
    }
    await this.deps.onTranscript(session, text);
  }

  /** Abandons the session's utterance (detach, replaced connection). */
  drop(session: Session): void {
    const entry = this.active.get(session);
    if (!entry) return;
    this.active.delete(session);
    if (entry.timer) clearTimeout(entry.timer);
    entry.stream.close();
  }
}
