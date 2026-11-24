import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PairingCodes } from '../../src/pairing/codes';
import { open } from '../../src/pairing/crypto';
import { createLinkApi, type LinkApiDeps } from '../../src/pairing/link-api';
import { openDb } from '../../src/store/db';
import { createRepos, type DeviceRecord } from '../../src/store/repos';

const KEY = 'cd'.repeat(32);
const T0 = Date.UTC(2026, 10, 24, 12, 0);
const MASTER = '0xAbCd000000000000000000000000000000000001';
const OTHER = '0x9999999999999999999999999999999999999999';
const DAY = 86_400_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(over: Partial<LinkApiDeps> = {}, dbPath = ':memory:') {
  const db = openDb(dbPath);
  const repos = createRepos(db);
  const paired: DeviceRecord[] = [];
  let roleOf: (agent: string) => { role: string; data?: { user?: string } } = () => ({
    role: 'agent',
    data: { user: MASTER.toLowerCase() },
  });
  const api = createLinkApi({
    codes: new PairingCodes(KEY),
    devices: repos.devices,
    userRole: async (agent) => roleOf(agent),
    onPaired: (d) => paired.push(d),
    now: () => T0,
    ...over,
  });
  const post = (path: string, body?: unknown) =>
    api.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const start = async () =>
    (await (await post('/start')).json()) as {
      code: string;
      deviceToken: string;
    };
  return {
    api,
    db,
    repos,
    paired,
    post,
    start,
    setRole: (f: typeof roleOf) => {
      roleOf = f;
    },
  };
}

describe('link API — start and info', () => {
  it('starts a pairing for the glasses and tells the link page which agent to approve', async () => {
    const s = setup();
    const { code, deviceToken } = await s.start();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    expect(deviceToken.length).toBeGreaterThanOrEqual(32);
    const info = await s.api.request(`/info/${code}`);
    expect(info.status).toBe(200);
    const body = (await info.json()) as { agentAddress: string; agentName: string };
    expect(body.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Named agent with a 30-day expiry: Hyperliquid parses "valid_until <ms>".
    expect(body.agentName).toBe(`hypersight valid_until ${T0 + 30 * DAY}`);
    expect((await s.api.request('/info/ZZZ-ZZZ')).status).toBe(404);
  });

  it('limits pairing starts to 5 a minute per client', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await s.post('/start')).status).toBe(200);
    expect((await s.post('/start')).status).toBe(429);
  });

  it('tells clients apart by the proxy header behind a proxy, and ignores it otherwise', async () => {
    const from = (ip: string) => ({ method: 'POST', headers: { 'Fly-Client-IP': ip } });
    const proxied = setup({ clientIpHeader: 'fly-client-ip' });
    for (let i = 0; i < 5; i++)
      expect((await proxied.api.request('/start', from('1.1.1.1'))).status).toBe(200);
    expect((await proxied.api.request('/start', from('1.1.1.1'))).status).toBe(429);
    expect((await proxied.api.request('/start', from('2.2.2.2'))).status).toBe(200);
    // Without a proxy the header is the client's own claim: it cannot buy more attempts.
    const direct = setup();
    for (let i = 0; i < 5; i++)
      expect((await direct.api.request('/start', from(`9.9.9.${i}`))).status).toBe(200);
    expect((await direct.api.request('/start', from('9.9.9.9'))).status).toBe(429);
  });

  it('limits status polls to 60 a minute per client (the glasses poll 30)', async () => {
    const s = setup();
    const { code } = await s.start();
    for (let i = 0; i < 60; i++) expect((await s.api.request(`/status/${code}`)).status).toBe(200);
    expect((await s.api.request(`/status/${code}`)).status).toBe(429);
  });
});

