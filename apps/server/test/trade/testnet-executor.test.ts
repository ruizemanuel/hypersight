import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import { describe, expect, it, vi } from 'vitest';
import type { PerpMeta } from '../../src/hl/ids';
import type { OrderPlan, PlaceOrder } from '../../src/trade/executor';
import {
  type ExchangeLike,
  type InfoLike,
  loadUsdcToken,
  TestnetExecutor,
} from '../../src/trade/testnet-executor';

const MASTER = '0x1111111111111111111111111111111111111111';
const USDC = 'USDC:0xeb62eee3685fc4c43992febcd9e75443';
const NOW = 1_795_000_000_000;
const perpMeta: PerpMeta[] = [
  { name: 'SOL', index: 0, szDecimals: 2, maxLeverage: 10, onlyIsolated: false },
  { name: 'BTC', index: 3, szDecimals: 5, maxLeverage: 40, onlyIsolated: false },
  { name: 'ETH', index: 4, szDecimals: 4, maxLeverage: 25, onlyIsolated: false },
];

const filled = (sz: string, px: string) => ({
  status: 'ok',
  response: { type: 'order', data: { statuses: [{ filled: { totalSz: sz, avgPx: px, oid: 9 } }] } },
});

function harness(over: Partial<Record<keyof ExchangeLike, (...a: unknown[]) => unknown>> = {}) {
  const calls: string[] = [];
  const exchange = {
    order: vi.fn(async (..._a: unknown[]) => {
      calls.push('order');
      return filled('0.004', '3000');
    }),
    updateLeverage: vi.fn(async (..._a: unknown[]) => {
      calls.push('updateLeverage');
      return { status: 'ok', response: { type: 'default' } };
    }),
    agentSendAsset: vi.fn(async (..._a: unknown[]) => {
      calls.push('agentSendAsset');
      return { status: 'ok', response: { type: 'default' } };
    }),
    cancel: vi.fn(async (..._a: unknown[]) => {
      calls.push('cancel');
      return {
        status: 'ok',
        response: { type: 'cancel', data: { statuses: ['success', 'success'] } },
      };
    }),
  };
  for (const [k, fn] of Object.entries(over)) {
    (exchange as Record<string, unknown>)[k] = vi.fn(async (...a: unknown[]) => {
      calls.push(k);
      return fn(...a);
    });
  }
  const info = {
    frontendOpenOrders: vi.fn(async () => [
      { coin: '#271210', oid: 11 },
      { coin: 'BTC', oid: 12 },
    ]),
    spotMeta: vi.fn(async () => ({ tokens: [] })),
  };
  const executor = new TestnetExecutor({
    exchange: exchange as unknown as ExchangeLike,
    info: info as unknown as InfoLike,
    master: MASTER,
    usdcToken: USDC,
    perpMeta,
    now: () => NOW,
  });
  return { executor, exchange, info, calls };
}

const ethOrder: PlaceOrder = {
  kind: 'order',
  asset: 4,
  coin: 'ETH',
  isBuy: true,
  px: '3030',
  sz: '0.004',
  reduceOnly: false,
  tif: 'Ioc',
};

