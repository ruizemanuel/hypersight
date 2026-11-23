import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../src/session/registry';
import type { Session } from '../src/session/session';

describe('SessionRegistry', () => {
  it('returns the same session for the same token and null for unknown tokens', () => {
    const r = new SessionRegistry(['token-a-0123456789']);
    const s = r.getOrCreate('token-a-0123456789');
    expect(s).not.toBeNull();
    expect(r.getOrCreate('token-a-0123456789')).toBe(s);
    expect(r.getOrCreate('nope')).toBeNull();
  });

  it('notifies once per newly created session', () => {
    const created: Session[] = [];
    const r = new SessionRegistry(['token-a-0123456789'], { onCreate: (s) => created.push(s) });
    const s = r.getOrCreate('token-a-0123456789');
    r.getOrCreate('token-a-0123456789');
    expect(created).toEqual([s]);
  });
});
