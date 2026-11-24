import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Ordered, append-only migrations; `PRAGMA user_version` records how many have run. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
  CREATE TABLE watch (key TEXT PRIMARY KEY, position INTEGER NOT NULL);
  CREATE TABLE rules (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX audit_ts ON audit (ts);
  CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, usd REAL NOT NULL);
  CREATE INDEX usage_ts ON usage (ts);
  CREATE TABLE devices (
    token TEXT PRIMARY KEY,
    master TEXT NOT NULL,
    agent_address TEXT NOT NULL,
    agent_key_sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    coin TEXT NOT NULL,
    is_buy INTEGER NOT NULL,
    sz REAL NOT NULL,
    px REAL NOT NULL
  );
  INSERT INTO watch (key, position) VALUES ('rb:BTC:1d', 0), ('rb:ETH:1d', 1);
  `,
  // Default alert rules: resting fills, liquidation distance < 10%, settled outcomes.
  `
  INSERT INTO rules (id, json) VALUES
    ('default-fill', '{"id":"default-fill","kind":"fill","params":{},"cooldownMs":0,"enabled":true}'),
    ('default-liq', '{"id":"default-liq","kind":"liqDistance","params":{"pct":10},"cooldownMs":600000,"enabled":true}'),
    ('default-settled', '{"id":"default-settled","kind":"settled","params":{},"cooldownMs":0,"enabled":true}');
  `,
];

/** Opens (creating directories as needed) and migrates the database. `':memory:'` for tests. */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
