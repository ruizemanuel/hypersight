import type { Intent } from '@hypersight/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView, OutcomePosition, PerpPosition } from '../../src/hl/account';
import type { PerpMeta } from '../../src/hl/ids';
import type { Book } from '../../src/hl/market-stream';
import { Catalogue, type OutcomeMarket } from '../../src/hl/outcomes';
import { openDb } from '../../src/store/db';
import { createRepos, type Repos } from '../../src/store/repos';
import { type ExecResult, FakeExecutor, type PlaceOrder } from '../../src/trade/executor';
import { type Proposal, ProposalService } from '../../src/trade/proposals';

const T0 = Date.UTC(2026, 10, 24, 12, 0);

const perpMeta: PerpMeta[] = [
  { name: 'SOL', index: 0, szDecimals: 2, maxLeverage: 10, onlyIsolated: false },
  { name: 'BTC', index: 3, szDecimals: 5, maxLeverage: 40, onlyIsolated: false },
  { name: 'ETH', index: 4, szDecimals: 4, maxLeverage: 25, onlyIsolated: false },
  { name: 'HYPE', index: 135, szDecimals: 2, maxLeverage: 10, onlyIsolated: true },
];

const btcDailySpec = {
  outcome: 27321,
  name: 'Recurring',
  description: 'class:priceBinary|underlying:BTC|expiry:20261125-0300|targetPrice:61509|period:1d',
  sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
};

const ethLong: PerpPosition = {
  coin: 'ETH',
  size: 0.5,
  entryPx: 3326.8,
  markPx: 3411,
  upnlUsd: 42.1,
  roe: 0.031,
  leverage: 2,
  isCross: true,
  liqPx: 2950,
  szDecimals: 4,
};

type Setup = {
  service: ProposalService;
  executor: FakeExecutor;
  repos: Repos;
  catalogue: Catalogue;
  clock: { now: number };
  books: Record<string, Book>;
  view: AccountView;
};

function setup(over: Partial<AccountView> = {}, books: Record<string, Book> = {}): Setup {
  const clock = { now: T0 };
  const catalogue = new Catalogue({ now: () => clock.now });
  catalogue.reset({ outcomes: [btcDailySpec], questions: [] }, []);
  const view: AccountView = {
    equityUsd: 1000,
    perpUpnlUsd: 42.1,
    marginRatio: 0.1,
    marginUsage: 0.3,
    perpWithdrawableUsd: 500,
    spotUsdc: 999,
    perps: [ethLong],
    outcomes: [],
    abstraction: 'unifiedAccount',
    updatedAt: T0,
    ...over,
  };
  const allBooks: Record<string, Book> = {
    ETH: { bids: [{ px: 3411, sz: 10 }], asks: [{ px: 3412, sz: 10 }] },
    HYPE: { bids: [{ px: 60, sz: 100 }], asks: [{ px: 60.1, sz: 100 }] },
    '#273210': { bids: [{ px: 0.6, sz: 100 }], asks: [{ px: 0.62, sz: 100 }] },
    '#273211': { bids: [{ px: 0.37, sz: 100 }], asks: [{ px: 0.4, sz: 100 }] },
    ...books,
  };
  const repos = createRepos(openDb(':memory:'));
  const executor = new FakeExecutor();
  const service = new ProposalService({
    stream: { view: () => view, book: async (coin) => allBooks[coin] ?? { bids: [], asks: [] } },
    catalogue,
    repos,
    executor,
    perpMeta,
    network: 'testnet',
    now: () => clock.now,
  });
  return { service, executor, repos, catalogue, clock, books: allBooks, view };
}

async function proposed(s: Setup, intent: Intent): Promise<Proposal> {
  const p = await s.service.propose(intent);
  if ('blocked' in p) throw new Error(`blocked: ${p.blocked}`);
  return p;
}

const order = (p: Proposal) => p.plan.steps.find((st) => st.kind === 'order') as PlaceOrder;

