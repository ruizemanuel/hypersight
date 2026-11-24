import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Session } from './session';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export type RegistryOptions = {
  onCreate?: (s: Session) => void;
  /** Paired devices, looked up by the SHA-256 hex of their token. */
  devices?: { has(tokenHash: string): boolean };
};

/** Maps tokens to sessions: the owner's SESSION_TOKEN and every paired device's token. */
export class SessionRegistry {
  private readonly tokens: Buffer[];
  private readonly sessions = new Map<string, Session>();

  constructor(
    tokens: string[],
    private readonly opts: RegistryOptions = {},
  ) {
    this.tokens = tokens.map(digest);
  }

  /** Constant-time check of the static tokens, then the paired devices (by hash). */
  isValid(token: string): boolean {
    const d = digest(token);
    let ok = false;
    for (const t of this.tokens) ok = timingSafeEqual(t, d) || ok;
    return ok || (this.opts.devices?.has(d.toString('hex')) ?? false);
  }

  /** The session for a valid token (created on first use), or `null` for an unknown token. */
  getOrCreate(token: string): Session | null {
    if (!this.isValid(token)) return null;
    let s = this.sessions.get(token);
    if (!s) {
      s = new Session(randomUUID());
      this.sessions.set(token, s);
      this.opts.onCreate?.(s);
    }
    return s;
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }
}
