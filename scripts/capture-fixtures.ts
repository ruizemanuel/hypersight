// Captures read-only Hyperliquid TESTNET /info payloads used as test fixtures.
//   pnpm tsx scripts/capture-fixtures.ts
// No account data is fetched; nothing here needs credentials.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const API = 'https://api.hyperliquid-testnet.xyz/info';
const OUT = resolve(import.meta.dirname, '../fixtures/hl');

const requests: Record<string, object> = {
  meta: { type: 'meta' },
  outcomeMeta: { type: 'outcomeMeta' },
  outcomeTemplates: { type: 'outcomeTemplates' },
  allMids: { type: 'allMids' },
};

async function post(body: object): Promise<unknown> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${JSON.stringify(body)}`);
  return res.json();
}

await mkdir(OUT, { recursive: true });
for (const [name, body] of Object.entries(requests)) {
  const data = await post(body);
  const file = resolve(OUT, `${name}.json`);
  await writeFile(file, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`${name}.json  ${JSON.stringify(data).length} bytes`);
}
console.log(`captured at ${new Date().toISOString()}`);
