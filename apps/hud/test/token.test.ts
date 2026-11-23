import { describe, expect, it } from 'vitest';
import { loadToken, saveToken, TOKEN_KEY } from '../src/net/token';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (k: string) => data[k] ?? '',
    set: async (k: string, v: string) => {
      data[k] = v;
      return true;
    },
  };
}

describe('session token', () => {
  it('prefers the dev-server token (never present in production builds)', async () => {
    expect(await loadToken('dev-token-0123456789', memoryStorage({ [TOKEN_KEY]: 'stored' }))).toBe(
      'dev-token-0123456789',
    );
  });

  it('falls back to the token stored on the phone', async () => {
    expect(await loadToken('', memoryStorage({ [TOKEN_KEY]: 'stored-token-0123456789' }))).toBe(
      'stored-token-0123456789',
    );
  });

  it('returns null when no token is available', async () => {
    expect(await loadToken('', memoryStorage())).toBeNull();
  });

  it('stores a trimmed token and rejects implausible ones', async () => {
    const storage = memoryStorage();
    expect(await saveToken('  pasted-token-0123456789 \n', storage)).toBe(true);
    expect(storage.data[TOKEN_KEY]).toBe('pasted-token-0123456789');
    expect(await saveToken('short', storage)).toBe(false);
    expect(await saveToken('has spaces inside it ok', storage)).toBe(false);
  });
});
