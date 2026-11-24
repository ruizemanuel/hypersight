import type { ClientMsg } from '@hypersight/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceController } from '../src/voice/controller';

function harness(opts: { audioResult?: boolean; audioDelayMs?: number } = {}) {
  const log: string[] = [];
  const audio: Uint8Array[] = [];
  const socket = {
    send: (m: ClientMsg) => {
      log.push(m.t === 'voice' ? `send(${m.phase})` : `send(${m.t})`);
      return true;
    },
    sendAudio: (pcm: Uint8Array) => {
      audio.push(pcm);
      return true;
    },
  };
  const voice = new VoiceController({
    audio: async (on) => {
      log.push(`audio(${on})`);
      if (opts.audioDelayMs) await new Promise((r) => setTimeout(r, opts.audioDelayMs));
      return opts.audioResult ?? true;
    },
    socket,
  });
  const unavailable: string[] = [];
  voice.onUnavailable((reason) => unavailable.push(reason));
  return { voice, log, audio, unavailable };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceController', () => {
  it('opens the mic and streams on hold, then closes and ends on release', async () => {
    const { voice, log, audio } = harness();
    await voice.onInput({ type: 'holdStart' });
    expect(voice.state).toBe('listening');
    voice.onPcm(new Uint8Array([1, 2]));
    await voice.onInput({ type: 'holdEnd' });
    expect(log).toEqual(['audio(true)', 'send(start)', 'audio(false)', 'send(end)']);
    expect(audio).toEqual([new Uint8Array([1, 2])]);
    expect(voice.state).toBe('idle');
  });

  it('drops PCM that arrives while not listening', async () => {
    const { voice, audio } = harness();
    voice.onPcm(new Uint8Array([9]));
    await voice.onInput({ type: 'holdStart' });
    await voice.onInput({ type: 'holdEnd' });
    voice.onPcm(new Uint8Array([9]));
    expect(audio).toEqual([]);
  });

  it('starts from the menu and stops on the next tap', async () => {
    const { voice, log } = harness();
    await voice.onInput({ type: 'menu', id: 1 });
    expect(voice.consumes({ type: 'tap' })).toBe(true);
    await voice.onInput({ type: 'tap' });
    expect(log).toEqual(['audio(true)', 'send(start)', 'audio(false)', 'send(end)']);
  });

  it('does not consume a tap while idle or after a hold start', async () => {
    const { voice } = harness();
    expect(voice.consumes({ type: 'tap' })).toBe(false);
    await voice.onInput({ type: 'holdStart' });
    expect(voice.consumes({ type: 'tap' })).toBe(false);
    expect(voice.consumes({ type: 'holdEnd' })).toBe(true);
  });

  it.each(['foregroundExit', 'exit'] as const)('stops the mic and cancels on %s', async (type) => {
    const { voice, log } = harness();
    await voice.onInput({ type: 'holdStart' });
    await voice.onInput({ type });
    // Leaving the app abandons the utterance: nothing is transcribed or proposed.
    expect(log.slice(-2)).toEqual(['audio(false)', 'send(cancel)']);
    expect(voice.state).toBe('idle');
  });

  it('auto-stops after 12 s', async () => {
    const { voice, log } = harness();
    await voice.onInput({ type: 'holdStart' });
    await vi.advanceTimersByTimeAsync(12_100);
    expect(log.slice(-2)).toEqual(['audio(false)', 'send(end)']);
    expect(voice.state).toBe('idle');
  });

  it('reports voice unavailable when the mic refuses to open', async () => {
    const { voice, log, unavailable } = harness({ audioResult: false });
    await voice.onInput({ type: 'holdStart' });
    expect(voice.state).toBe('idle');
    expect(log).toEqual(['audio(true)']);
    expect(unavailable).toHaveLength(1);
  });

  it('backs off after a disconnect right after opening the mic (iPhone first-open issue)', async () => {
    const { voice, log, unavailable } = harness();
    await voice.onInput({ type: 'holdStart' });
    vi.advanceTimersByTime(800);
    await voice.onDevice('disconnected');
    expect(log).toEqual(['audio(true)', 'send(start)', 'audio(false)', 'send(cancel)']);
    expect(unavailable).toHaveLength(1);
    await voice.onInput({ type: 'holdStart' });
    expect(log).toHaveLength(4);
    await voice.onDevice('connected');
    await voice.onInput({ type: 'holdStart' });
    expect(voice.state).toBe('listening');
  });

  it('cancels without backing off when the glasses disconnect later in a long command', async () => {
    const { voice, log, unavailable } = harness();
    await voice.onInput({ type: 'holdStart' });
    vi.advanceTimersByTime(5000);
    await voice.onDevice('disconnected');
    expect(voice.state).toBe('idle');
    expect(log.at(-1)).toBe('send(cancel)');
    expect(unavailable).toHaveLength(0);
  });

  it('notifies state changes, including the 12 s auto-stop', async () => {
    const { voice } = harness();
    const states: string[] = [];
    voice.onChange((s) => states.push(s));
    await voice.onInput({ type: 'holdStart' });
    await vi.advanceTimersByTimeAsync(12_100);
    expect(states).toEqual(['listening', 'sent']);
  });

  // The Listening footer promises "2×TAP cancel".
  it('cancels on double tap while listening: closes the mic and sends cancel, not end', async () => {
    const { voice, log } = harness();
    const states: string[] = [];
    voice.onChange((s) => states.push(s));
    await voice.onInput({ type: 'holdStart' });
    expect(voice.consumes({ type: 'doubleTap' })).toBe(true);
    await voice.onInput({ type: 'doubleTap' });
    expect(log).toEqual(['audio(true)', 'send(start)', 'audio(false)', 'send(cancel)']);
    expect(states).toEqual(['listening', 'cancelled']);
    expect(voice.state).toBe('idle');
  });

  it('cancels menu-started listening on double tap and reports the source', async () => {
    const { voice, log } = harness();
    const changes: string[] = [];
    voice.onChange((s, source) => changes.push(`${s}:${source}`));
    await voice.onInput({ type: 'menu', id: 1 });
    await voice.onInput({ type: 'doubleTap' });
    expect(log.at(-1)).toBe('send(cancel)');
    expect(changes).toEqual(['listening:menu', 'cancelled:menu']);
  });

  it('leaves a double tap to the deck while idle', () => {
    const { voice } = harness();
    expect(voice.consumes({ type: 'doubleTap' })).toBe(false);
  });

  it('closes the mic without starting when a double tap arrives while it is opening', async () => {
    const { voice, log } = harness({ audioDelayMs: 100 });
    const states: string[] = [];
    voice.onChange((s) => states.push(s));
    const starting = voice.onInput({ type: 'holdStart' });
    await voice.onInput({ type: 'doubleTap' });
    await vi.advanceTimersByTimeAsync(300);
    await starting;
    expect(log).toEqual(['audio(true)', 'audio(false)']);
    expect(states).toEqual([]);
    expect(voice.state).toBe('idle');
  });

  // The card on screen travels with voice start ("buy 20 of yes" = this market).
  it('sends the card on screen with voice start', async () => {
    const sent: ClientMsg[] = [];
    const voice = new VoiceController({
      audio: async () => true,
      socket: {
        send: (m) => {
          sent.push(m);
          return true;
        },
        sendAudio: () => true,
      },
      cardId: () => 'mkt:rb:BTC:1d',
    });
    await voice.onInput({ type: 'holdStart' });
    expect(sent[0]).toEqual({ t: 'voice', phase: 'start', cardId: 'mkt:rb:BTC:1d' });
  });

  // Voice while offline says so instead of Listening → nothing.
  it('closes the mic and reports offline when voice start cannot be sent', async () => {
    const log: string[] = [];
    const unavailable: string[] = [];
    const states: string[] = [];
    const voice = new VoiceController({
      audio: async (on) => {
        log.push(`audio(${on})`);
        return true;
      },
      socket: { send: () => false, sendAudio: () => false },
    });
    voice.onUnavailable((r) => unavailable.push(r));
    voice.onChange((s) => states.push(s));
    await voice.onInput({ type: 'holdStart' });
    expect(log).toEqual(['audio(true)', 'audio(false)']);
    expect(unavailable).toEqual(['offline']);
    expect(states).toEqual([]);
    expect(voice.state).toBe('idle');
  });

  // "Voice unavailable" must not be overwritten by Listening / "Didn't catch that".
  it('closes the mic without starting when the glasses disconnect while it is opening', async () => {
    const { voice, log, unavailable } = harness({ audioDelayMs: 100 });
    const states: string[] = [];
    voice.onChange((s) => states.push(s));
    const starting = voice.onInput({ type: 'holdStart' });
    await voice.onDevice('disconnected');
    await vi.advanceTimersByTimeAsync(300);
    await starting;
    expect(log).toEqual(['audio(true)', 'audio(false)']);
    expect(states).toEqual([]);
    expect(unavailable).toHaveLength(1);
  });

  it('handles a release that arrives while the mic is still opening', async () => {
    const { voice, log } = harness({ audioDelayMs: 100 });
    const starting = voice.onInput({ type: 'holdStart' });
    const ending = voice.onInput({ type: 'holdEnd' });
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([starting, ending]);
    expect(log).toEqual(['audio(true)', 'send(start)', 'audio(false)', 'send(end)']);
    expect(voice.state).toBe('idle');
  });
});
