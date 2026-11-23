import type Anthropic from '@anthropic-ai/sdk';
import type { Intent } from '@hypersight/protocol';
import { type IntentContext, parseIntentFast } from './grammar';
import { parseIntentLLM } from './llm';

export type ResolveDeps = {
  /** null when no Anthropic key is configured: only the fast grammar runs. */
  client: Anthropic | null;
  model: string;
  log?: (msg: string, err?: unknown) => void;
};

export type Resolution = { intent: Intent; source: 'fast' | 'llm' | 'none'; ms: number };

/** Fast grammar first (instant); Claude only when the grammar is unsure (≈ 2–3 s). */
export async function resolveIntent(
  text: string,
  ctx: IntentContext,
  deps: ResolveDeps,
): Promise<Resolution> {
  const t0 = performance.now();
  const fast = parseIntentFast(text, ctx);
  if (fast) return { intent: fast, source: 'fast', ms: performance.now() - t0 };
  if (!deps.client) {
    return {
      intent: { kind: 'unknown', reason: 'Not understood — try "close half my eth"' },
      source: 'none',
      ms: performance.now() - t0,
    };
  }
  const intent = await parseIntentLLM(text, ctx, {
    client: deps.client,
    model: deps.model,
    ...(deps.log ? { log: deps.log } : {}),
  });
  return { intent, source: 'llm', ms: performance.now() - t0 };
}
