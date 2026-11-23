/** One push-to-talk utterance streamed to a speech-to-text provider. */
export interface SttStream {
  /** Raw PCM s16le 16 kHz mono, any frame size. */
  send(pcm: Buffer): void;
  /** Ends the utterance and resolves with the final transcript ('' if none). Never rejects. */
  finish(timeoutMs?: number): Promise<string>;
  /** Abandons the utterance. */
  close(): void;
}

export type SttFactory = (opts: {
  onPartial: (text: string) => void;
  onError: (e: Error) => void;
  keyterms?: string[];
}) => SttStream;
