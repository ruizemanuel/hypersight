/** Bridge-storage key holding the server session token on the phone. */
export const TOKEN_KEY = 'hs.token';

export type TokenStorage = {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<boolean>;
};

/**
 * The dev server injects its token at serve time only; packaged builds never contain it and read
 * the token the user stored on the phone (pairing in Task 22 replaces this).
 */
export async function loadToken(devToken: string, storage: TokenStorage): Promise<string | null> {
  if (devToken) return devToken;
  const stored = (await storage.get(TOKEN_KEY)).trim();
  return stored || null;
}

export async function saveToken(raw: string, storage: TokenStorage): Promise<boolean> {
  const token = raw.trim();
  if (!/^\S{16,}$/.test(token)) return false;
  return storage.set(TOKEN_KEY, token);
}
