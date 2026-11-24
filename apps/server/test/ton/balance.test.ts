import { describe, expect, it, vi } from 'vitest';
import { createGramBalance, fetchGramBalance } from '../../src/ton/balance';

const ADDR = 'kQAbc';
const ok = (result: string) =>
  vi.fn(async () => new Response(JSON.stringify({ ok: true, result }), { status: 200 }));

describe('fetchGramBalance', () => {
  it('converts nanotons to GRAM from toncenter testnet', async () => {
    const f = ok('12500000000');
    expect(await fetchGramBalance(ADDR, f)).toEqual({ gram: 12.5 });
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(
      'https://testnet.toncenter.com/api/v2/getAddressBalance?address=kQAbc',
    );
  });

  it('reports TON unavailable on an HTTP error, a bad payload or a network failure', async () => {
    const http500 = vi.fn(async () => new Response('boom', { status: 500 }));
    expect(await fetchGramBalance(ADDR, http500)).toEqual({ error: 'TON unavailable' });
    expect(await fetchGramBalance(ADDR, ok('not a number'))).toEqual({ error: 'TON unavailable' });
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchGramBalance(ADDR, down)).toEqual({ error: 'TON unavailable' });
  });
});

describe('createGramBalance', () => {
  it('caches the balance for 60 s', async () => {
    const clock = { now: 0 };
    const f = ok('1000000000');
    const gram = createGramBalance(ADDR, { fetchFn: f, now: () => clock.now });
    await gram.refresh();
    await gram.refresh();
    expect(f).toHaveBeenCalledTimes(1);
    expect(gram.current()).toEqual({ gram: 1 });
    clock.now = 61_000;
    await gram.refresh();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
