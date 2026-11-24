import type { BridgeQueue } from './queue';

export type StorageBridge = {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
};

export type QueuedStorage = {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<boolean>;
};

/**
 * Bridge storage shares the BLE/bridge path with rendering: route it through the same serial
 * queue (with its timeout) so a stuck read can neither hang boot nor collide with a render.
 */
export function queuedStorage(bridge: StorageBridge, queue: BridgeQueue): QueuedStorage {
  return {
    get: (key) => queue.run(() => bridge.getLocalStorage(key)),
    set: (key, value) => queue.run(() => bridge.setLocalStorage(key, value)),
  };
}
