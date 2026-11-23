import { describe, expect, it } from 'vitest';
import { BridgeTimeout, createBridgeQueue } from '../src/bridge/queue';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('createBridgeQueue', () => {
  it('runs jobs strictly one after another', async () => {
    const q = createBridgeQueue();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`${name}:start`);
      await sleep(50);
      log.push(`${name}:end`);
      return name;
    };
    const [a, b] = await Promise.all([q.run(job('a')), q.run(job('b'))]);
    expect([a, b]).toEqual(['a', 'b']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('rejects a hung job with BridgeTimeout and still runs the next job', async () => {
    const q = createBridgeQueue({ timeoutMs: 100 });
    const hung = q.run(() => new Promise<never>(() => {}));
    const next = q.run(async () => 'next');
    await expect(hung).rejects.toBeInstanceOf(BridgeTimeout);
    await expect(next).resolves.toBe('next');
  });

  it('keeps going after a job throws', async () => {
    const q = createBridgeQueue();
    const bad = q.run(async () => {
      throw new Error('boom');
    });
    await expect(bad).rejects.toThrow('boom');
    await expect(q.run(async () => 1)).resolves.toBe(1);
  });
});
