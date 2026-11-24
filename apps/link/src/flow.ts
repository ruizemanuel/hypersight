/** The link page's pairing flow, independent of the DOM and the wallet (tested with fakes). */

export type Step = 'info' | 'connect' | 'approve' | 'complete' | 'done';

export type FlowDeps = {
  /** The agent the glasses' code asks to approve (from the server). */
  getInfo(code: string): Promise<{ agentAddress: string; agentName: string }>;
  /** Connects the browser wallet; resolves with its address (the master account). */
  connect(): Promise<string>;
  /** The wallet signs Hyperliquid's `approveAgent` (testnet), sent straight to Hyperliquid. */
  approve(agentAddress: string, agentName: string): Promise<void>;
  /** Tells the server, which checks on Hyperliquid that the agent belongs to `master`. */
  complete(code: string, master: string): Promise<void>;
  onStep(step: Step): void;
};

/** `k7q4md`, ` K7Q-4MD ` → `K7Q-4MD`. */
export function normalizeCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

export function codeFromUrl(href: string): string {
  return normalizeCode(new URL(href).searchParams.get('code') ?? '');
}

/** EIP-1193 "user rejected" (4001) or a wallet message saying so. */
function rejected(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  return (
    e?.code === 4001 ||
    e?.cause?.code === 4001 ||
    /user (rejected|denied)/i.test(String(e?.message ?? ''))
  );
}

export async function pair(rawCode: string, deps: FlowDeps): Promise<{ master: string }> {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error('Type the code shown on the glasses');
  deps.onStep('info');
  const { agentAddress, agentName } = await deps.getInfo(code);
  deps.onStep('connect');
  const master = await deps.connect();
  deps.onStep('approve');
  try {
    await deps.approve(agentAddress, agentName);
  } catch (err) {
    if (rejected(err)) throw new Error('Approval cancelled in the wallet — nothing changed');
    throw err;
  }
  deps.onStep('complete');
  await deps.complete(code, master);
  deps.onStep('done');
  return { master };
}
