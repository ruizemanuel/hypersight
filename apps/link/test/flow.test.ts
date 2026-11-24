import { describe, expect, it } from 'vitest';
import { codeFromUrl, type FlowDeps, pair } from '../src/flow';

const AGENT = '0x2222222222222222222222222222222222222222';
const MASTER = '0x1111111111111111111111111111111111111111';

function fakes(over: Partial<FlowDeps> = {}) {
  const calls: string[] = [];
  const deps: FlowDeps = {
    getInfo: async (code) => {
      calls.push(`info ${code}`);
      return { agentAddress: AGENT, agentName: 'hypersight valid_until 1800000000000' };
    },
    connect: async () => {
      calls.push('connect');
      return MASTER;
    },
    approve: async (agent, name) => {
      calls.push(`approve ${agent} ${name}`);
    },
    complete: async (code, master) => {
      calls.push(`complete ${code} ${master}`);
    },
    onStep: (step) => calls.push(`step ${step}`),
    ...over,
  };
  return { deps, calls };
}

describe('pair', () => {
  it('looks up the code, connects, approves the agent, then completes with the wallet as master', async () => {
    const { deps, calls } = fakes();
    expect(await pair(' k7q-4md ', deps)).toEqual({ master: MASTER });
    expect(calls).toEqual([
      'step info',
      'info K7Q-4MD',
      'step connect',
      'connect',
      'step approve',
      `approve ${AGENT} hypersight valid_until 1800000000000`,
      'step complete',
      `complete K7Q-4MD ${MASTER}`,
      'step done',
    ]);
  });

  it('stops before completing when the approval is rejected in the wallet', async () => {
    const { deps, calls } = fakes({
      approve: async () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      },
    });
    await expect(pair('K7Q-4MD', deps)).rejects.toThrow(
      'Approval cancelled in the wallet — nothing changed',
    );
    expect(calls.some((c) => c.startsWith('complete'))).toBe(false);
  });

  it('passes the reason through when the server refuses to complete', async () => {
    const { deps } = fakes({
      complete: async () => {
        throw new Error('This server is paired with another account');
      },
    });
    await expect(pair('K7Q-4MD', deps)).rejects.toThrow(
      'This server is paired with another account',
    );
  });

  it('asks for a code before touching the wallet', async () => {
    const { deps, calls } = fakes();
    await expect(pair('  ', deps)).rejects.toThrow('Type the code shown on the glasses');
    expect(calls).toEqual([]);
  });
});

describe('codeFromUrl', () => {
  it('reads ?code= from the address', () => {
    expect(codeFromUrl('http://192.168.1.5:8787/link?code=k7q-4md')).toBe('K7Q-4MD');
    expect(codeFromUrl('http://192.168.1.5:8787/link')).toBe('');
  });
});
