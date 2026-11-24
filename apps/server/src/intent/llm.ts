import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { type Intent, IntentSchema } from '@hypersight/protocol';
import { z } from 'zod';
import { heardFractions, heardNumbers, type IntentContext } from './grammar';

export type LlmDeps = {
  client: Anthropic;
  model: string;
  log?: (msg: string, err?: unknown) => void;
};

const ATTEMPT_TIMEOUT_MS = 8_000;
/** Below the HUD's 15 s Thinking limit, so a late answer never lands after "No answer". */
const TOTAL_TIMEOUT_MS = 12_000;

/** The intent sits under a root object: structured outputs are most reliable with an object root. */
const LlmOutputSchema = z.object({ intent: IntentSchema });

const RULES = `You turn one short spoken trading command from a smart-glasses user into exactly one intent.
The app trades on Hyperliquid TESTNET only, and every intent you return is shown to the user on a confirm card before anything happens.

Rules:
- Output exactly one intent.
- Use only the coins and market keys listed below. Never invent a market key or a coin.
- Never invent amounts: if the user did not say how much, return "unknown" with a short reason.
- "half" = fraction 0.5, "a quarter" = 0.25, "all" / "everything" / no amount on a close or sell = 1.
- Closing a perp position is closePerp; opening one is openPerp (long or short, USD amount, optional leverage).
- Buying a side of a prediction market is buyOutcome (sideIndex 0 = first side, 1 = second side, USD amount); selling held shares is sellOutcome.
- If the command is ambiguous, refers to something not listed, or is not a trading command, return {"kind":"unknown","reason":"<under 12 words>"}.
- Questions about profit, prices, odds or balance are "query" intents.`;

function contextBlock(ctx: IntentContext): string {
  const perps = ctx.positions.map((p) => p.coin).join(', ') || 'none';
  const held =
    ctx.outcomePositions.map((p) => `${p.marketKey} side ${p.sideIndex}`).join(', ') || 'none';
  const markets = ctx.markets
    .map((m) => `- ${m.key}: "${m.short}" (side 0 = ${m.sides[0]}, side 1 = ${m.sides[1]})`)
    .join('\n');
  return [
    `Tradable perp coins: ${ctx.perpCoins.join(', ')}`,
    `Open perp positions: ${perps}`,
    `Held prediction-market positions: ${held}`,
    `Prediction markets (key: name):\n${markets || '- none'}`,
  ].join('\n');
}

function unknown(reason: string): Intent {
  return { kind: 'unknown', reason };
}

/** Rejects coins and market keys the user cannot act on (the model must not invent them). */
function withinContext(intent: Intent, ctx: IntentContext): boolean {
  const keys = new Set(ctx.markets.map((m) => m.key));
  const coins = new Set(ctx.perpCoins);
  if ('marketKey' in intent && intent.marketKey !== undefined && !keys.has(intent.marketKey)) {
    return false;
  }
  if ('coin' in intent && intent.coin !== undefined && !coins.has(intent.coin)) return false;
  return true;
}

/**
 * "Never invent amounts", enforced: every USD amount, leverage and stop price must be a number the
 * user said, and a partial close/sell must match a fraction or percent they said.
 */
function amountsHeard(intent: Intent, text: string): boolean {
  const numbers = heardNumbers(text);
  const heard = (n: number) => numbers.some((h) => Math.abs(h - n) < 1e-9);
  switch (intent.kind) {
    case 'openPerp':
      return heard(intent.usd) && (intent.leverage === undefined || heard(intent.leverage));
    case 'buyOutcome':
      return heard(intent.usd);
    case 'setStop':
      return heard(intent.triggerPx);
    case 'closePerp':
    case 'sellOutcome':
      return (
        intent.fraction >= 1 ||
        heardFractions(text).some((f) => Math.abs(f - intent.fraction) < 0.005)
      );
    default:
      return true;
  }
}

/**
 * Claude fallback for phrasings the fast grammar does not cover. It only returns an Intent and
 * never executes anything; any failure becomes `unknown` so the HUD can say so.
 */
export async function parseIntentLLM(
  text: string,
  ctx: IntentContext,
  deps: LlmDeps,
): Promise<Intent> {
  try {
    const response = await deps.client.beta.messages.parse(
      {
        model: deps.model,
        max_tokens: 4096,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(LlmOutputSchema) },
        system: `${RULES}\n\n${contextBlock(ctx)}`,
        messages: [{ role: 'user', content: text }],
      },
      // Someone is waiting on the glasses: never the SDK default of 10 min × 3 attempts.
      {
        timeout: ATTEMPT_TIMEOUT_MS,
        maxRetries: 1,
        signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
      },
    );
    if (response.stop_reason === 'refusal') return unknown('Request declined');
    const parsed = IntentSchema.safeParse(
      (response.parsed_output as { intent?: unknown } | null)?.intent,
    );
    if (!parsed.success) return unknown('Not understood');
    if (!withinContext(parsed.data, ctx)) return unknown('Unknown market or coin');
    if (!amountsHeard(parsed.data, text)) return unknown('No amount heard');
    return parsed.data;
  } catch (err) {
    deps.log?.('[intent] LLM call failed', err);
    return unknown('Assistant unavailable');
  }
}