describe('ProposalService.propose', () => {
  it('closes half of a perp with a reduce-only IOC sell at the bid side', async () => {
    const s = setup();
    const p = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    expect(p.plan.steps).toHaveLength(1);
    expect(order(p)).toMatchObject({
      asset: 4,
      isBuy: false,
      reduceOnly: true,
      sz: '0.25',
      tif: 'Ioc',
    });
    expect(Number(order(p).px)).toBeLessThan(3411);
    expect(p.view.title).toBe('CLOSE 50% ETH LONG');
    expect(p.view.lines[0]).toBe('0.25 ETH ≈ $852.75 @ ~3,411');
    expect(p.view.expiresAt).toBe(T0 + 15_000);
  });

  it('states 100% explicitly for a full close (misheard "half" → "all" is visible)', async () => {
    const p = await proposed(setup(), { kind: 'closePerp', coin: 'ETH', fraction: 1 });
    expect(p.view.title).toBe('CLOSE 100% ETH LONG');
    expect(order(p).sz).toBe('0.5');
  });

  it('blocks closing a position that does not exist', async () => {
    expect(await setup().service.propose({ kind: 'closePerp', coin: 'SOL', fraction: 1 })).toEqual({
      blocked: 'No SOL position',
    });
  });

  it('moves the shortfall perp → spot first in a standard account', async () => {
    const s = setup({ abstraction: 'default', spotUsdc: 10, perpWithdrawableUsd: 500 });
    const p = await proposed(s, {
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
      usd: 25,
    });
    expect(p.plan.steps.map((st) => st.kind)).toEqual(['perpToSpot', 'order']);
    expect(p.plan.steps[0]).toEqual({ kind: 'perpToSpot', usd: '15' });
    expect(order(p)).toMatchObject({
      asset: 100273210,
      isBuy: true,
      sz: '40',
      tif: 'Ioc',
      reduceOnly: false,
    });
    expect(p.view.lines.join(' | ')).toContain('moves $15 perp → spot');
  });

  it('uses spot USDC directly in a unified account and blocks when it is short', async () => {
    const rich = await proposed(setup(), {
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
      usd: 25,
    });
    expect(rich.plan.steps.map((st) => st.kind)).toEqual(['order']);
    expect(rich.view.title).toBe('BUY YES · BTC > 61,509 · daily');
    expect(rich.view.lines).toEqual(['40 shares @ ~0.62 = $24.80', 'pays $40 if YES']);
    const poor = await setup({ spotUsdc: 10 }).service.propose({
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
      usd: 25,
    });
    expect(poor).toEqual({ blocked: 'Not enough USDC' });
  });

  it('blocks a risky open and audits it', async () => {
    const s = setup();
    expect(
      await s.service.propose({ kind: 'openPerp', coin: 'ETH', side: 'long', usd: 500 }),
    ).toEqual({
      blocked: 'Max order is $250',
    });
    expect(s.repos.audit.list(1)[0]).toMatchObject({
      kind: 'blocked',
      summary: expect.stringContaining('Max order'),
    });
  });

  it('opens a perp with an explicit leverage step first (fresh accounts default to 20×)', async () => {
    const p = await proposed(setup(), { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 50 });
    expect(p.plan.steps[0]).toEqual({ kind: 'leverage', asset: 4, leverage: 2, isCross: true });
    expect(p.plan.steps[1]).toMatchObject({ kind: 'order', isBuy: true, tif: 'Ioc', sz: '0.0146' });
    expect(p.view.lines.join(' | ')).toContain('2× cross');
  });

  it('uses isolated margin for isolated-only assets', async () => {
    const p = await proposed(setup(), { kind: 'openPerp', coin: 'HYPE', side: 'short', usd: 50 });
    expect(p.plan.steps[0]).toEqual({ kind: 'leverage', asset: 135, leverage: 2, isCross: false });
    expect(p.view.lines.join(' | ')).toContain('2× isolated');
  });

  it('enforces the $10 perp minimum', async () => {
    expect(
      await setup().service.propose({ kind: 'openPerp', coin: 'ETH', side: 'long', usd: 8 }),
    ).toEqual({
      blocked: 'Minimum $10',
    });
  });

  it('sizes down to the depth available within the slippage cap', async () => {
    const s = setup(
      {},
      {
        '#273210': {
          bids: [],
          asks: [
            { px: 0.51, sz: 18 },
            { px: 0.6, sz: 500 },
          ],
        },
      },
    );
    const p = await proposed(s, {
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
      usd: 25,
    });
    expect(order(p).sz).toBe('18');
    expect(p.view.lines).toContain('only 18 shares ≤ 0.54');
    expect(p.view.lines.length).toBeLessThanOrEqual(3);
  });

  it('blocks a buy with no sellers and a sell with no buyers', async () => {
    const empty = setup({}, { '#273210': { bids: [], asks: [] } });
    expect(
      await empty.service.propose({
        kind: 'buyOutcome',
        marketKey: 'rb:BTC:1d',
        sideIndex: 0,
        usd: 25,
      }),
    ).toEqual({ blocked: 'No sellers right now' });
  });

  it('sells held outcome shares at the bid side, by the held outcome id', async () => {
    const market = new Catalogue();
    market.reset({ outcomes: [btcDailySpec], questions: [] }, []);
    const held: OutcomePosition = {
      market: market.byOutcome(27321) as OutcomeMarket,
      sideIndex: 0,
      shares: 40,
      entryUsd: 24.8,
      mid: 0.61,
      valueUsd: 24.4,
      upnlUsd: -0.4,
      maxPayoutUsd: 40,
    };
    const s = setup({ outcomes: [held] });
    const p = await proposed(s, {
      kind: 'sellOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
      fraction: 0.5,
    });
    expect(order(p)).toMatchObject({ asset: 100273210, isBuy: false, sz: '20', reduceOnly: false });
    expect(order(p).px).toBe('0.57');
    expect(p.view.title).toBe('SELL YES · BTC > 61,509 · daily');
  });

  it('places a protective stop on the correct side of the mark', async () => {
    const s = setup();
    const p = await proposed(s, { kind: 'setStop', coin: 'ETH', triggerPx: 3200 });
    expect(p.plan.steps).toEqual([
      {
        kind: 'trigger',
        asset: 4,
        coin: 'ETH',
        isBuy: false,
        sz: '0.5',
        triggerPx: '3200',
        px: '2880',
        tpsl: 'sl',
      },
    ]);
    expect(await s.service.propose({ kind: 'setStop', coin: 'ETH', triggerPx: 3600 })).toEqual({
      blocked: 'Stop must be below mark for a long',
    });
  });

  it('refuses non-trading intents', async () => {
    expect(await setup().service.propose({ kind: 'query', topic: 'pnl' })).toEqual({
      blocked: 'Not an order',
    });
  });
});

