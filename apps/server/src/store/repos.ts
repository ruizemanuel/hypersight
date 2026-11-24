import type { DatabaseSync } from 'node:sqlite';
import {
  type AlertRule,
  AlertRuleSchema,
  DEFAULT_SETTINGS,
  type Presets,
  type RiskLimits,
  type Settings,
  SettingsSchema,
} from '@hypersight/protocol';

export type SettingsPatch = {
  risk?: Partial<RiskLimits>;
  presets?: Partial<Presets>;
  mode?: Settings['mode'];
};

export type AuditEntry = {
  ts: number;
  kind: 'proposal' | 'confirm' | 'cancel' | 'result' | 'blocked';
  proposalId: string;
  summary: string;
  data: unknown;
};

/** A paired pair of glasses. The bearer token itself is never stored, only its SHA-256 hex. */
export type DeviceRecord = {
  tokenHash: string;
  master: string;
  agentAddress: string;
  agentKeySealed: string;
  createdAt: number;
};

export type PaperFill = { ts: number; coin: string; isBuy: boolean; sz: number; px: number };

const DAY_MS = 86_400_000;

/** Merges stored settings over the defaults so new fields get defaults; always returns a copy. */
function withDefaults(stored: unknown): Settings {
  const s = (stored ?? {}) as Partial<Settings>;
  const merged = {
    risk: { ...DEFAULT_SETTINGS.risk, ...(s.risk ?? {}) },
    presets: { ...DEFAULT_SETTINGS.presets, ...(s.presets ?? {}) },
    mode: s.mode ?? DEFAULT_SETTINGS.mode,
  };
  const parsed = SettingsSchema.safeParse(merged);
  return structuredClone(parsed.success ? parsed.data : DEFAULT_SETTINGS);
}

