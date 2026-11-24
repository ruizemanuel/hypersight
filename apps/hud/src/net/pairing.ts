/** Device-code pairing from the glasses side: get a code, show it, wait for the wallet. */

type Fetch = typeof globalThis.fetch;
type Sleep = (ms: number) => Promise<void>;

const HEALTH_TRIES = 3;
const RETRY_MS = 2000;
const POLL_MS = 2000;
/** The server allows 5 pairing starts a minute. */
const LIMITED_MS = 15_000;

export type PairingDeps = {
  /** Server HTTP origin, e.g. `http://192.168.1.5:8787`. */
  base: string;
  fetch: Fetch;
  sleep: Sleep;
  /** A new code to show on the glasses (again after the previous one expired). */
  onCode: (code: string) => void;
};

/** Whether the server pairs devices (it then has no agent key of its own). */
export async function serverPairs(base: string, fetch: Fetch, sleep: Sleep): Promise<boolean> {
  for (let i = 0; i < HEALTH_TRIES; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return ((await res.json()) as { pairing?: unknown }).pairing === true;
    } catch {
      // still starting, or the network blinked
    }
    if (i < HEALTH_TRIES - 1) await sleep(RETRY_MS);
  }
  return false;
}

/** `http://192.168.1.5:8787` → `192.168.1.5:8787/link` (typed on a computer, scheme implied). */
export function linkUrlFor(base: string): string {
  return `${new URL(base).host}/link`;
}

/**
 * Starts a pairing, shows its code and polls until the user approved the agent on the link page.
 * An expired code starts over with a fresh one. Resolves with the device token to store.
 */
export async function pairDevice(deps: PairingDeps): Promise<string> {
  for (;;) {
    let started: { code: string; deviceToken: string } | null = null;
    try {
      const res = await deps.fetch(`${deps.base}/link/start`, { method: 'POST' });
      if (res.ok) started = (await res.json()) as { code: string; deviceToken: string };
      else if (res.status === 429) await deps.sleep(LIMITED_MS);
      else await deps.sleep(RETRY_MS);
    } catch {
      await deps.sleep(RETRY_MS);
    }
    if (!started) continue;
    deps.onCode(started.code);
    for (;;) {
      await deps.sleep(POLL_MS);
      let res: Awaited<ReturnType<Fetch>>;
      try {
        res = await deps.fetch(`${deps.base}/link/status/${encodeURIComponent(started.code)}`);
      } catch {
        continue;
      }
      if (res.status === 404) break; // expired: start over with a new code
      if (!res.ok) continue;
      const body = (await res.json()) as { paired?: unknown };
      if (body.paired === true) return started.deviceToken;
    }
  }
}