describe('ProposalService.confirm', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it('executes once even when confirmed twice concurrently', async () => {
    let release: (r: ExecResult) => void = () => {};
    s.executor.execute = async (plan) => {
      s.executor.plans.push(plan);
      return new Promise<ExecResult>((r) => {
        release = r;
      });
    };
    const p = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    const a = s.service.confirm(p.id);
    const b = s.service.confirm(p.id);
    await vi.waitFor(() => expect(s.executor.plans).toHaveLength(1));
    release({
      status: 'filled',
      filledSz: 0.25,
      requestedSz: 0.25,
      avgPx: 3411,
      message: 'Filled 0.25 @ 3,411',
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(s.executor.plans).toHaveLength(1);
    expect(await s.service.confirm(p.id)).toEqual(ra);
  });

  it('records proposal, confirm and result in the audit log and counts daily usage for opens', async () => {
    s.executor.result = {
      status: 'filled',
      filledSz: 0.0146,
      requestedSz: 0.0146,
      avgPx: 3412,
      message: 'Filled',
    };
    const p = await proposed(s, { kind: 'openPerp', coin: 'ETH', side: 'long', usd: 50 });
    await s.service.confirm(p.id);
    expect(s.repos.audit.list(10).map((e) => e.kind)).toEqual(['result', 'confirm', 'proposal']);
    expect(s.repos.usage.today(s.clock.now)).toBeCloseTo(0.0146 * 3412, 6);
  });

  it('refuses a confirm after the market settled', async () => {
    const p = await proposed(s, {
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
      usd: 25,
    });
    s.catalogue.apply({ outcomeSettled: 27321 });
    expect(await s.service.confirm(p.id)).toEqual({
      status: 'none',
      message: 'Market closed — nothing sent',
    });
    expect(s.executor.plans).toHaveLength(0);
  });

  it('refuses a confirm after the market expired, even if the stable key moved on', async () => {
    const p = await proposed(s, {
      kind: 'buyOutcome',
      marketKey: 'rb:BTC:1d',
      sideIndex: 0,
      usd: 25,
    });
    s.catalogue.apply({
      outcomeCreated: {
        ...btcDailySpec,
        outcome: 27353,
        description:
          'class:priceBinary|underlying:BTC|expiry:20261126-0300|targetPrice:62000|period:1d',
      },
    });
    s.clock.now = Date.UTC(2026, 10, 25, 3, 0, 5);
    p.expiresAt = s.clock.now + 10_000; // isolate the market check from the proposal TTL
    expect(await s.service.confirm(p.id)).toEqual({
      status: 'none',
      message: 'Market closed — nothing sent',
    });
    expect(s.executor.plans).toHaveLength(0);
  });

  it('refuses an expired proposal', async () => {
    const p = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    s.clock.now = T0 + 16_000;
    expect(await s.service.confirm(p.id)).toEqual({
      status: 'error',
      message: 'Expired — nothing sent',
    });
    expect(await s.service.confirm('nope')).toEqual({
      status: 'error',
      message: 'Expired — nothing sent',
    });
    expect(s.executor.plans).toHaveLength(0);
  });

  it('asks for a fresh review when the price moved beyond the slippage cap', async () => {
    const p = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    s.books.ETH = { bids: [{ px: 3300, sz: 10 }], asks: [{ px: 3301, sz: 10 }] };
    expect(await s.service.confirm(p.id)).toEqual({
      status: 'none',
      message: 'Price moved — review again',
    });
    expect(s.executor.plans).toHaveLength(0);
  });

  it('does nothing after a cancel', async () => {
    const p = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    s.service.cancel(p.id);
    expect(await s.service.confirm(p.id)).toEqual({
      status: 'none',
      message: 'Cancelled — nothing sent',
    });
    expect(s.repos.audit.list(1)[0]?.kind).toBe('cancel');
  });

  it('cancels all open orders through the executor', async () => {
    const p = await proposed(s, { kind: 'cancelAll' });
    expect(p.view.title).toBe('CANCEL ALL ORDERS');
    await s.service.confirm(p.id);
    expect(s.executor.cancelAllCalls).toBe(1);
  });

  it('throttles back-to-back writes', async () => {
    const a = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.25 });
    const b = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.25 });
    await s.service.confirm(a.id);
    s.clock.now += 500;
    expect(await s.service.confirm(b.id)).toEqual({
      status: 'none',
      message: 'Too fast — wait a second',
    });
  });

  it('turns an executor failure into an error result', async () => {
    s.executor.execute = async () => {
      throw new Error('socket hang up');
    };
    const p = await proposed(s, { kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    expect(await s.service.confirm(p.id)).toMatchObject({ status: 'error' });
  });
});
