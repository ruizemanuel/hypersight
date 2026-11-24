import { describe, expect, it } from 'vitest';
import { createBridgeQueue } from '../src/bridge/queue';
import { queuedStorage } from '../src/bridge/storage';

describe('queuedStorage', () => {
  it('reads and writes through the bridge', async () => {
    const data: Record<string, string> = { a: '1' };
    const storage = queuedStorage(
      {
        getLocalStorage: async (k) => data[k] ?? '',
        setLocalStorage: async (k, v) => {
          data[k] = v;
          return true;
        },
      },
      createBridgeQueue(),
    );
    expect(await storage.get('a')).toBe('1');
    expect(await storage.set('b', '2')).toBe(true);
    expect(data.b).toBe('2');
  });

  it('times out a stuck read instead of hanging the caller', async () => {
    const storage = queuedStorage(
      { getLocalStorage: () => new Promise<string>(() => {}), setLocalStorage: async () => true },
      createBridgeQueue({ timeoutMs: 50 }),
    );
    await expect(storage.get('hs.token')).rejects.toThrow(/timed out/);
  });

  it('serializes storage calls with other bridge calls', async () => {
    const order: string[] = [];
    const queue = createBridgeQueue();
    const storage = queuedStorage(
      {
        getLocalStorage: async () => {
          order.push('storage');
          return '';
        },
        setLocalStorage: async () => true,
      },
      queue,
    );
    const render = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('render');
    });
    await Promise.all([render, storage.get('x')]);
    expect(order).toEqual(['render', 'storage']);
  });
});
