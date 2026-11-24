import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { IntentContext } from '../../src/intent/grammar';
import { parseIntentLLM } from '../../src/intent/llm';
import { resolveIntent } from '../../src/intent/resolve';

const ctx: IntentContext = {
  perpCoins: ['BTC', 'ETH', 'SOL', 'HYPE'],
  positions: [{ coin: 'ETH' }],
  outcomePositions: [{ marketKey: 'o:24274', sideIndex: 0 }],
  markets: [
    { key: 'rb:BTC:1d', short: 'BTC > 61,509 · daily', sides: ['Yes', 'No'], aliases: ['btc'] },
    {
      key: 'o:24274',
      short: 'Hawks v Mavericks',
      sides: ['Hawks', 'Mavericks'],
      aliases: ['hawks'],
    },
  ],
};

type ParseFn = (params: Record<string, unknown>) => Promise<unknown>;

function stubClient(parse: ParseFn) {
  const spy = vi.fn(parse);
  const client = { beta: { messages: { parse: spy } } } as unknown as Anthropic;
  return { client, spy };
}

const ok = (intent: unknown) => async () => ({
  stop_reason: 'end_turn',
  parsed_output: { intent },
});

describe('parseIntentLLM', () => {
  it('asks Claude at low effort for a structured intent, with the context and server-side fallbacks', async () => {
    const { client, spy } = stubClient(ok({ kind: 'closePerp', coin: 'ETH', fraction: 0.5 }));
    const intent = await parseIntentLLM('take profit on half of my ether', ctx, {
      client,
      model: 'claude-opus-5-5',
    });
    expect(intent).toEqual({ kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
    const params = spy.mock.calls[0]?.[0] as Record<string, unknown> & {
      output_config: { effort: string; format: unknown };
      system: string;
      messages: { role: string; content: string }[];
    };
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.output_config.effort).toBe('low');
    expect(params.output_config.format).toBeDefined();
    expect(params.betas).toContain('server-side-fallback-2026-07-01');
    expect(params.fallbacks).toBe('default');
    expect(params.system).toContain('rb:BTC:1d');
    expect(params.system).toContain('o:24274');
    expect(params.messages).toEqual([{ role: 'user', content: 'take profit on half of my ether' }]);
  });

  // Phase 3 review I3: the SDK default (10 min, 2 retries) would trap the glasses on Thinking.
  it('bounds the call: 8 s per attempt, one retry, 12 s overall', async () => {
    const { client, spy } = stubClient(ok({ kind: 'cancelAll' }));
    await parseIntentLLM('x', ctx, { client, model: 'm' });
    const options = (spy.mock.calls[0] as unknown[])[1] as {
      timeout: number;
      maxRetries: number;
      signal: AbortSignal;
    };
    expect(options.timeout).toBe(8_000);
    expect(options.maxRetries).toBe(1);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns unknown on a refusal', async () => {
    const { client } = stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null }));
    expect((await parseIntentLLM('x', ctx, { client, model: 'm' })).kind).toBe('unknown');
  });

  it('returns unknown when the SDK throws', async () => {
    const { client } = stubClient(async () => {
      throw new Error('network down');
    });
    expect((await parseIntentLLM('x', ctx, { client, model: 'm' })).kind).toBe('unknown');
  });

  it('re-validates the output and rejects out-of-range values', async () => {
    const { client } = stubClient(ok({ kind: 'closePerp', coin: 'ETH', fraction: 2 }));
    expect((await parseIntentLLM('x', ctx, { client, model: 'm' })).kind).toBe('unknown');
  });

  it('rejects a market key that is not in the context', async () => {
    const { client } = stubClient(
      ok({ kind: 'buyOutcome', marketKey: 'o:999', sideIndex: 0, usd: 5 }),
    );
    const intent = await parseIntentLLM('buy the other thing', ctx, { client, model: 'm' });
    expect(intent.kind).toBe('unknown');
  });
});

describe('resolveIntent', () => {
  it('uses the fast grammar without calling Claude', async () => {
    const { client, spy } = stubClient(ok({ kind: 'cancelAll' }));
    const r = await resolveIntent('close half my eth', ctx, { client, model: 'claude-opus-5-5' });
    expect(r).toMatchObject({
      source: 'fast',
      intent: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to Claude once when the grammar is unsure', async () => {
    const { client, spy } = stubClient(
      ok({ kind: 'unknown', reason: 'no position in the Fed market' }),
    );
    const r = await resolveIntent('get me out of the fed thing', ctx, {
      client,
      model: 'claude-opus-5-5',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.source).toBe('llm');
    expect(r.intent.kind).toBe('unknown');
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('answers unknown without an LLM when no API key is configured', async () => {
    const r = await resolveIntent('get me out of the fed thing', ctx, { client: null, model: 'm' });
    expect(r).toMatchObject({ source: 'none', intent: { kind: 'unknown' } });
  });
});

describe.runIf(process.env.RUN_LIVE_LLM === '1')('parseIntentLLM (live)', () => {
  it('understands a paraphrase', async () => {
    const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
    const intent = await parseIntentLLM('take profit on half of my ether', ctx, {
      client: new AnthropicClient(),
      model: 'claude-opus-5-5',
    });
    expect(intent).toEqual({ kind: 'closePerp', coin: 'ETH', fraction: 0.5 });
  }, 60_000);
});