describe('TestnetExecutor', () => {
  it('sets leverage before the order', async () => {
    const { executor, exchange, calls } = harness();
    const plan: OrderPlan = {
      steps: [{ kind: 'leverage', asset: 4, leverage: 2, isCross: true }, ethOrder],
      requestedSz: 0.004,
    };
    const r = await executor.execute(plan);
    expect(calls).toEqual(['updateLeverage', 'order']);
    expect(exchange.updateLeverage).toHaveBeenCalledWith({ asset: 4, isCross: true, leverage: 2 });
    expect(r).toMatchObject({ status: 'filled', message: 'Filled 0.004 @ 3000' });
  });

  it('never places the order when setting leverage fails', async () => {
    const { executor, calls } = harness({
      updateLeverage: () => {
        throw new ApiRequestError(
          { status: 'err', response: 'Invalid leverage value' },
          'Invalid leverage value',
        );
      },
    });
    const r = await executor.execute({
      steps: [{ kind: 'leverage', asset: 4, leverage: 2, isCross: true }, ethOrder],
      requestedSz: 0.004,
    });
    expect(calls).toEqual(['updateLeverage']);
    expect(r.status).toBe('none');
  });

  it('moves USDC to spot before an outcome buy, from the master account', async () => {
    const { executor, exchange, calls } = harness({
      order: () => filled('40', '0.62'),
    });
    await executor.execute({
      steps: [
        { kind: 'perpToSpot', usd: '15' },
        { ...ethOrder, asset: 100271210, coin: '#271210', px: '0.65', sz: '40' },
      ],
      requestedSz: 40,
    });
    expect(calls).toEqual(['agentSendAsset', 'order']);
    expect(exchange.agentSendAsset).toHaveBeenCalledWith({
      destination: MASTER,
      sourceDex: '',
      destinationDex: 'spot',
      token: USDC,
      amount: '15',
      fromSubAccount: '',
    });
  });

  it('does not order when the transfer fails', async () => {
    const { executor, calls } = harness({
      agentSendAsset: () => {
        throw new Error('network down');
      },
    });
    const r = await executor.execute({
      steps: [{ kind: 'perpToSpot', usd: '15' }, ethOrder],
      requestedSz: 0.004,
    });
    expect(calls).toEqual(['agentSendAsset']);
    expect(r.status).toBe('none');
  });

  it('sends orders in the wire format with a 10 s expiry', async () => {
    const { executor, exchange } = harness();
    await executor.execute({ steps: [ethOrder], requestedSz: 0.004 });
    expect(exchange.order).toHaveBeenCalledWith(
      {
        orders: [{ a: 4, b: true, p: '3030', s: '0.004', r: false, t: { limit: { tif: 'Ioc' } } }],
        grouping: 'na',
      },
      { expiresAfter: NOW + 10_000 },
    );
  });

  it('attaches stop orders to the position (positionTpsl)', async () => {
    const { executor, exchange } = harness({
      order: () => ({
        status: 'ok',
        response: { type: 'order', data: { statuses: ['waitingForTrigger'] } },
      }),
    });
    const r = await executor.execute({
      steps: [
        {
          kind: 'trigger',
          asset: 4,
          coin: 'ETH',
          isBuy: false,
          px: '2700',
          sz: '0.004',
          triggerPx: '3000',
          tpsl: 'sl',
        },
      ],
      requestedSz: 0.004,
    });
    expect(exchange.order).toHaveBeenCalledWith(
      {
        orders: [
          {
            a: 4,
            b: false,
            p: '2700',
            s: '0.004',
            r: true,
            t: { trigger: { isMarket: true, triggerPx: '3000', tpsl: 'sl' } },
          },
        ],
        grouping: 'positionTpsl',
      },
      { expiresAfter: NOW + 10_000 },
    );
    expect(r).toMatchObject({ status: 'resting', message: 'Stop set' });
  });

  it('reads per-order statuses from an ApiRequestError (partial batch failure)', async () => {
    const { executor } = harness({
      order: () => {
        throw new ApiRequestError(
          {
            status: 'ok',
            response: {
              type: 'order',
              data: { statuses: [{ error: 'Order has invalid size.' }] },
            },
          },
          'order 0: Order has invalid size.',
        );
      },
    });
    const r = await executor.execute({ steps: [ethOrder], requestedSz: 0.004 });
    expect(r).toMatchObject({ status: 'none', message: 'Whole shares only' });
  });

  it('treats an HTTP failure (e.g. a 504) as an unknown outcome, never as nothing executed', async () => {
    const { executor } = harness({
      order: () => {
        // The SDK's HttpRequestError also carries a `response` (the fetch Response).
        throw Object.assign(new Error('504 Gateway Timeout - upstream timeout'), {
          name: 'HttpRequestError',
          response: new Response('upstream timeout', { status: 504 }),
        });
      },
    });
    const r = await executor.execute({ steps: [ethOrder], requestedSz: 0.004 });
    expect(r.status).toBe('error');
  });

  it('reports a failed setup step as nothing executed (no order was sent)', async () => {
    const { executor } = harness({
      updateLeverage: () => {
        throw new Error('network down');
      },
    });
    const r = await executor.execute({
      steps: [{ kind: 'leverage', asset: 4, leverage: 2, isCross: true }, ethOrder],
      requestedSz: 0.004,
    });
    expect(r.status).toBe('none');
  });

  it('reports a whole-request rejection as nothing executed', async () => {
    const { executor } = harness({
      order: () => {
        throw new ApiRequestError(
          { status: 'err', response: 'Action already expired' },
          'Action already expired',
        );
      },
    });
    const r = await executor.execute({ steps: [ethOrder], requestedSz: 0.004 });
    expect(r).toMatchObject({ status: 'none', message: 'Expired — nothing sent' });
  });

  it('cancels every open order in one batch, mapping coins to assets', async () => {
    const { executor, exchange, info } = harness();
    const r = await executor.cancelAll();
    expect(info.frontendOpenOrders).toHaveBeenCalledWith({ user: MASTER });
    expect(exchange.cancel).toHaveBeenCalledWith({
      cancels: [
        { a: 100271210, o: 11 },
        { a: 3, o: 12 },
      ],
    });
    expect(r).toMatchObject({ status: 'filled', message: 'Cancelled 2 orders' });
  });

  it('says so when there is nothing to cancel', async () => {
    const { executor, exchange, info } = harness();
    info.frontendOpenOrders.mockResolvedValueOnce([]);
    const r = await executor.cancelAll();
    expect(exchange.cancel).not.toHaveBeenCalled();
    expect(r.message).toBe('No open orders');
  });
});

