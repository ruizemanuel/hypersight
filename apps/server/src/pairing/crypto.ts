import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX32_RE = /^[0-9a-fA-F]{64}$/;

function keyOf(keyHex: string): Buffer {
  if (!HEX32_RE.test(keyHex)) throw new Error('Encryption key must be a 32-byte hex string');
  return Buffer.from(keyHex, 'hex');
}

/** AES-256-GCM with a random IV: `base64(iv | tag | ciphertext)`. */
export function seal(plaintext: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyOf(keyHex), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Opens what `seal` produced; throws on a wrong key or any tampering. */
export function open(sealed: string, keyHex: string): string {
  const buf = Buffer.from(sealed, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed value is too short');
  const decipher = createDecipheriv(ALGO, keyOf(keyHex), buf.subarray(0, IV_BYTES));
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
