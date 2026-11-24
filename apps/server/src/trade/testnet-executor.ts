import type { ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { apiResponseOf, humanizeHlError, mapOrderStatuses, statusesOf } from '../hl/errors';
import type { PerpMeta } from '../hl/ids';
import type {
  ExecResult,
  Executor,
  OrderPlan,
  PlaceOrder,
  PlanStep,
  TriggerOrder,
} from './executor';

/** The exchange calls the executor makes (structural, so tests can stub them). */
export type ExchangeLike = Pick<
  ExchangeClient,
  'order' | 'updateLeverage' | 'agentSendAsset' | 'cancel'
>;
export type InfoLike = Pick<InfoClient, 'frontendOpenOrders' | 'spotMeta'>;

export type TestnetExecutorDeps = {
  exchange: ExchangeLike;
  info: InfoLike;
  /** Master account: transfers go to it and open orders are read from it (never the agent). */
  master: string;
  /** `USDC:<tokenId>` (see loadUsdcToken). */
  usdcToken: string;
  /** Perp name → asset id, for cancel-all. */
  perpMeta: PerpMeta[];
  now: () => number;
};

/** A signed action older than this is refused by the exchange ("Action already expired"). */
const EXPIRES_AFTER_MS = 10_000;
const OUTCOME_ASSET_BASE = 100_000_000;
const SPOT_ASSET_BASE = 10_000;

type Addr = `0x${string}`;
type WireOrder = Parameters<ExchangeLike['order']>[0]['orders'][number];

/** `USDC:<tokenId>`, the token string sendAsset needs (testnet `USDC:0xeb62…5443`). */
export async function loadUsdcToken(info: InfoLike): Promise<string> {
  const meta = await info.spotMeta();
  const usdc = meta.tokens.find((t) => t.name === 'USDC');
  if (!usdc) throw new Error('USDC not found in spotMeta');
  return `USDC:${usdc.tokenId}`;
}

function wireOrder(o: PlaceOrder): WireOrder {
  return {
    a: o.asset,
    b: o.isBuy,
    p: o.px,
    s: o.sz,
    r: o.reduceOnly,
    t: { limit: { tif: o.tif } },
  };
}

/** Stops are market triggers attached to the position; they are always reduce-only. */
function wireTrigger(o: TriggerOrder): WireOrder {
  return {
    a: o.asset,
    b: o.isBuy,
    p: o.px,
    s: o.sz,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: o.triggerPx, tpsl: o.tpsl } },
  };
}

/** Consecutive steps of the same kind run as one exchange call (one batched order action). */
function runs(steps: PlanStep[]): PlanStep[][] {
  const out: PlanStep[][] = [];
  for (const s of steps) {
    const last = out.at(-1);
    const batchable = s.kind === 'order' || s.kind === 'trigger';
    if (last && batchable && last[0]?.kind === s.kind) last.push(s);
    else out.push([s]);
  }
  return out;
}

/**
 * Runs order plans on Hyperliquid testnet with the agent wallet. Steps run in order and the first
 * failure stops the plan, so an order never goes out after a failed leverage change or transfer.
 */
export class TestnetExecutor implements Executor {
  constructor(private readonly deps: TestnetExecutorDeps) {}

  async execute(plan: OrderPlan): Promise<ExecResult> {
    let last: ExecResult = { status: 'none', message: 'Nothing to do' };
    for (const run of runs(plan.steps)) {
      const first = run[0] as PlanStep;
      if (first.kind === 'leverage') {
        const err = await this.attempt(() =>
          this.deps.exchange.updateLeverage({
            asset: first.asset,
            isCross: first.isCross,
            leverage: first.leverage,
          }),
        );
        if (err) return err;
      } else if (first.kind === 'perpToSpot') {
        const err = await this.attempt(() =>
          this.deps.exchange.agentSendAsset({
            destination: this.deps.master as Addr,
            sourceDex: '',
            destinationDex: 'spot',
            token: this.deps.usdcToken,
            amount: first.usd,
            fromSubAccount: '',
          }),
        );
        if (err) return err;
      } else if (first.kind === 'order') {
        last = await this.place((run as PlaceOrder[]).map(wireOrder), 'na', plan.requestedSz);
        if (last.status === 'none' || last.status === 'error') return last;
      } else {
        last = await this.place(
          (run as TriggerOrder[]).map(wireTrigger),
          'positionTpsl',
          plan.requestedSz,
        );
        if (last.status === 'resting') last = { ...last, message: 'Stop set' };
        if (last.status === 'none' || last.status === 'error') return last;
      }
    }
    return last;
  }

  async cancelAll(): Promise<ExecResult> {
    let open: { coin: string; oid: number }[];
    try {
      open = await this.deps.info.frontendOpenOrders({ user: this.deps.master as Addr });
    } catch (e) {
      return { status: 'error', message: humanizeHlError(e) };
    }
    const cancels = open.flatMap((o) => {
      const a = this.assetOf(o.coin);
      return a === null ? [] : [{ a, o: o.oid }];
    });
    if (cancels.length === 0) return { status: 'filled', message: 'No open orders' };
    try {
      // No `f` (fast) flag: it would refuse trigger orders, and `f:false` is rejected.
      await this.deps.exchange.cancel({ cancels });
      return { status: 'filled', message: `Cancelled ${cancels.length} orders` };
    } catch (e) {
      const statuses = statusesOf(apiResponseOf(e));
      if (statuses) {
        const ok = statuses.filter((s) => s === 'success').length;
        return {
          status: ok > 0 ? 'partial' : 'none',
          message: `Cancelled ${ok}/${cancels.length} orders`,
        };
      }
      return { status: 'error', message: humanizeHlError(e) };
    }
  }

  /** Outcome `#enc` → 100000000+enc, spot `@N` → 10000+N, perp name → meta index. */
  private assetOf(coin: string): number | null {
    if (coin.startsWith('#')) return OUTCOME_ASSET_BASE + Number(coin.slice(1));
    if (coin.startsWith('@')) return SPOT_ASSET_BASE + Number(coin.slice(1));
    return this.deps.perpMeta.find((m) => m.name === coin)?.index ?? null;
  }

  private async place(
    orders: WireOrder[],
    grouping: 'na' | 'positionTpsl',
    requestedSz: number,
  ): Promise<ExecResult> {
    try {
      const res = await this.deps.exchange.order(
        { orders, grouping },
        { expiresAfter: this.deps.now() + EXPIRES_AFTER_MS },
      );
      return mapOrderStatuses(statusesOf(res) ?? [], requestedSz);
    } catch (e) {
      const response = apiResponseOf(e);
      const statuses = statusesOf(response);
      if (statuses) return mapOrderStatuses(statuses, requestedSz);
      // The exchange refused the whole request: nothing executed. Anything else (network,
      // timeout) leaves the outcome unknown, so it is an error the user must check.
      return response !== undefined
        ? { status: 'none', requestedSz, message: humanizeHlError(e) }
        : { status: 'error', requestedSz, message: humanizeHlError(e) };
    }
  }

  /** Runs a setup call; on failure the plan stops before any order, so nothing executed. */
  private async attempt(call: () => Promise<unknown>): Promise<ExecResult | null> {
    try {
      await call();
      return null;
    } catch (e) {
      return { status: 'none', message: humanizeHlError(e) };
    }
  }
}