describe('loadUsdcToken', () => {
  it('builds the transfer token string from spotMeta', async () => {
    const info = {
      spotMeta: async () => ({
        tokens: [
          { name: 'HYPE', tokenId: '0xaaa' },
          { name: 'USDC', tokenId: '0xeb62eee3685fc4c43992febcd9e75443' },
        ],
      }),
    };
    expect(await loadUsdcToken(info as unknown as InfoLike)).toBe(USDC);
  });
});

describe.runIf(process.env.RUN_LIVE_HL === '1')('TestnetExecutor (live, testnet)', () => {
  it('rests 1 share of the BTC daily YES at 0.01 and cancels it', async () => {
    const { loadConfig } = await import('../../src/config');
    const { createHlClients } = await import('../../src/hl/clients');
    const { parsePerpMeta } = await import('../../src/hl/ids');
    const { Catalogue } = await import('../../src/hl/outcomes');
    const cfg = loadConfig(process.env);
    const hl = createHlClients(cfg);
    const exchange = hl.exchange as unknown as ExchangeLike;
    const info = hl.info;
    const catalogue = new Catalogue();
    catalogue.reset(await info.outcomeMeta(), await info.outcomeTemplates());
    const daily = catalogue.byKey('rb:BTC:1d');
    expect(daily).toBeDefined();
    const asset = 100_000_000 + 10 * (daily?.outcome ?? 0);
    const executor = new TestnetExecutor({
      exchange,
      info: info as unknown as InfoLike,
      master: cfg.accountAddress,
      usdcToken: await loadUsdcToken(info as unknown as InfoLike),
      perpMeta: parsePerpMeta(await info.meta()),
      now: Date.now,
    });
    const placed = await executor.execute({
      steps: [
        {
          kind: 'order',
          asset,
          coin: `#${asset - 100_000_000}`,
          isBuy: true,
          px: '0.01',
          sz: '100',
          reduceOnly: false,
          tif: 'Gtc',
        },
      ],
      requestedSz: 100,
    });
    console.log('[live] placed:', JSON.stringify(placed));
    const cancelled = await executor.cancelAll();
    console.log('[live] cancelled:', JSON.stringify(cancelled));
    await hl.close();
    expect(placed.status).toBe('resting');
    expect(cancelled.status).toBe('filled');
  }, 60_000);
});
