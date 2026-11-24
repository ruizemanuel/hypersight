import { describe, expect, it } from 'vitest';
import { toPcmBytes } from '../src/voice/pcm';

// The SDK documents audioPcm as Uint8Array, but notes the host's Uint8List
// often arrives through JSON as number[] or a base64 string. A non-binary value would be sent as
// a text frame and the server would answer bad_message.
describe('toPcmBytes', () => {
  it('passes a Uint8Array through unchanged', () => {
    const pcm = new Uint8Array([1, 2, 3]);
    expect(toPcmBytes(pcm)).toBe(pcm);
  });

  it('converts a number array', () => {
    expect(toPcmBytes([1, 2, 255])).toEqual(new Uint8Array([1, 2, 255]));
  });

  it('decodes a base64 string', () => {
    expect(toPcmBytes('AQL/')).toEqual(new Uint8Array([1, 2, 255]));
  });

  it('wraps an ArrayBuffer and other typed-array views', () => {
    expect(toPcmBytes(new Uint8Array([4, 5]).buffer)).toEqual(new Uint8Array([4, 5]));
    expect(toPcmBytes(new Int16Array([1]))).toEqual(new Uint8Array([1, 0]));
  });

  it('returns null for empty or unusable values', () => {
    expect(toPcmBytes(undefined)).toBeNull();
    expect(toPcmBytes(new Uint8Array())).toBeNull();
    expect(toPcmBytes([])).toBeNull();
    expect(toPcmBytes('not base64!')).toBeNull();
    expect(toPcmBytes({ length: 3 })).toBeNull();
  });
});
