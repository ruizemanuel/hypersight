#!/usr/bin/env node
// Simulator end-to-end smoke test: `pnpm e2e`.
// Boots the server (EXECUTOR=fake, captured market data via HL_FIXTURES=1, nothing reaches
// Hyperliquid), the HUD dev server and the Even Hub simulator, then drives one tap flow:
// deck → actions → confirm → result, saving docs/media/01-deck.png … 04-result.png.
// Fails (exit 1) when a glasses screenshot has an empty header, a step did not change the screen,
// or the simulator console logged an error. Needs `evenhub-simulator` on PATH; .env is not used.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodePng, litPixels } from './png.mjs';
import { consoleLog, input, SIM_URL, shot } from './sim.mjs';

const SERVER = 'http://localhost:8787';
const HUD = 'http://localhost:5173';
const PORTS = [8787, 5173, 9898];
const MEDIA = 'docs/media';
const HEADER_ROWS = 36;
const MIN_LIT = 50;

const token = `e2e-${randomBytes(16).toString('hex')}`;
const env = {
  ...process.env,
  EXECUTOR: 'fake',
  HL_FIXTURES: '1',
  HL_ACCOUNT_ADDRESS: `0x${'1'.repeat(40)}`,
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  SESSION_TOKEN: token,
  DB_PATH: ':memory:',
  PORT: '8787',
  PAIRING: '',
  VITE_SERVER_WS: '',
  VITE_SESSION_TOKEN: '',
};

const children = [];
const log = (msg) => console.log(`[e2e] ${msg}`);

function start(name, command) {
  const child = spawn(command, { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const keep = (d) => {
    lines.push(...String(d).split(/\r?\n/).filter(Boolean));
    lines.splice(0, Math.max(0, lines.length - 40));
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  children.push({ name, child, lines });
  return child;
}

function stopAll() {
  for (const { child } of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

async function waitFor(what, check, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const auth = { headers: { Authorization: `Bearer ${token}` } };

async function step(file, action, settleMs) {
  if (action) await input(action);
  await sleep(settleMs);
  const bytes = await shot(`${MEDIA}/${file}`);
  const lit = litPixels(decodePng(bytes), 0, HEADER_ROWS);
  if (lit < MIN_LIT) throw new Error(`${file}: header region is blank (${lit} lit pixels)`);
  log(`${file} ok (${lit} lit header pixels)`);
  return bytes;
}

async function main() {
  for (const port of PORTS) {
    if (!(await portFree(port)))
      throw new Error(`port ${port} is in use: stop the dev servers first`);
  }
  log('starting server (fake executor, fixture market data), HUD and simulator…');
  start('server', 'pnpm --filter @hypersight/server exec tsx src/index.ts');
  start('hud', 'pnpm --filter @hypersight/hud dev');
  await waitFor('the server API', async () => (await fetch(`${SERVER}/api/ping`, auth)).ok);
  await waitFor('the HUD dev server', async () => (await fetch(HUD)).ok);
  start('simulator', `evenhub-simulator --automation-port 9898 ${HUD}`);
  await waitFor('the simulator', async () => (await fetch(`${SIM_URL}/api/console`)).ok, 90_000);
  await waitFor('the glasses to connect', async () => {
    const status = await (await fetch(`${SERVER}/api/status`, auth)).json();
    return status.connected === true;
  });
  await waitFor('the deck on the glasses', async () => {
    const lit = litPixels(decodePng(await shot(`${MEDIA}/00-boot.png`)), 0, HEADER_ROWS);
    return lit >= MIN_LIT;
  });
  await sleep(1500);

  const deck = await step('01-deck.png', 'down', 1200);
  const actions = await step('02-actions.png', 'click', 1200);
  const confirm = await step('03-confirm.png', 'click', 2500);
  const result = await step('04-result.png', 'click', 2500);
  const same = (a, b) => Buffer.compare(a, b) === 0;
  if (same(deck, actions)) throw new Error('the actions list did not open');
  if (same(actions, confirm)) throw new Error('no confirm card appeared');
  if (same(confirm, result)) throw new Error('confirming did not show a result');

  const entries = (await consoleLog()).entries ?? [];
  const errors = entries.filter((e) => e.level === 'error');
  if (errors.length > 0) {
    throw new Error(`simulator console errors:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);
  }
  log(`passed · ${entries.length} console entries, no errors · screenshots in ${MEDIA}/`);
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 1;
  console.error(`[e2e] FAILED: ${err instanceof Error ? err.message : err}`);
  for (const { name, lines } of children) {
    if (lines.length) console.error(`--- ${name} (last lines) ---\n${lines.join('\n')}`);
  }
} finally {
  stopAll();
  // The boot frame is only a readiness probe.
  await readFile(`${MEDIA}/00-boot.png`)
    .then(() => import('node:fs/promises').then((fs) => fs.rm(`${MEDIA}/00-boot.png`)))
    .catch(() => {});
}
process.exit(code);