export function createRepos(db: DatabaseSync) {
  const settings = {
    get(): Settings {
      const row = db.prepare('SELECT json FROM settings WHERE id = 1').get() as
        | { json: string }
        | undefined;
      return withDefaults(row ? JSON.parse(row.json) : null);
    },
    /** Validates the merged result; throws (and stores nothing) when it is invalid. */
    update(patch: SettingsPatch): Settings {
      const current = settings.get();
      const next = SettingsSchema.parse({
        risk: { ...current.risk, ...(patch.risk ?? {}) },
        presets: { ...current.presets, ...(patch.presets ?? {}) },
        mode: patch.mode ?? current.mode,
      });
      db.prepare(
        'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      ).run(JSON.stringify(next));
      return structuredClone(next);
    },
  };

  const watch = {
    list(): string[] {
      return (
        db.prepare('SELECT key FROM watch ORDER BY position, key').all() as { key: string }[]
      ).map((r) => r.key);
    },
    add(key: string): void {
      const { next } = db
        .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM watch')
        .get() as {
        next: number;
      };
      db.prepare('INSERT OR IGNORE INTO watch (key, position) VALUES (?, ?)').run(key, next);
    },
    remove(key: string): void {
      db.prepare('DELETE FROM watch WHERE key = ?').run(key);
    },
  };

  const rules = {
    list(): AlertRule[] {
      const rows = db.prepare('SELECT json FROM rules ORDER BY id').all() as { json: string }[];
      const out: AlertRule[] = [];
      for (const r of rows) {
        const parsed = AlertRuleSchema.safeParse(JSON.parse(r.json));
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },
    upsert(rule: AlertRule): void {
      const valid = AlertRuleSchema.parse(rule);
      db.prepare(
        'INSERT INTO rules (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      ).run(valid.id, JSON.stringify(valid));
    },
    remove(id: string): void {
      db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    },
  };

  const audit = {
    append(e: AuditEntry): void {
      db.prepare(
        'INSERT INTO audit (ts, kind, proposal_id, summary, data) VALUES (?, ?, ?, ?, ?)',
      ).run(e.ts, e.kind, e.proposalId, e.summary, JSON.stringify(e.data ?? null));
    },
    list(limit = 50): AuditEntry[] {
      const rows = db
        .prepare('SELECT ts, kind, proposal_id, summary, data FROM audit ORDER BY id DESC LIMIT ?')
        .all(limit) as {
        ts: number;
        kind: AuditEntry['kind'];
        proposal_id: string;
        summary: string;
        data: string;
      }[];
      return rows.map((r) => ({
        ts: r.ts,
        kind: r.kind,
        proposalId: r.proposal_id,
        summary: r.summary,
        data: JSON.parse(r.data),
      }));
    },
  };

  const usage = {
    addNotional(usd: number, now: number): void {
      db.prepare('INSERT INTO usage (ts, usd) VALUES (?, ?)').run(now, usd);
    },
    /** Notional used since 00:00 UTC of `now`'s day (daily risk limit). */
    today(now: number): number {
      const start = Math.floor(now / DAY_MS) * DAY_MS;
      const { total } = db
        .prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM usage WHERE ts >= ? AND ts < ?')
        .get(start, start + DAY_MS) as { total: number };
      return total;
    },
  };

  type DeviceRow = {
    token: string;
    master: string;
    agent_address: string;
    agent_key_sealed: string;
    created_at: number;
  };
  const deviceOf = (r: DeviceRow): DeviceRecord => ({
    tokenHash: r.token,
    master: r.master,
    agentAddress: r.agent_address,
    agentKeySealed: r.agent_key_sealed,
    createdAt: r.created_at,
  });
  const DEVICE_COLS = 'token, master, agent_address, agent_key_sealed, created_at';
  const devices = {
    put(d: DeviceRecord): void {
      db.prepare(
        `INSERT INTO devices (token, master, agent_address, agent_key_sealed, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET master = excluded.master,
           agent_address = excluded.agent_address, agent_key_sealed = excluded.agent_key_sealed`,
      ).run(d.tokenHash, d.master, d.agentAddress, d.agentKeySealed, d.createdAt);
    },
    byToken(tokenHash: string): DeviceRecord | undefined {
      const r = db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE token = ?`).get(tokenHash) as
        | DeviceRow
        | undefined;
      return r ? deviceOf(r) : undefined;
    },
    has(tokenHash: string): boolean {
      return db.prepare('SELECT 1 FROM devices WHERE token = ?').get(tokenHash) !== undefined;
    },
    /** The most recently paired device: its agent is the one trading. */
    latest(): DeviceRecord | undefined {
      const r = db
        .prepare(`SELECT ${DEVICE_COLS} FROM devices ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get() as DeviceRow | undefined;
      return r ? deviceOf(r) : undefined;
    },
    all(): DeviceRecord[] {
      const rows = db
        .prepare(`SELECT ${DEVICE_COLS} FROM devices ORDER BY created_at, rowid`)
        .all() as DeviceRow[];
      return rows.map(deviceOf);
    },
  };

  const ledger = {
    append(f: PaperFill): void {
      db.prepare('INSERT INTO ledger (ts, coin, is_buy, sz, px) VALUES (?, ?, ?, ?, ?)').run(
        f.ts,
        f.coin,
        f.isBuy ? 1 : 0,
        f.sz,
        f.px,
      );
    },
    list(): PaperFill[] {
      const rows = db.prepare('SELECT ts, coin, is_buy, sz, px FROM ledger ORDER BY id').all() as {
        ts: number;
        coin: string;
        is_buy: number;
        sz: number;
        px: number;
      }[];
      return rows.map((r) => ({
        ts: r.ts,
        coin: r.coin,
        isBuy: r.is_buy === 1,
        sz: r.sz,
        px: r.px,
      }));
    },
  };

  return { settings, watch, rules, audit, usage, devices, ledger };
}

export type Repos = ReturnType<typeof createRepos>;
