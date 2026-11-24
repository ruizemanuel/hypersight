import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { DeviceRecord, Repos } from '../store/repos';
import { type PairingCodes, PairingError } from './codes';

/** Hyperliquid `userRole` answer; only `{ role: "agent", data: { user } }` matters here. */
export type UserRole = { role: string; data?: object };

export type LinkApiDeps = {
  codes: PairingCodes;
  devices: Pick<Repos['devices'], 'put' | 'all'>;
  /** Hyperliquid `userRole` for the agent address (who approved it, if anyone). */
  userRole: (agentAddress: string) => Promise<UserRole>;
  /** When set (HL_ACCOUNT_ADDRESS in pairing mode), only this master can pair. */
  pinnedMaster?: string;
  /** A device was paired: start trading with its agent and let the glasses in. */
  onPaired: (device: DeviceRecord) => void;
  log?: (msg: string, err?: unknown) => void;
  now?: () => number;
};

/** Agent expiry: Hyperliquid reads `valid_until <ms>` from the agent name (≤ 180 days). */
const AGENT_DAYS = 30;
const AGENT_NAME = 'hypersight';
const MINUTE = 60_000;

const CompleteSchema = z.object({
  code: z.string().min(1).max(16),
  master: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

/** Sliding one-minute window per client. */
function limiter(max: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now: number): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < MINUTE);
    const ok = recent.length < max;
    if (ok) recent.push(now);
    hits.set(key, recent);
    return ok;
  };
}

function clientOf(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Pairing routes, mounted at `/link`. The glasses start a pairing (code + device token); the link
 * page shows which agent to approve, the user's wallet signs `approveAgent` with Hyperliquid
 * directly, and `complete` checks on Hyperliquid that the agent now belongs to that master.
 */
export function createLinkApi(deps: LinkApiDeps): Hono {
  const now = deps.now ?? Date.now;
  const startLimit = limiter(5);
  const lookupLimit = limiter(30);
  const completeLimit = limiter(10);
  const api = new Hono();
  const tooMany = (c: Context) => c.json({ error: 'Too many requests — wait a minute' }, 429);

  api.post('/start', (c) => {
    const t = now();
    if (!startLimit(clientOf(c), t)) return tooMany(c);
    deps.codes.expireOlderThan(t);
    const { code, deviceToken } = deps.codes.create(t);
    return c.json({ code, deviceToken });
  });

  api.get('/info/:code', (c) => {
    const t = now();
    if (!lookupLimit(clientOf(c), t)) return tooMany(c);
    const pending = deps.codes.get(c.req.param('code'), t);
    if (!pending) return c.json({ error: 'Unknown or expired code' }, 404);
    return c.json({
      agentAddress: pending.agentAddress,
      agentName: `${AGENT_NAME} valid_until ${t + AGENT_DAYS * 86_400_000}`,
    });
  });

  api.get('/status/:code', (c) => {
    const status = deps.codes.status(c.req.param('code'), now());
    if (!status) return c.json({ error: 'Unknown or expired code' }, 404);
    return c.json({ paired: status === 'paired' });
  });

  api.post('/complete', async (c) => {
    const t = now();
    if (!completeLimit(clientOf(c), t)) return tooMany(c);
    const parsed = CompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Send a code and a 0x wallet address' }, 400);
    const { code } = parsed.data;
    const master = parsed.data.master.toLowerCase();
    if (deps.codes.status(code, t) === 'paired') {
      return c.json({ error: 'This code was already used' }, 409);
    }
    const pending = deps.codes.get(code, t);
    if (!pending) return c.json({ error: 'Unknown or expired code' }, 404);
    // One account per server: the pinned master, else the one the first device paired with.
    const lockedTo = deps.pinnedMaster?.toLowerCase() ?? deps.devices.all()[0]?.master;
    if (lockedTo && lockedTo !== master) {
      return c.json({ error: 'This server is paired with another account' }, 403);
    }
    let role: UserRole;
    try {
      role = await deps.userRole(pending.agentAddress);
    } catch (err) {
      deps.log?.('[link] userRole failed', err);
      return c.json({ error: 'Could not reach Hyperliquid — try again' }, 502);
    }
    if (role.role !== 'agent') {
      return c.json({ error: 'Agent not approved yet — approve it in your wallet first' }, 403);
    }
    const owner = role.data && 'user' in role.data ? String(role.data.user).toLowerCase() : '';
    if (owner !== master) {
      return c.json({ error: 'That agent was approved by another account' }, 403);
    }
    let device: DeviceRecord;
    try {
      device = deps.codes.complete(code, master, t);
    } catch (err) {
      if (err instanceof PairingError) return c.json({ error: err.message }, 409);
      throw err;
    }
    deps.devices.put(device);
    try {
      deps.onPaired(device);
    } catch (err) {
      deps.log?.('[link] onPaired failed', err);
    }
    return c.json({ ok: true });
  });

  return api;
}
