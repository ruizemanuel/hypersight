import { createHash, randomBytes, randomInt } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { DeviceRecord } from '../store/repos';
import { seal } from './crypto';

/** A pairing code is good for 10 minutes and a single use. */
export const CODE_TTL_MS = 10 * 60_000;
/** No 0/O or 1/I: the code is read off the glasses and typed on a computer. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class PairingError extends Error {
  override name = 'PairingError';
  constructor(readonly reason: 'unknown' | 'expired' | 'used') {
    super(
      reason === 'unknown'
        ? 'Unknown code'
        : reason === 'expired'
          ? 'Code expired'
          : 'Code already used',
    );
  }
}

type Pending = {
  tokenHash: string;
  agentAddress: string;
  agentKeySealed: string;
  createdAt: number;
  used: boolean;
};

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** `k7q4md`, `K7Q 4MD` → `K7Q-4MD`. */
function normalize(code: string): string {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

function makeCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)] as string;
  return normalize(Array.from({ length: 6 }, pick).join(''));
}

/**
 * Device-code pairing. Each code comes with a fresh agent wallet (sealed at once: the raw key
 * never leaves this module) and a device token for the glasses, valid once the code completes.
 */
export class PairingCodes {
  private readonly codes = new Map<string, Pending>();

  constructor(private readonly encryptionKey: string) {}

  create(now: number): { code: string; deviceToken: string; agentAddress: string } {
    const key = generatePrivateKey();
    const agentAddress = privateKeyToAccount(key).address;
    const deviceToken = randomBytes(32).toString('base64url');
    let code = makeCode();
    while (this.codes.has(code)) code = makeCode();
    this.codes.set(code, {
      tokenHash: tokenHash(deviceToken),
      agentAddress,
      agentKeySealed: seal(key, this.encryptionKey),
      createdAt: now,
      used: false,
    });
    return { code, deviceToken, agentAddress };
  }

  /** The agent a live, unused code asks the user to approve. */
  get(code: string, now: number): { agentAddress: string } | undefined {
    const p = this.codes.get(normalize(code));
    if (!p || p.used || now - p.createdAt > CODE_TTL_MS) return undefined;
    return { agentAddress: p.agentAddress };
  }

  status(code: string, now: number): 'pending' | 'paired' | undefined {
    const p = this.codes.get(normalize(code));
    if (!p || now - p.createdAt > CODE_TTL_MS) return undefined;
    return p.used ? 'paired' : 'pending';
  }

  complete(code: string, master: string, now: number): DeviceRecord {
    const p = this.codes.get(normalize(code));
    if (!p) throw new PairingError('unknown');
    if (p.used) throw new PairingError('used');
    if (now - p.createdAt > CODE_TTL_MS) throw new PairingError('expired');
    p.used = true;
    return {
      tokenHash: p.tokenHash,
      master,
      agentAddress: p.agentAddress,
      agentKeySealed: p.agentKeySealed,
      createdAt: now,
    };
  }

  expireOlderThan(now: number): void {
    for (const [code, p] of this.codes) {
      if (now - p.createdAt > CODE_TTL_MS) this.codes.delete(code);
    }
  }
}
