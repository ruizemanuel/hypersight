import { AlertRuleSchema, PresetsSchema, RiskLimitsSchema } from '@hypersight/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Catalogue } from '../hl/outcomes';
import type { Repos } from '../store/repos';

export type ApiStatus = {
  mode: string;
  network: string;
  connected: boolean;
  latency: { sttMs?: number; intentMs?: number; execMs?: number };
  /** Null without a bot token; bot is its @username once Telegram answered. */
  telegram?: { bot: string | null } | null;
};

export type ApiDeps = {
  repos: Pick<Repos, 'settings' | 'watch' | 'rules' | 'audit' | 'telegramChats'>;
  catalogue: Pick<Catalogue, 'search' | 'byKey'>;
  status: () => ApiStatus;
  /** Settings or watchlist changed: push a fresh deck to the glasses. */
  onChange: () => void;
};

/** The executor (testnet / paper) is chosen by the server's EXECUTOR, never from the phone. */
const SettingsPatchSchema = z
  .object({
    risk: RiskLimitsSchema.partial().optional(),
    presets: PresetsSchema.partial().optional(),
  })
  .strict();
const WatchBodySchema = z.object({ key: z.string().min(1).max(64) });
const TelegramChatPatchSchema = z
  .object({ follow: z.boolean().optional(), replyFills: z.boolean().optional() })
  .strict();

const MARKETS_MAX = 10;
const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;

async function jsonBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** Companion (phone) API: setup only — the core flow never needs the phone. Mounted under /api. */
export function createApi(deps: ApiDeps): Hono {
  const api = new Hono();

  api.get('/settings', (c) => c.json(deps.repos.settings.get()));
  api.put('/settings', async (c) => {
    const parsed = SettingsPatchSchema.safeParse(await jsonBody(c.req));
    if (!parsed.success) return c.json({ error: 'Invalid settings' }, 400);
    try {
      // Undefined keys must not reach the merge as explicit `undefined`.
      const patch = JSON.parse(JSON.stringify(parsed.data)) as typeof parsed.data;
      const next = deps.repos.settings.update(patch);
      deps.onChange();
      return c.json(next);
    } catch {
      return c.json({ error: 'Invalid settings' }, 400);
    }
  });

  api.get('/markets', (c) => {
    const q = (c.req.query('q') ?? '').slice(0, 80);
    return c.json(
      deps.catalogue.search(q, MARKETS_MAX).map((m) => ({
        key: m.key,
        title: m.title,
        short: m.short,
        expiresAt: m.expiresAt ?? null,
      })),
    );
  });

  api.get('/watch', (c) => c.json(deps.repos.watch.list()));
  api.post('/watch', async (c) => {
    const parsed = WatchBodySchema.safeParse(await jsonBody(c.req));
    if (!parsed.success) return c.json({ error: 'Invalid market key' }, 400);
    if (!deps.catalogue.byKey(parsed.data.key)) return c.json({ error: 'Unknown market' }, 404);
    deps.repos.watch.add(parsed.data.key);
    deps.onChange();
    return c.json(deps.repos.watch.list());
  });
  api.delete('/watch/:key', (c) => {
    deps.repos.watch.remove(c.req.param('key'));
    deps.onChange();
    return c.json(deps.repos.watch.list());
  });

  api.get('/rules', (c) => c.json(deps.repos.rules.list()));
  api.put('/rules/:id', async (c) => {
    const parsed = AlertRuleSchema.safeParse(await jsonBody(c.req));
    if (!parsed.success || parsed.data.id !== c.req.param('id')) {
      return c.json({ error: 'Invalid rule' }, 400);
    }
    deps.repos.rules.upsert(parsed.data);
    return c.json(parsed.data);
  });
  api.delete('/rules/:id', (c) => {
    deps.repos.rules.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/history', (c) => {
    const n = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), HISTORY_MAX) : HISTORY_DEFAULT;
    return c.json(deps.repos.audit.list(limit));
  });

  api.get('/telegram/chats', (c) => c.json(deps.repos.telegramChats.list()));
  api.put('/telegram/chats/:id', async (c) => {
    const raw = c.req.param('id');
    const id = /^-?\d{1,16}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(id) || !deps.repos.telegramChats.get(id)) {
      return c.json({ error: 'Unknown chat' }, 404);
    }
    const parsed = TelegramChatPatchSchema.safeParse(await jsonBody(c.req));
    if (!parsed.success) return c.json({ error: 'Invalid chat settings' }, 400);
    const { follow, replyFills } = parsed.data;
    return c.json(
      deps.repos.telegramChats.set(id, {
        ...(follow !== undefined ? { follow } : {}),
        ...(replyFills !== undefined ? { replyFills } : {}),
      }),
    );
  });

  api.get('/status', (c) => c.json(deps.status()));

  return api;
}
