import { describe, expect, it } from 'vitest';
import { createMainScreen, type ScreenBridge } from '../src/bridge/pages';
import { createBridgeQueue } from '../src/bridge/queue';

function fakeBridge(createResult = 0) {
  const calls: { method: string; arg: unknown }[] = [];
  const bridge: ScreenBridge = {
    createStartUpPageContainer: async (arg) => {
      calls.push({ method: 'create', arg });
      return createResult;
    },
    rebuildPageContainer: async (arg) => {
      calls.push({ method: 'rebuild', arg });
      return true;
    },
    textContainerUpgrade: async (arg) => {
      calls.push({ method: 'upgrade', arg });
      return true;
    },
  };
  return { bridge, calls };
}

describe('createMainScreen', () => {
  it('creates the startup page exactly once, then updates text in place', async () => {
    const { bridge, calls } = fakeBridge();
    let marks = 0;
    const screen = createMainScreen(bridge, createBridgeQueue(), () => marks++);
    await screen.start('HyperSight\nConnecting…');
    await screen.start('again');
    await screen.show('HyperSight\nConnected · TESTNET');
    expect(calls.map((c) => c.method)).toEqual(['create', 'upgrade']);
    expect(JSON.stringify(calls[0]?.arg)).toContain('"containerName":"main"');
    expect(JSON.stringify(calls[0]?.arg)).toContain('"isEventCapture":1');
    expect(JSON.stringify(calls[1]?.arg)).toContain('Connected · TESTNET');
    expect(marks).toBe(2);
  });

  it('falls back to a rebuild when the startup page was refused', async () => {
    const { bridge, calls } = fakeBridge(1);
    const screen = createMainScreen(bridge, createBridgeQueue(), () => {});
    expect(await screen.start('HyperSight\nConnecting…')).toBe(false);
    await screen.show('HyperSight\nConnected · TESTNET');
    expect(calls.map((c) => c.method)).toEqual(['create', 'rebuild']);
  });

  it('keeps booting when the startup call hangs past the bridge timeout', async () => {
    const { bridge, calls } = fakeBridge();
    bridge.createStartUpPageContainer = () => new Promise<number>(() => {});
    const screen = createMainScreen(bridge, createBridgeQueue({ timeoutMs: 50 }), () => {});
    await expect(screen.start('HyperSight\nConnecting…')).resolves.toBe(false);
    await screen.show('HyperSight\nConnected · TESTNET');
    expect(calls.map((c) => c.method)).toEqual(['rebuild']);
  });
});
