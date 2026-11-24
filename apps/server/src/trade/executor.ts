/** Order plans built by the proposal service and run by an executor (testnet, paper or fake). */

export type PlaceOrder = {
  kind: 'order';
  asset: number;
  coin: string;
  isBuy: boolean;
  px: string;
  sz: string;
  reduceOnly: boolean;
  tif: 'Ioc' | 'Gtc';
};

/** Standard (non-unified) accounts only: move USDC from perps to spot before an outcome buy. */
export type SpotTransfer = { kind: 'perpToSpot'; usd: string };

export type TriggerOrder = {
  kind: 'trigger';
  asset: number;
  coin: string;
  isBuy: boolean;
  px: string;
  sz: string;
  triggerPx: string;
  tpsl: 'sl' | 'tp';
};

/** Always sent before opening a perp: a fresh testnet account defaults to 20× cross. */
export type LeverageStep = { kind: 'leverage'; asset: number; leverage: number; isCross: boolean };

export type PlanStep = SpotTransfer | LeverageStep | PlaceOrder | TriggerOrder;

export type OrderPlan = { steps: PlanStep[]; requestedSz: number };

export type ExecResult = {
  status: 'filled' | 'partial' | 'resting' | 'none' | 'error';
  filledSz?: number;
  requestedSz?: number;
  avgPx?: number;
  message: string;
};

export interface Executor {
  execute(plan: OrderPlan): Promise<ExecResult>;
  cancelAll(): Promise<ExecResult>;
}

/** Records plans and returns a configurable result (tests, `EXECUTOR=fake`, e2e). */
export class FakeExecutor implements Executor {
  plans: OrderPlan[] = [];
  cancelAllCalls = 0;
  result: ExecResult = { status: 'filled', message: 'Filled' };

  async execute(plan: OrderPlan): Promise<ExecResult> {
    this.plans.push(plan);
    return { ...this.result };
  }

  async cancelAll(): Promise<ExecResult> {
    this.cancelAllCalls++;
    return { status: 'filled', message: 'All orders cancelled' };
  }
}
