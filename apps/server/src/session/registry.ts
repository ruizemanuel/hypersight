import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Session } from './session';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Maps device tokens to sessions. P0: a single token from config. */
export class SessionRegistry {
  private readonly tokens: Buffer[];
  private readonly sessions = new Map<string, Session>();

  constructor(
    tokens: string[],
    private readonly opts: { onCreate?: (s: Session) => void } = {},
  ) {
    this.tokens = tokens.map(digest);
  }

  /** Constant-time token check. */
  isValid(token: string): boolean {
    const d = digest(token);
    let ok = false;
    for (const t of this.tokens) ok = timingSafeEqual(t, d) || ok;
    return ok;
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