describe('link API — complete', () => {
  it('refuses to pair when Hyperliquid says the agent belongs to another account', async () => {
    const s = setup();
    s.setRole(() => ({ role: 'agent', data: { user: OTHER } }));
    const { code, deviceToken } = await s.start();
    const res = await s.post('/complete', { code, master: MASTER });
    expect(res.status).toBe(403);
    expect(s.repos.devices.has(sha256(deviceToken))).toBe(false);
    expect(s.paired).toHaveLength(0);
  });

  it('refuses to pair before the agent is approved', async () => {
    const s = setup();
    s.setRole(() => ({ role: 'missing' }));
    const { code } = await s.start();
    const res = await s.post('/complete', { code, master: MASTER });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not approved/i);
  });

  it('pairs when the agent belongs to the master, and the glasses see it', async () => {
    const s = setup();
    const { code, deviceToken } = await s.start();
    expect(await (await s.api.request(`/status/${code}`)).json()).toEqual({ paired: false });
    const res = await s.post('/complete', { code, master: MASTER });
    expect(res.status).toBe(200);
    expect(s.repos.devices.has(sha256(deviceToken))).toBe(true);
    expect(s.paired).toHaveLength(1);
    expect(s.paired[0]?.master).toBe(MASTER.toLowerCase());
    expect(await (await s.api.request(`/status/${code}`)).json()).toEqual({ paired: true });
    // Single use.
    expect((await s.post('/complete', { code, master: MASTER })).status).toBe(409);
  });

  it('never writes the raw agent key to the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-link-'));
    dirs.push(dir);
    const s = setup({}, join(dir, 'hs.sqlite'));
    const { code } = await s.start();
    expect((await s.post('/complete', { code, master: MASTER })).status).toBe(200);
    const sealed = s.paired[0]?.agentKeySealed ?? '';
    const raw = open(sealed, KEY).slice(2);
    s.db.close(); // checkpoints the WAL into the file (and frees it on Windows)
    const bytes = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f)).toString('latin1'))
      .join('');
    expect(bytes).toContain(sealed.slice(0, 24));
    expect(bytes.toLowerCase()).not.toContain(raw.toLowerCase());
  });

  it('keeps the server on one account: a second account cannot pair', async () => {
    const s = setup();
    const first = await s.start();
    expect((await s.post('/complete', { code: first.code, master: MASTER })).status).toBe(200);
    s.setRole(() => ({ role: 'agent', data: { user: OTHER } }));
    const second = await s.start();
    expect((await s.post('/complete', { code: second.code, master: OTHER })).status).toBe(403);
  });

  it('keeps one account when two accounts complete at the same time', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const owners = new Map<string, string>();
    const s = setup({
      userRole: async (agent) => {
        await gate;
        return { role: 'agent', data: { user: owners.get(agent) ?? '' } };
      },
    });
    const a = await s.start();
    const b = await s.start();
    const agentOf = async (code: string) =>
      ((await (await s.api.request(`/info/${code}`)).json()) as { agentAddress: string })
        .agentAddress;
    owners.set(await agentOf(a.code), MASTER.toLowerCase());
    owners.set(await agentOf(b.code), OTHER.toLowerCase());
    const both = Promise.all([
      s.post('/complete', { code: a.code, master: MASTER }),
      s.post('/complete', { code: b.code, master: OTHER }),
    ]);
    release();
    const statuses = (await both).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);
    expect(new Set(s.repos.devices.all().map((d) => d.master)).size).toBe(1);
  });

  it('only lets the configured master pair when one is pinned', async () => {
    const s = setup({ pinnedMaster: OTHER });
    const { code } = await s.start();
    expect((await s.post('/complete', { code, master: MASTER })).status).toBe(403);
  });

  it('rejects a malformed request and an unknown code', async () => {
    const s = setup();
    expect((await s.post('/complete', { code: 'ABC-DEF', master: 'nope' })).status).toBe(400);
    expect((await s.post('/complete', { code: 'ABC-DEF', master: MASTER })).status).toBe(404);
  });
});
