export class BridgeTimeout extends Error {
  override name = 'BridgeTimeout';
}

export type BridgeQueue = {
  /** Runs `fn` after every previously queued job has settled; rejects with BridgeTimeout if it hangs. */
  run<T>(fn: () => Promise<T>): Promise<T>;
};

/**
 * Serializes every bridge call: the BLE link handles one request at a time and a call that never
 * answers must not block the HUD forever.
 */
export function createBridgeQueue(opts: { timeoutMs?: number } = {}): BridgeQueue {
  const timeoutMs = opts.timeoutMs ?? 4000;
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const job = tail.then(() => withTimeout(fn, timeoutMs));
      tail = job.catch(() => undefined);
      return job;
    },
  };
}

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BridgeTimeout(`bridge call timed out after ${ms} ms`)),
      ms,
    );
    Promise.resolve()
      .then(fn)
      .then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
  });
}
