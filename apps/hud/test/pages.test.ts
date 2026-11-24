import { describe, expect, it } from 'vitest';
import { createPageRenderer, type PageBridge, planUpdate } from '../src/bridge/pages';
import { createBridgeQueue } from '../src/bridge/queue';
import { layoutActions, layoutStatus, type PageSpec } from '../src/render/layout';

function fakeBridge(createResult = 0) {
  const calls: { method: string; arg: unknown }[] = [];
  const bridge: PageBridge = {
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

const page = (value: string, hint = 'TAP actions · HOLD speak'): PageSpec =>
  layoutStatus({ title: 'ETH LONG 2×', value, lines: ['line'], hint });

const actions = layoutActions({
  id: 'perp:ETH',
  kind: 'perp',
  title: 'ETH LONG 2×',
  value: '+$1.00',
  lines: [],
  hint: '',
  badge: 'TESTNET',
  actions: [
    { id: 'a', label: 'Close all', intent: { kind: 'closePerp', coin: 'ETH', fraction: 1 } },
  ],
});

describe('planUpdate', () => {
  it('upgrades in place when the layout is the same and at most two texts changed', () => {
    const plan = planUpdate(page('+$1.00'), page('+$2.00'));
    expect(plan.kind).toBe('upgrade');
    expect(plan.kind === 'upgrade' && plan.texts.map((t) => t.name)).toEqual(['val']);
  });

  it('does nothing when nothing changed', () => {
    expect(planUpdate(page('+$1.00'), page('+$1.00')).kind).toBe('none');
  });

  it('rebuilds when the layout changes or more than two texts changed', () => {
    expect(planUpdate(page('+$1.00'), actions).kind).toBe('rebuild');
    const other = layoutStatus({ title: 'SOL', value: '+$9.00', lines: ['x'], hint: 'y' });
    expect(planUpdate(page('+$1.00'), other).kind).toBe('rebuild');
    expect(planUpdate(null, page('+$1.00')).kind).toBe('rebuild');
  });
});

describe('createPageRenderer', () => {
  it('creates the startup page once, then upgrades only the changed text', async () => {
    const { bridge, calls } = fakeBridge();
    let marks = 0;
    const r = createPageRenderer(bridge, createBridgeQueue(), () => marks++);
    await r.render(page('+$1.00'));
    await r.render(page('+$2.00'));
    expect(calls.map((c) => c.method)).toEqual(['create', 'upgrade']);
    expect(JSON.stringify(calls[0]?.arg)).toContain('"menuObject"');
    expect(JSON.stringify(calls[1]?.arg)).toContain('"containerName":"val"');
    expect(JSON.stringify(calls[1]?.arg)).toContain('+$2.00');
    expect(marks).toBe(2);
  });

  it('rebuilds with the contextual menu on a layout change', async () => {
    const { bridge, calls } = fakeBridge();
    const r = createPageRenderer(bridge, createBridgeQueue(), () => {});
    await r.render(page('+$1.00'));
    await r.render(actions);
    expect(calls.map((c) => c.method)).toEqual(['create', 'rebuild']);
    const rebuild = JSON.stringify(calls[1]?.arg);
    expect(rebuild).toContain('"menuObject"');
    expect(rebuild).toContain('Cancel orders');
    expect(rebuild).toContain('"listObject"');
  });

  it('falls back to a rebuild when the startup page was refused', async () => {
    const { bridge, calls } = fakeBridge(1);
    const r = createPageRenderer(bridge, createBridgeQueue(), () => {});
    await r.render(page('+$1.00'));
    await r.render(page('+$2.00'));
    expect(calls.map((c) => c.method)).toEqual(['create', 'rebuild']);
  });

  it('keeps rendering when the startup call hangs past the bridge timeout', async () => {
    const { bridge, calls } = fakeBridge();
    bridge.createStartUpPageContainer = () => new Promise<number>(() => {});
    const r = createPageRenderer(bridge, createBridgeQueue({ timeoutMs: 50 }), () => {});
    await r.render(page('+$1.00'));
    await r.render(page('+$2.00'));
    expect(calls.map((c) => c.method)).toEqual(['rebuild']);
  });

  it('rebuilds after an in-place upgrade fails, so stale text never stays on the glasses', async () => {
    const { bridge, calls } = fakeBridge();
    let failNext = false;
    const upgrade = bridge.textContainerUpgrade;
    bridge.textContainerUpgrade = async (arg) => {
      if (failNext) {
        failNext = false;
        calls.push({ method: 'upgrade-failed', arg });
        return false;
      }
      return upgrade(arg);
    };
    const r = createPageRenderer(bridge, createBridgeQueue(), () => {});
    await r.render(page('+$1.00'));
    failNext = true;
    await r.render(page('+$2.00'));
    await r.render(page('+$3.00'));
    expect(calls.map((c) => c.method)).toEqual(['create', 'upgrade-failed', 'rebuild']);
  });

  it('coalesces renders requested while one is in flight (latest wins)', async () => {
    const { bridge, calls } = fakeBridge();
    const r = createPageRenderer(bridge, createBridgeQueue(), () => {});
    await r.render(page('+$1.00'));
    await Promise.all([
      r.render(page('+$2.00')),
      r.render(page('+$3.00')),
      r.render(page('+$4.00')),
    ]);
    const upgrades = calls.filter((c) => c.method === 'upgrade').map((c) => JSON.stringify(c.arg));
    expect(upgrades.length).toBeLessThanOrEqual(2);
    expect(upgrades.at(-1)).toContain('+$4.00');
  });
});
