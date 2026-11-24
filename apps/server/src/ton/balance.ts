export type GramBalance = { gram: number } | { error: string };

type FetchFn = (url: string) => Promise<Response>;

const TONCENTER = 'https://testnet.toncenter.com/api/v2/getAddressBalance';
const CACHE_MS = 60_000;
const NANO = 1e9;

/** Read-only Gram (TON testnet) balance from toncenter: nanotons → GRAM. */
export async function fetchGramBalance(
  address: string,
  fetchFn: FetchFn = fetch,
): Promise<GramBalance> {
  try {
    const res = await fetchFn(`${TONCENTER}?address=${encodeURIComponent(address)}`);
    if (!res.ok) return { error: 'TON unavailable' };
    const body = (await res.json()) as { ok?: boolean; result?: unknown };
    const nano = Number(body.result);
    if (body.ok !== true || typeof body.result !== 'string' || !Number.isFinite(nano)) {
      return { error: 'TON unavailable' };
    }
    return { gram: nano / NANO };
  } catch {
    return { error: 'TON unavailable' };
  }
}

/** The balance with a 60 s cache (the deck asks for it on every rebuild). */
export function createGramBalance(
  address: string,
  opts: { fetchFn?: FetchFn; now?: () => number } = {},
) {
  const now = opts.now ?? Date.now;
  let value: GramBalance | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  return {
    current: (): GramBalance | null => value,
    async refresh(): Promise<GramBalance> {
      if (value && now() - fetchedAt < CACHE_MS) return value;
      fetchedAt = now();
      value = await fetchGramBalance(address, opts.fetchFn);
      return value;
    },
  };
}
