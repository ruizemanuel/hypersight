import { describe, expect, it } from 'vitest';
import { open, seal } from '../../src/pairing/crypto';

const KEY = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const SECRET = `0x${'ab'.repeat(32)}`;

describe('seal / open (AES-256-GCM)', () => {
  it('round-trips a secret and never shows it in the sealed text', () => {
    const sealed = seal(SECRET, KEY);
    expect(open(sealed, KEY)).toBe(SECRET);
    expect(sealed).not.toContain('abab');
  });

  it('uses a fresh IV every time', () => {
    expect(seal(SECRET, KEY)).not.toBe(seal(SECRET, KEY));
  });

  it('refuses the wrong key and any tampering', () => {
    const sealed = seal(SECRET, KEY);
    expect(() => open(sealed, OTHER)).toThrow();
    const bytes = Buffer.from(sealed, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(() => open(bytes.toString('base64'), KEY)).toThrow();
  });

  it('refuses a key that is not 32 bytes of hex', () => {
    expect(() => seal(SECRET, 'short')).toThrow(/32-byte hex/);
  });
});
