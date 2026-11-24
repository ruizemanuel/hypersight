import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { CODE_TTL_MS, PairingCodes } from '../../src/pairing/codes';
import { open } from '../../src/pairing/crypto';

const KEY = 'cd'.repeat(32);
const T0 = Date.UTC(2026, 10, 24, 12, 0);
const MASTER = '0x1111111111111111111111111111111111111111';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('PairingCodes', () => {
  it('makes short codes without ambiguous characters (no 0, O, 1, I)', () => {
    const codes = new PairingCodes(KEY);
    for (let i = 0; i < 200; i++) {
      const { code } = codes.create(T0);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    }
  });

  it('makes a fresh trade-only agent wallet per code and only ever stores its key sealed', () => {
    const codes = new PairingCodes(KEY);
    const a = codes.create(T0);
    const b = codes.create(T0);
    expect(a.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a.agentAddress).not.toBe(b.agentAddress);
    const device = codes.complete(a.code, MASTER, T0 + 1000);
    expect(privateKeyToAccount(open(device.agentKeySealed, KEY) as `0x${string}`).address).toBe(
      a.agentAddress,
    );
    // The bearer token itself is never stored, only its hash.
    expect(device).toMatchObject({
      tokenHash: sha256(a.deviceToken),
      master: MASTER,
      agentAddress: a.agentAddress,
      createdAt: T0 + 1000,
    });
  });

  it('expires a code after 10 minutes', () => {
    const codes = new PairingCodes(KEY);
    const { code } = codes.create(T0);
    expect(codes.get(code, T0 + CODE_TTL_MS - 1)).toBeDefined();
    expect(codes.get(code, T0 + CODE_TTL_MS + 1)).toBeUndefined();
    expect(() => codes.complete(code, MASTER, T0 + CODE_TTL_MS + 1)).toThrow(/expired/i);
    codes.expireOlderThan(T0 + CODE_TTL_MS + 1);
    expect(codes.status(code, T0)).toBeUndefined();
    expect(CODE_TTL_MS).toBe(600_000);
  });

  it('completes a code only once, and reports it as paired afterwards', () => {
    const codes = new PairingCodes(KEY);
    const { code } = codes.create(T0);
    expect(codes.status(code, T0)).toBe('pending');
    codes.complete(code, MASTER, T0);
    expect(codes.status(code, T0)).toBe('paired');
    expect(() => codes.complete(code, MASTER, T0)).toThrow(/already used/i);
  });

  it('accepts a code typed in lower case or without the dash', () => {
    const codes = new PairingCodes(KEY);
    const { code } = codes.create(T0);
    expect(codes.get(code.toLowerCase(), T0)).toBeDefined();
    expect(codes.get(code.replace('-', ''), T0)).toBeDefined();
  });
});
