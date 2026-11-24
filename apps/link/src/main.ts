import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { createWalletClient, custom, type EIP1193Provider } from 'viem';
import { codeFromUrl, type FlowDeps, pair, type Step } from './flow';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const STEP_TEXT: Record<Step, string> = {
  info: 'Checking the code…',
  connect: 'Connect your wallet…',
  approve: 'Approve the HyperSight agent in your wallet…',
  complete: 'Checking the approval on Hyperliquid…',
  done: 'Paired. Look at your glasses.',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function serverError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `Server error ${res.status}`);
}

/** A wallet client bound to the connected account (signs Hyperliquid typed data). */
const walletFor = (provider: EIP1193Provider, address: `0x${string}`) =>
  createWalletClient({ account: address, transport: custom(provider) });

function deps(onStep: (s: Step) => void): FlowDeps {
  let wallet: ReturnType<typeof walletFor> | null = null;
  return {
    async getInfo(code) {
      const res = await fetch(`/link/info/${encodeURIComponent(code)}`);
      if (res.status === 404) throw new Error('Unknown or expired code — check the glasses');
      if (!res.ok) throw await serverError(res);
      return (await res.json()) as { agentAddress: string; agentName: string };
    },
    async connect() {
      const provider = window.ethereum;
      if (!provider) throw new Error('No browser wallet found — install one (e.g. MetaMask)');
      const [address] = await createWalletClient({
        transport: custom(provider),
      }).requestAddresses();
      if (!address) throw new Error('The wallet did not share an address');
      wallet = walletFor(provider, address);
      return address;
    },
    async approve(agentAddress, agentName) {
      if (!wallet) throw new Error('Connect the wallet first');
      // Testnet only: the transport targets api.hyperliquid-testnet.xyz.
      const exchange = new ExchangeClient({
        transport: new HttpTransport({ isTestnet: true }),
        wallet,
      });
      await exchange.approveAgent({ agentAddress, agentName });
    },
    async complete(code, master) {
      const res = await fetch('/link/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, master }),
      });
      if (!res.ok) throw await serverError(res);
    },
    onStep,
  };
}

function mount(): void {
  const input = $<HTMLInputElement>('code');
  const button = $<HTMLButtonElement>('go');
  const status = $<HTMLParagraphElement>('status');
  input.value = codeFromUrl(location.href);
  const say = (text: string, kind: 'info' | 'ok' | 'error' = 'info') => {
    status.textContent = text;
    status.className = kind;
  };
  button.addEventListener('click', () => {
    button.disabled = true;
    pair(
      input.value,
      deps((s) => say(STEP_TEXT[s], s === 'done' ? 'ok' : 'info')),
    )
      .then(({ master }) =>
        say(`Paired with ${master.slice(0, 6)}…${master.slice(-4)}. Look at your glasses.`, 'ok'),
      )
      .catch((err: unknown) => {
        say(err instanceof Error ? err.message : String(err), 'error');
        button.disabled = false;
      });
  });
}

mount();
