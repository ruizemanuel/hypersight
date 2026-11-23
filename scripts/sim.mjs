#!/usr/bin/env node
// Even Hub simulator automation helpers (simulator started with --automation-port 9898).
//   node scripts/sim.mjs shot <file.png>       save the glasses screenshot
//   node scripts/sim.mjs input <action>        click | up | down | double_click | long_press | long_press_release | context_menu
//   node scripts/sim.mjs console               print the simulator console log
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SIM_URL = process.env.SIM_URL ?? 'http://127.0.0.1:9898';
export const ACTIONS = [
  'click',
  'up',
  'down',
  'double_click',
  'long_press',
  'long_press_release',
  'context_menu',
];

export async function shot(file, target = 'glasses') {
  const res = await fetch(`${SIM_URL}/api/screenshot/${target}`);
  if (!res.ok) throw new Error(`screenshot failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}

export async function input(action) {
  if (!ACTIONS.includes(action))
    throw new Error(`unknown action "${action}" (use: ${ACTIONS.join(', ')})`);
  const res = await fetch(`${SIM_URL}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`input failed: HTTP ${res.status}`);
}

export async function consoleLog() {
  const res = await fetch(`${SIM_URL}/api/console`);
  if (!res.ok) throw new Error(`console failed: HTTP ${res.status}`);
  return res.json();
}

async function main([cmd, arg]) {
  if (cmd === 'shot' && arg) {
    const bytes = await shot(arg);
    console.log(`saved ${arg} (${bytes.length} bytes)`);
  } else if (cmd === 'input' && arg) {
    await input(arg);
    console.log(`sent ${arg}`);
  } else if (cmd === 'console') {
    console.log(JSON.stringify(await consoleLog(), null, 2));
  } else {
    console.error('usage: node scripts/sim.mjs shot <file> | input <action> | console');
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
