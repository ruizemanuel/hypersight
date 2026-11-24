# Pre-hackathon spike results — 2026-11-20

Throwaway experiments (code kept outside the repo; only conclusions recorded here). All Hyperliquid calls on **testnet** with mock USDC, signed by the project's named API wallet ("hypersight"). No product code.

## 1. Hyperliquid testnet

| Question | Result |
|---|---|
| Agent key valid for the master account? | Yes — `userRole(agent)` → `{"role":"agent","data":{"user":<master>}}`. |
| Account mode | `unifiedAccount`; faucet USDC sits in spot (999 after the 1 USDC activation fee). Perps margin draws from it (no perp↔spot transfer needed). |
| Outcome minimum order value | **1 USDC**. Exact error: `Order must have minimum value of 1 USDC. asset=<asset>`. |
| Fractional outcome size | Rejected: `Order has invalid size.` → **whole shares only**. |
| Outcome price precision | 5 decimals accepted (`0.01234` rested); 6 decimals rejected: `Price must be divisible by tick size. asset=<asset>` → **tick 0.00001**. |
| Stale `expiresAfter` | Whole request rejected: `{"status":"err","response":"Action already expired"}`. |
| Buy NO side | Works by ordering the side-1 asset (`100000000 + 10·outcome + 1`); balance appears as `+<enc>` with `entryNtl` = cost. |
| Perp round trip (ETH, ~$12) | IOC open filled (split into 2 fills), reduce-only IOC close filled. **Default leverage on a fresh account: 20× cross.** `liquidationPx` null at this size. |
| Exchange call latency (from Argentina) | **~1.0–1.1 s** per `/exchange` request (order or cancel). |
| Testnet outcome liquidity | Sample of 35 markets: 27 two-sided, 4 empty, rest one-sided. Typical market-maker quote **0.49 / 0.51 with ~$7–10 per side**; a few template markets have ~$2,000 per side; the BTC daily YES book had **no asks** at test time (NO side had 20 shares). |
| Open orders after tests | `[]` (all test orders cancelled). |
| Settlement of held shares | Observed on 2026-11-23 — see §5 (open question #10 answered). |

**Design consequences**
- Outcome sizing: `shares = floor(usd / price)` and reject when `shares·price < 1` ("Minimum $1"); default outcome presets **$5 / $10 / $25** (testnet depth ≈ $10 per side).
- Depth-aware proposals: if the book within the slippage cap holds fewer shares than requested, propose the available amount and say so (`only 18 shares ≤ 0.54`); with no asks at all, block with `No sellers right now`.
- Opening a perp sends `updateLeverage` first (default **2× cross**, `isCross:false` for isolated-only assets) so the 20× account default never applies silently.
- Error strings above go into the human error map.

## 2. ElevenLabs Scribe v2 Realtime (push-to-talk simulation)

Windows TTS clips (16 kHz s16le mono) streamed in 100 ms chunks at real-time pace, manual commit on "release". `language_code` set per clip; keyterms `Hyperliquid, BTC, ETH, SOL, HYPE` as repeated `keyterms=` params (echoed back in `session_started.config`, so the encoding works).

| Clip (s) | Committed transcript | Release → final | First partial (from audio start) |
|---|---|---|---|
| 2.04 | `Close half my ETH.` | 281 ms | 2,345 ms |
| 3.33 | `Buy $20 of YES on the Bitcoin Daily.` | 293 ms | 2,367 ms |
| 2.42 | `Long SOL, 50 dollars.` | 217 ms | 2,324 ms |
| 2.13 | `What are the odds on HYPE?` | 236 ms | 2,330 ms |
| 2.38 (es) | `Cerra la mitad de mi ETH.` | 249 ms | 2,372 ms |
| 2.04, no keyterms | `Close half my eth.` | 253 ms | 2,366 ms |

Handshake to `session_started`: 307–493 ms.

**Design consequences**
- ElevenLabs is confirmed (Deepgram fallback not needed). Final text arrives **~0.25 s after release**.
- Partials only start after ~2.3 s of audio, so the Listening overlay shows `Listening…` with elapsed time / level instead of relying on live words.
- Open the STT socket on `holdStart`; buffer audio until `session_started` (handshake hidden behind speech).
- Transcripts are smart-formatted (`$20`, `YES`, `SOL,`, trailing `.`) → the grammar must normalize currency symbols, punctuation and case.

## 3. Claude intent fallback (`claude-opus-5-5`, effort low, structured output via `zodOutputFormat`)

| Command | Latency | Intent |
|---|---|---|
| take profit on half of my ether | 3.27 s | `closePerp ETH 0.5` |
| get me out of the fed thing (no Fed position) | 2.34 s | `unknown` — "no position in the Fed market" |
| dump the hawks | 2.16 s | `sellOutcome o:24274 side 0 fraction 1` |
| what's the weather like | 2.18 s | `unknown` — "Not a trading command" |

~910 input / ~60–130 output tokens per call (≈ $0.005). **Design consequence:** correct and cheap, but 2–3 s → keep the fast-path grammar first and show a `Thinking…` overlay only when the LLM is used.

## 4. Even Hub simulator UI spike (SDK 0.0.16, simulator 0.9.5)

Throwaway app (outside the repo) rendering the planned card skeleton, a glyph test page, an actions list and the contextual menu, driven through the automation API.

**Glyphs.** Simulator rendering and the firmware glyph table in `@evenrealities/pretext` (`getAdvW`) agree: **present** `− × ≈ ≤ ≥ ± … · • → ▲ ▼ ● ○ ■ □ ━ ─ ▁–█ ° — – $ € % @ ★`; **missing** `✓ ✗` (advance width 0 → silently dropped). Widths (px): `−` 10, `≈` 12, `≤` 11, `→` 17, `▼` 20, `·` 5.

**Card layout.** Header 34 px tall showed a scrollbar: a single line needs **≥ 35 px** (27 px line + 2×4 px padding) → use 36 px for one-line containers. Bordered value box 50 px (border 1, padding 4) fits one line. Body with 3 lines at 150 px is fine. Brightness levels are not distinguishable in simulator screenshots (all rendered the same green).

**Input envelopes observed in the simulator.**
| Gesture | Event |
|---|---|
| Swipe on a non-overflowing capture text container | `textEvent.eventType` 1 (up) / 2 (down), every swipe |
| Tap | `sysEvent` with no `eventType` (= CLICK 0), `eventSource: 1` |
| Double tap | `sysEvent.eventType` 3 |
| Long press / release | `sysEvent.eventType` 9 / 10 (no `eventSource` in the simulator) |
| List: swipe | highlight moves, **no event** |
| List: tap | `listEvent {containerID, containerName, currentSelectItemIndex}` — `currentSelectItemName` **empty** → use the index; index 0 arrives as `undefined` |
| Contextual menu open → pick item | `sysEvent` 4 (foreground enter) → `menuItemClickEvent {itemID}` → `sysEvent` 5 |

**Mic.** `audioControl(true, Glasses)` → `true`; laptop-mic PCM arrives in **3,200-byte chunks (100 ms)**; release → `audioControl(false)`.

**Rebuild cost in the simulator:** 4–10 ms (not representative of hardware, which the docs put at ~165 ms).

## 5. Outcome settlement (checked 2026-11-23, read-only)

The 2 NO shares of the BTC daily (outcome 27153, `class:priceBinary|underlying:BTC|expiry:20261121-0300|targetPrice:62452|period:1d`), bought 2026-11-20 15:38 UTC at 0.61781 (cost $1.24), were left to expire.

| Question | Result |
|---|---|
| `settledOutcome {outcome: 27153}` | `settleFraction "0.0"` (YES pays 0, NO pays 1), `details "price:58606"` (BTC mark at expiry 58,606 < target 62,452). |
| How it shows in fills | One synthetic fill at **2026-11-21 03:00:10.647 UTC** (~10.6 s after expiry): `coin "#271531"`, `dir "Settlement"`, `side "A"`, `sz "2.0"`, `px "1.0"`, `closedPnl "0.76438"`, `fee "0.0014"` (≈ 0.07% of payout). |
| How it shows in balances | The `+271531` row is gone; no `o27153` row appears. Payout is already in `USDC` (`spotClearinghouseState` lists only USDC). |
| Ledger | `userNonFundingLedgerUpdates` has no settlement entry — the fill is the only record. |
| Claim needed? | No — automatic. |

**Design consequences**
- Detect settlement of a held position from `userFills` / the `userFills` WS feed: `dir === "Settlement"`; `px` is the payout per share (1.0 for the winning side) and `closedPnl` is the realized result. This drives the `settled` alert ("NO won · +$0.76") and the recap, without polling `settledOutcome`.
- `outcomeMetaUpdates {outcomeSettled}` still removes the market from the catalogue; the position card disappears because the `+enc` balance is gone on the next `spotState` push.
- Settlement charges a small fee; the result card shows `closedPnl` (already net of cost, before fee) and does not promise exactly `$1 × shares`.

## 6. TestnetExecutor live check (2026-11-24)

`RUN_LIVE_HL=1` run of `test/trade/testnet-executor.test.ts` through the real agent wallet:

| Step | Result |
|---|---|
| Place `#273210` (BTC daily YES, outcome 27321) buy **100 @ 0.01 Gtc** with `expiresAfter = now + 10 s` | `resting` — order `open` at 00:55:12.982 UTC. 100 shares is the smallest size at 0.01 (1 USDC minimum); 1 share would be refused. |
| `cancelAll` (`frontendOpenOrders` → one batched `cancel`, no `f`) | `canceled` at 00:55:14.361 UTC (~1.4 s later); 0 open orders afterwards. |
