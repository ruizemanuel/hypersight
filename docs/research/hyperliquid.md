# Hyperliquid API: technical reference for a testnet-only smart-glasses trading copilot

> Audience: a TypeScript developer building a smart-glasses (HUD and voice) copilot that trades **only on Hyperliquid TESTNET**.
> Research date: 2026-11-19/20 (testnet server time at probe: `1795138466780` = 2026-11-20 01:34 UTC).
> Nothing was signed or sent to `/exchange`. All live data comes from read-only `POST /info` calls and WebSocket subscriptions.

**Evidence tags used below**

| Tag | Meaning |
|---|---|
| **[DOC]** | Official Hyperliquid GitBook docs (URL cited) |
| **[LIVE]** | Observed by this research on testnet (or mainnet where stated) via `/info` or WS on 2026-11-20 UTC |
| **[PYSDK]** | Official Python SDK `hyperliquid-dex/hyperliquid-python-sdk` v0.24.0 (HEAD 2026-06-04) |
| **[NKSDK]** | `@nktkas/hyperliquid` v0.33.3 source (community TS SDK) |
| **[3P]** | Third-party guide (QuickNode, Chainstack), not authoritative |
| **UNKNOWN** | Not established by any source above. Verify on testnet before relying on it |

---

## 0. TL;DR: design-critical facts

1. **Outcome (HIP-4) trading is spot-like.** Asset id = `100_000_000 + 10*outcome + side`. The book coin is `#<enc>` and the balance coin is `+<enc>`. The quote is USDC from the **spot** balance. There is no leverage and no liquidation. Yes and No books are merged, so buying No at `q` equals selling Yes at `1-q`. [DOC asset-ids, HIP-4]
2. **Outcome sizes are whole shares in practice.** No fractional size appeared in 645 sampled trades (testnet plus mainnet). Prices are in (0,1) with up to 5 decimals and 5 significant figures [LIVE]. The `$10` minimum claimed by QuickNode is contradicted by data: testnet orders as small as 1 share at 0.10 were accepted [LIVE]. The official minimum is **UNKNOWN**.
3. **Outcome IDs rotate.** Recurring daily markets get a new `outcome` id each cycle. On testnet the daily BTC/ETH/SOL/HYPE/ZEC binaries expire at **03:00 UTC** and the BTC price-bucket question at 06:00 UTC. Mainnet binaries expire at 06:00 UTC [LIVE]. Never hardcode ids. Refresh from `outcomeMeta` and the `outcomeMetaUpdates` WS feed.
4. **Agent (API) wallet model.** The browser or master wallet signs **one** user-signed EIP-712 `approveAgent`. From then on the app holds the agent private key and signs all L1 actions (orders, cancels, leverage, scheduleCancel) with it. Withdrawals and transfers to other users are user-signed actions that require the master key, so agents cannot do them. `agentSendAsset` *can* move funds between the user's **own** perp, spot and dex balances [DOC]. Agents expire (`valid_until`, at most 180 days) [DOC].
5. **Always query with the master address, never the agent address.** Using the agent address returns empty results [DOC].
6. **The `webData2` WS subscription is gone.** Testnet rejects it with `Error parsing JSON into valid websocket request` [LIVE]. Use `webData3`, `clearinghouseState`, `spotState` and `allDexsClearinghouseState`. `allMids` WS is deprecated in favour of `fastAssetCtxs` [DOC], though it still works [LIVE].
7. **Use `scheduleCancel` as the dead man's switch.** It cancels all open orders at time T, where T must be at least now + 5 s. It allows at most 10 triggers per UTC day. It does **not** close positions [DOC]. Whether it also cancels TP/SL trigger orders is **UNKNOWN**.
8. **Testnet differs from mainnet.** Perp asset indices differ (testnet `BTC = 3`, `ETH = 4`, `SOL = 0`). Max leverage differs (testnet BTC 40x). Books are thin [LIVE]. EIP-712 `hyperliquidChain` must be `"Testnet"`, and the L1 phantom-agent `source` must be `"b"` [PYSDK].
9. **SDK choice.** `@nktkas/hyperliquid` (MIT, v0.33.3, published 2026-08-02) supports testnet, viem/ethers and browser wallets, HIP-4 info and WS, `userOutcome`, and a WS client with reconnect. Watch for one bug-risk: its `SymbolConverter` hardcodes outcome `szDecimals = 5`, which conflicts with observed integer sizes and 5-decimal prices. Do **not** use its `formatPrice`/`formatSize` for outcomes.

---

## 1. Endpoints and environment

| | Testnet | Mainnet (reference only) |
|---|---|---|
| REST info | `POST https://api.hyperliquid-testnet.xyz/info` | `https://api.hyperliquid.xyz/info` |
| REST exchange | `POST https://api.hyperliquid-testnet.xyz/exchange` | `https://api.hyperliquid.xyz/exchange` |
| WebSocket | `wss://api.hyperliquid-testnet.xyz/ws` | `wss://api.hyperliquid.xyz/ws` |
| EVM RPC | `https://rpc.hyperliquid-testnet.xyz/evm` (per NKSDK constants) | `https://rpc.hyperliquid.xyz/evm` |
| UI | `https://app.hyperliquid-testnet.xyz` | `https://app.hyperliquid.xyz` |
| Faucet | `https://app.hyperliquid-testnet.xyz/drip` gives 1,000 mock USDC. It **requires a prior mainnet deposit from the same address**. Email/Privy logins get different addresses per network, so export the key [DOC testnet-faucet] | n/a |

- All requests use `Content-Type: application/json` [DOC].
- Doc examples use mainnet URLs. The same requests work against the testnet URL [DOC api].
- The API is "v0" with nonstandard abbreviations: `px` price, `sz` size in base units, `szi` signed size, `ntl` notional, side `B`=bid/buy and `A`=ask/sell, `tif` ∈ `Gtc|Ioc|Alo` [DOC notation].
- **Activation fee:** the first transfer *to* a new HyperCore account costs 1 quote token [DOC activation-gas-fee].
- An unfunded account gets `Must deposit before performing actions. User: 0x…` [DOC signing].

Sources: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api.md, …/websocket.md, …/onboarding/testnet-faucet.md, …/for-developers/api/notation.md, …/for-developers/api/activation-gas-fee.md

---

## 2. Identifier cheat sheet

| Market | `coin` string (info/WS) | Integer `asset` (orders/cancels) | Size decimals source |
|---|---|---|---|
| Perp (first dex) | `"BTC"` (name in `meta.universe`) | index in `meta.universe` | `meta.universe[i].szDecimals` |
| HIP-3 builder perp | `"dex:COIN"`, e.g. `"test:ABC"` | `100000 + perp_dex_index*10000 + index_in_meta` (testnet `test:ABC` = 110000) | `meta({dex})` |
| Spot | `"PURR/USDC"` or `"@<spotIndex>"` | `10000 + spotMeta.universe[i].index` | base token `szDecimals` |
| Outcome side | `"#<enc>"` | `100_000_000 + enc` | UNKNOWN (see §3.7) |
| Outcome balance | `"+<enc>"` in `spotClearinghouseState` | n/a | n/a |
| Settled outcome token | `"o<outcome>"` appears in testnet `spotMeta.tokens` names (e.g. `o1528`) [LIVE]. NKSDK types `oN` as a possible balance coin | n/a | n/a |

`enc = 10*outcome + side`, with `side ∈ {0,1}`. Side 0 is `sideSpecs[0]` (usually "Yes") and side 1 is `sideSpecs[1]` (usually "No") [DOC asset-ids]. Example: outcome `27121`, side 0 → enc `271210` → coin `#271210`, token `+271210`, asset `100271210`.

**Testnet perp indices [LIVE `meta`, 213 perps]:**

| Perp | Index | szDecimals | maxLeverage | Notes |
|---|---|---|---|---|
| `SOL` | 0 | 2 | 10 | |
| `BTC` | 3 | 5 | 40 | |
| `ETH` | 4 | 4 | 25 | |
| `HYPE` | 135 | 2 | 10 | `onlyIsolated: true`, `marginMode: "strictIsolated"` |
| `ZEC` | 193 | | | `isDelisted: true` |

On mainnet `BTC = 0`. Testnet HYPE spot = `@1035`, token index 1105. Testnet USDC tokenId = `0xeb62eee3685fc4c43992febcd9e75443`, so the `token` string for transfers is `"USDC:0xeb62eee3685fc4c43992febcd9e75443"` [LIVE spotMeta].

Sources: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids.md, …/info-endpoint.md#perpetuals-vs-spot

---

## 3. HIP-4 outcome markets

### 3.1 Structure [DOC HIP-4, asset-ids, contract-specifications]

- **Collateral and payoff.** Outcomes are fully collateralized contracts that settle within a fixed range. They have no leverage and no liquidations.
- **Sides.** Each outcome has **two sides**, each a token, labeled by `sideSpecs` (often Yes/No).
- **Settlement.** Yes converts to `settleFraction` quote tokens and No to `1 - settleFraction`. A "binary yes" sets `settleFraction = 1`. Standalone outcomes may settle to any fraction in [0,1], for scalar payouts. Outcomes inside a question settle to exactly 0 or 1 [DOC hip-4-deployer-actions].
- **Merged book.** Yes and No books share liquidity: "an order to buy Yes at price `p` is equivalent to an order to sell No at price `1-p`". Priority is price-side-time: at the same merged price, resting sells sort before resting buy duals.
- **Questions.** A question is a set of outcomes where exactly one settles Yes. Each question also has an automatic **fallback** outcome ("other").
- **Operations.** `split` (USDC → Yes+No), `merge` (Yes+No → USDC), `mergeQuestion` (one Yes of every outcome → USDC) and `negate` (No of one → Yes of all others) exist via the `userOutcome` action (§3.11).
- **Quote token.** USDC on every testnet outcome observed (702/702) [LIVE].
- **Fees** [DOC fees].
  - Charged only on closing or settling, never on opening. There are no maker rebates; makers who would earn a rebate pay 0.
  - Deployer markets multiply the base fee by `scale + max(scale,1)`.
  - The HIP-4 page still says "Fees are currently zero … for initial testing". Testnet fills show `fee:"0.0"` on buys and a non-zero fee on a closing sell (`"0.00393254"`) [LIVE].
- **Recurring markets** [DOC contract-specifications].
  - Deployed and settled by the protocol on a fixed cadence. There is at most one series per `(seriesType, underlying, period)`.
  - **Binary** resolves Yes iff `markPrice0 + (settlementTime - t0)/(t1 - t0) * (markPrice1 - markPrice0) ≥ targetPrice`. This interpolates HyperCore *mark price* updates around expiry. The info page wording is "above", but the formula is `≥`.
  - **priceBucket** has three outcomes: `< P1`, `[P1, P2)`, `≥ P2`.
- **Read-only template facts (testnet).** HIP-4 *deployer* actions (`outcomeDeploy`, `activateOutcomeDeployer`) are **testnet-only**. Testnet deployers are limited to 10 active outcomes and 50 new per day [DOC hip-4-deployer-actions]. A copilot does not need these.

### 3.2 `outcomeMeta` response shape [DOC spot info + LIVE]

Request: `{"type":"outcomeMeta"}`. The response weighs **~260 KB on testnet** (702 outcomes, 130 questions) and ~313 outcomes / 27 questions on mainnet [LIVE]. Rate weight 20 (default). Cache it.

```jsonc
{
  "outcomes": [
    { "outcome": 27121, "name": "Recurring",
      "description": "class:priceBinary|underlying:BTC|expiry:20261120-0300|targetPrice:61509|period:1d",
      "sideSpecs": [{"name":"Yes"},{"name":"No"}], "quoteToken": "USDC" },
    { "outcome": 22989, "name": "template:binaryPrice6",
      "description": "perp:BTC|priceDescription:the Hyperliquid BTC perp trade|seconds:90|threshold:86000|time:20261006-2300",
      "sideSpecs": [{"name":"template:Yes"},{"name":"template:No"}],
      "quoteToken": "USDC", "venue": "kelp", "deployerFeeScale": "1.0" },
    { "outcome": 24274, "name": "template:sportsContestWinner7",
      "description": "competition:NBA|contestType:game|officialSource:ESPN|participantA:Atlanta Hawks|participantB:Dallas Mavericks|resolutionDeadline:20261017-0600|scheduledStart:20261017-0000|season:2027|shortNameA:Hawks|shortNameB:Mavericks|sport:basketball|stage:Preseason",
      "sideSpecs": [{"name":"template:{shortNameA}"},{"name":"template:{shortNameB}"}], "quoteToken":"USDC", "venue":"wren", "deployerFeeScale":"1.0" },
    { "outcome": 10218, "name": "Below 4.3%",
      "description": "This outcome resolves to Yes if the one-decimal BLS CPI year-over-year value for May 2026 is below 4.3%.",
      "sideSpecs": [{"name":"Yes"},{"name":"No"}], "quoteToken":"USDC" }
  ],
  "questions": [
    { "question": 1738, "name": "Recurring",
      "description": "class:priceBucket|underlying:BTC|expiry:20261120-0600|priceThresholds:60703,63180|period:1d",
      "fallbackOutcome": 27128, "namedOutcomes": [27129, 27130, 27131], "settledNamedOutcomes": [] },
    { "question": 820, "name": "May CPI year-over-year", "description": "The question resolves by assigning Yes to exactly one of …",
      "fallbackOutcome": 10217, "namedOutcomes": [ … ], "settledNamedOutcomes": [ … ] }
  ],
  "deployers": [ { "deployer": "0x…", "venue": "cat", "subDeployers": [ ["settleOutcome", ["0x…"]] ] } ],
  "feeScale": "1.0"
}
```

Observed outcome keys: `outcome, name, description, sideSpecs, quoteToken` (always), `venue` (590/702), `deployerFeeScale` (184/702).

Name classes on testnet [LIVE]:

| Name class | Count | Examples |
|---|---|---|
| `template:<id>` | ~485 | sportsContestParticipant, sportsContestDraw, binaryPrice*, policyRate*, scalarPrice3, priceTouch, companyIpo…, aiModelHeadToHead |
| Free-text names | 192 | "Below 4.3%", "June Fed rate change" |
| `Fallback` | 22 | |
| `Recurring` | 5 | |

Recurring question members are named `Recurring Named Outcome` (description `index:0|1|2`) and `Recurring Fallback` (description `other`).

Live testnet recurring set at probe time [LIVE]:

| outcome | description | Yes mid | No mid |
|---|---|---|---|
| 27121 | `class:priceBinary\|underlying:BTC\|expiry:20261120-0300\|targetPrice:61509\|period:1d` | 0.593705 | 0.406295 |
| 27122 | ETH, target 1756.7, same expiry | 0.4 | 0.6 |
| 27123 | SOL, target 72.715 | 0.525 | 0.475 |
| 27124 | HYPE, target 66.562 | 0.505 | 0.495 |
| 27125 | ZEC, target 138.65 | 0.4984 | 0.5016 |
| q1738 → 27129/27130/27131 (+fallback 27128) | BTC priceBucket `60703,63180`, expiry 06:00 | 0.5 each | |

Mainnet at the same time had BTC/ETH/SOL/HYPE binaries expiring at `20261120-0600` [LIVE].

Also available:
- `{"type":"outcomeTemplates"}`: ~99 KB, 71 templates on testnet [LIVE].
- `{"type":"settledOutcome","outcome":N}`: returns `null` if the outcome is not settled or does not exist [LIVE].
- `{"type":"outcomeDeployerLimits","venue":…}`.

### 3.3 Turning an outcome into a human question

Algorithm. Spec sources: [DOC spot info "Retrieve outcome metadata"], [DOC hip-4-deployer-actions], LIVE data.

1. **Index.** Build `outcomeById` and `questionByOutcome` (from `namedOutcomes` and `fallbackOutcome`).
2. **Parse descriptions.**
   - `kv = parse(description)`: split on `|`, then split each part on the **first** `:` only, because values may contain `:` (e.g. `perp:frce:US10Y`).
   - Values cannot contain `{ } |`.
   - Parse only when the outcome name is `Recurring` or starts with `template:`, or the description starts with `class:`. Free-text outcomes have prose descriptions.
3. **Recurring.** `name === "Recurring"` and `kv.class` is one of the following:
   - `priceBinary`: question = `${underlying} above ${targetPrice} at ${fmtUTC(expiry)}?`. Sides are Yes/No. `underlying` is a perp coin name. `period` is e.g. `1d`, `15m` or `3m`.
   - `priceBucket` is a **question** with `priceThresholds:<lower>,<upper>`. Its named outcomes have descriptions `index:0` (< lower), `index:1` (≥ lower and < upper) and `index:2` (≥ upper). The fallback is `other`.
   - Other keys may appear and can be ignored [DOC].
4. **Template.** `name === "template:<id>"`: look up `outcomeTemplates.find(t => t.id === id)`.
   - Display name = `template.name` with `{kw}` replaced by `kv[kw]`. Example: `binaryPrice` gives `"{perp} above {threshold} at {time}?"`, which becomes "BTC above 86000 at 2026-10-06 23:00 UTC?".
   - Long text = `template.description` with the same substitution. Strip the trailing ` metadata=category:…|subCategory:…|semanticRestriction:…`, and keep `category` for filtering (price / sports / economics …).
   - Side names arrive as `template:Yes` or `template:{shortNameA}`. Strip the `template:` prefix, then interpolate keywords. Question outcomes use plain `Yes`/`No`.
   - Keyword value formats: `dateTime` = `YYYYMMDD-HHMM` UTC, `date` = `YYYYMMDD` (end of day), `hlPerp` = perp coin, `uInt`, `uDecimal`, `string`, `shortString` (≤10 chars) [DOC].
   - The template `role` is `{"standaloneOutcome":{"sideNames":[…]}}`, `"question"`, or `{"questionOutcome":{"parent":"<questionTemplateId>"}}`.
5. **Free-text** (no `template:` prefix and not `Recurring`). Use `question.name` plus `outcome.name` (e.g. "May CPI year-over-year: Below 4.3%"). The description is already prose.
6. **Fallback outcomes** (`Fallback` / `template fallback` / `Recurring Fallback`): the "other" bucket. NKSDK's `SymbolConverter` skips them as "not tradable on their own". That is an SDK claim, UNKNOWN in the docs. Mids do exist for them [LIVE], so hide them by default in the HUD.

Live template examples [LIVE `outcomeTemplates`]:

```json
{"id":"binaryPrice","role":{"standaloneOutcome":{"sideNames":["Yes","No"]}},"name":"{perp} above {threshold} at {time}?","keywords":[["perp","hlPerp"],["threshold","string"],["time","dateTime"]]}
{"id":"priceTouch","name":"{perp} touches {target} by {time}", …}
{"id":"scalarPrice3","role":{"standaloneOutcome":{"sideNames":["Long","Short"]}},"name":"{perp} from {low} to {high} at {time}", …}
{"id":"sportsContestWinner7","role":{"standaloneOutcome":{"sideNames":["{shortNameA}","{shortNameB}"]}},"name":"{competition} {stage}: {participantA} v {participantB}", …}
```

The `binaryPrice` description reads: "If the {perp} mark price at time of settlement is above {threshold} at {time}, Yes tokens pay out $1 each. Otherwise, No tokens pay out $1 each." Scalar templates pay `$1 * (price-low)/(high-low)` to Long. Sports templates may settle at 0.5 on a draw.

Keep the meta fresh with the WS `{"type":"outcomeMetaUpdates"}` subscription. It emits `{outcomeCreated: OutcomeSpec} | {outcomeSettled: number} | {questionUpdated: QuestionSpec} | {questionSettled: number}` [DOC subscriptions].

### 3.4 Live prices for outcomes

| Source | Request | Notes |
|---|---|---|
| `allMids` (REST, weight 2) | `{"type":"allMids"}` | Includes every `#enc` coin (1404 outcome coins on testnet) [LIVE]. Falls back to last trade if the book is empty [DOC]. Yes mid + No mid = 1 |
| `l2Book` (REST, weight 2) | `{"type":"l2Book","coin":"#271210"}` | Up to 20 levels per side. The `#…1` book is the exact mirror: Yes ask 0.59602 ↔ No bid 0.40398 [LIVE]. Use `#`, **not** `+` [3P Chainstack] |
| WS `l2Book` | `{"type":"l2Book","coin":"#271210"}` | Pushes a snapshot each block, at least 0.5 s apart. The ack echoes `nSigFigs:null, mantissa:null, fast:false` (the `fast` field is undocumented) [LIVE] |
| WS `l2` | `{"type":"l2","c":"#271210"}` | First message `{s: WsBook}`, then diffs `{u: …}` or compressed `{c: base64}` [DOC]. Works for outcomes [LIVE] |
| WS `bbo` | `{"type":"bbo","coin":"#271210"}` | Sent only when the BBO changes |
| WS `fastAssetCtxs` | `{"type":"fastAssetCtxs"}` | base64 + **raw DEFLATE** (`zlib.inflateRawSync` / `DecompressionStream("deflate-raw")`). The first snapshot had 4385 coins including `#271210: {markPx:"0.593705", midPx:"0.593705"}`. Later messages are diffs [LIVE] |
| WS `activeAssetCtx` | `{"type":"activeAssetCtx","coin":"#271210"}` | Arrives on **channel `activeSpotAssetCtx`**: `{coin, ctx:{prevDayPx, dayNtlVlm, markPx, midPx, circulatingSupply, totalSupply, dayBaseVlm}}` [LIVE]. Good for 24h change |
| `recentTrades` / WS `trades` | `{"type":"recentTrades","coin":"#271210"}` | Each item: `{coin, side, px, sz, time, hash, tid, users:[buyer,seller]}` |

Testnet outcome books are **very thin**: the BTC daily Yes book had one level per side (10 and 17 shares) [LIVE].

### 3.5 Outcome order rules (size, price, minimum)

| Rule | Finding |
|---|---|
| Size | Whole shares. 0 fractional sizes in 85 testnet + 560 mainnet trades, and all observed `origSz` were integers [LIVE]. The QuickNode guide says, paraphrased, that szDecimals = 0 for HIP-4 assets and fractional sizes like 10.5 are rejected [3P]. **Conflict:** NKSDK `SymbolConverter` sets outcome szDecimals to `5` ("Outcome markets are absent from szDecimals metadata; they are all 5"). Its spot `formatPrice` would then allow only 3 price decimals, which contradicts observed 5-decimal prices. Outcomes do not appear in `spotMeta`/`meta`, so **szDecimals is UNKNOWN officially**. Safe policy: send integer sizes |
| Price | In (0,1). Observed max 5 decimals and max 5 significant figures (e.g. `0.59139`, `0.02305`) [LIVE]. The Chainstack guide says, paraphrased, that price is a probability between 0 and 1 with up to 5 decimal places [3P]. The generic spot rule (≤5 sig figs, ≤ 8 − szDecimals decimals) applies if szDecimals = 0 [DOC tick-and-lot-size]. Exact bounds (is 0.99999 or 1.0 allowed?) are **UNKNOWN**. Clamp to `[0.00001, 0.99999]` and use ≤5 decimals and ≤5 sig figs |
| Minimum order value | The QuickNode guide says, paraphrased, that the minimum order value is 10 USDC (`size * price >= 10`) [3P]. **Contradicted by data:** testnet historicalOrders show accepted and filled outcome orders of 1 share at 0.10438 (Ioc) and 3 shares at 0.55. The smallest mainnet buys seen were 10 shares at 0.10 ($1) [LIVE]. The spot error string `MinTradeSpotNtl: "Order must have minimum value of 10 {quote_token}."` exists [DOC error-responses]. **UNKNOWN**. Handle a min-notional error gracefully |
| Balance | Buying needs USDC in the **spot** balance. Standard mode keeps perp and spot USDC separate; unified account mode shares them (§7). The error is `InsufficientSpotBalance` / status `insufficientSpotBalanceRejected` [DOC, LIVE] |
| Unsupported | `priorityFee` grouping `{p:…}` is not allowed on outcome assets [NKSDK comment, 3P QuickNode]. Use `grouping:"na"` |
| Trigger (TP/SL) orders on outcomes | **UNKNOWN** (not documented). Assume unsupported |
| `reduceOnly` on outcomes | **UNKNOWN**. Use `r:false` and size ≤ held balance |
| TIF | `Gtc`, `Ioc`, `Alo` and `FrontendMarket` all observed on outcome orders [LIVE] |
| Self-trade | The resting order is canceled (`selfTradeCanceled`) [DOC self-trade-prevention, LIVE] |

### 3.6 Place, cancel and modify outcome orders (exact action JSON)

These are L1 actions signed by the agent (§5.1). The examples use outcome 27121 (BTC daily, testnet).

**Buy 20 Yes at 0.60, resting:**

```json
{
  "action": {
    "type": "order",
    "orders": [{ "a": 100271210, "b": true, "p": "0.6", "s": "20", "r": false, "t": { "limit": { "tif": "Gtc" } } }],
    "grouping": "na"
  },
  "nonce": 1795140000000,
  "signature": { "r": "0x…", "s": "0x…", "v": 27 }
}
```

- **Bet No:** `"a": 100271211, "b": true` (buy the No side). Equivalently, buying No at `q` equals selling Yes at `1-q`.
- **Sell held Yes (close):** `"a": 100271210, "b": false, "s": "<≤ held>"`. Selling without a balance is rejected (spot semantics, `InsufficientSpotBalance`).
- **"Market" outcome buy:** IOC limit at `min(bestAsk*(1+slip), 0.99999)`, rounded to ≤5 decimals and ≤5 sig figs. `{"t":{"limit":{"tif":"Ioc"}}}`. On thin testnet books expect `iocCancelRejected` ("Order could not immediately match against any resting orders."). Hyperliquid has no native market order [NKSDK market-orders guide, PYSDK].
- **Optional `"c": "0x<32 hex>"`** cloid (128-bit) [DOC].

Responses [DOC exchange-endpoint]:

```json
{"status":"ok","response":{"type":"order","data":{"statuses":[{"resting":{"oid":77738308}}]}}}
{"status":"ok","response":{"type":"order","data":{"statuses":[{"filled":{"totalSz":"0.02","avgPx":"1891.4","oid":77747314}}]}}}
{"status":"ok","response":{"type":"order","data":{"statuses":[{"error":"Order must have minimum value of $10."}]}}}
```

Note that `status: "ok"` can still carry per-order `error` entries. Pre-validation failures return a single error for the whole batch [DOC error-responses].

**Cancel:**

```json
{ "type": "cancel", "cancels": [{ "a": 100271210, "o": 65604672192 }] }
{ "type": "cancelByCloid", "cancels": [{ "asset": 100271210, "cloid": "0x4a2611199acdbe5c7e8bd360cda470f1" }] }
```

The optional `"f": true` ("fast") rejects cancels that refer to trigger orders. **Omit `f` when false.** Actions hashed with `f:false` are rejected [DOC].

**Modify:**

```json
{ "type": "modify", "oid": 65604672192, "order": { "a": 100271210, "b": true, "p": "0.61", "s": "20", "r": false, "t": { "limit": { "tif": "Gtc" } } } }
```

- `oid` may be a cloid.
- The optional `"a": true` (always_place) must be **omitted when false**.
- With `always_place = false` the new order must be non-trigger and either `Alo` or non-executable `Gtc` (forced to `Alo`) [DOC].
- `batchModify` takes `{"modifies":[{oid, order}]}`.

In openOrders and fills, an outcome order appears under the coin of the side you sent (`#271210` or `#271211`). A user may show resting orders on both coins. Historical orders may list primary and dual orders separately when an order both matches and rests [DOC HIP-4, LIVE].

### 3.7 Reading outcome positions and balances

`{"type":"spotClearinghouseState","user":"<MASTER address>"}` (weight 2). Live testnet example, address redacted [LIVE]:

```json
{"balances":[
  {"coin":"USDC","token":0,"total":"501.12962316","hold":"0.0","entryNtl":"0.0"},
  {"coin":"+271210","total":"8.0","hold":"0.0","entryNtl":"4.73112"},
  {"coin":"+271230","total":"22.0","hold":"22.0","entryNtl":"11.0"}
], "tokenToAvailableAfterMaintenance":[[0,"10577.50194949"]]}
```

- Outcome rows have **no `token` field**.
- `hold` = shares locked by resting sell orders.
- `entryNtl` = cost basis in USDC, so `avgEntry = entryNtl/total`.
- `tokenToAvailableAfterMaintenance` and `evmEscrows` are optional extras [LIVE, NKSDK].
- WS equivalent: `{"type":"spotState","user":"0x…"}` → `{user, spotState:{balances:[…]}}`. The ack echoes `ignorePortfolioMargin:false` [LIVE].
- Mark-to-market: `value = total * mid(#enc)`, `uPnL = value − entryNtl`. Map `+enc` → outcome `floor(enc/10)`, side `enc%10`.
- Open outcome orders: `openOrders` / `frontendOpenOrders`. Item shape: `{coin:"#271230", side:"A", limitPx:"0.57", sz:"22.0", oid, timestamp, origSz, tif, cloid, orderType:"Limit", reduceOnly:false, isTrigger:false, triggerPx:"0.0", triggerCondition:"N/A", children:[], isPositionTpsl:false}` [LIVE].
- Fills: `userFills`. Outcome fill: `{coin:"#271250", px:"0.4934", sz:"21.0", side:"B", dir:"Buy", startPosition:"0.0", closedPnl:"0.0", fee:"0.0", feeToken:"USDC", crossed:false, oid, tid, hash, cloid, twapId:null, time}` [LIVE].

### 3.8 Settlement lifecycle

- **Automatic settlement.** Recurring and deployer outcomes settle automatically. No claim or redeem call is needed [3P Chainstack, consistent with DOC "Settlement automatically converts…"].
- **Open orders** on a settled outcome are canceled with status **`outcomeSettledCanceled`**. This status was seen 106 times on testnet [LIVE] but is missing from the official status table [DOC]. NKSDK types include it.
- **Result.** `{"type":"settledOutcome","outcome":27120}` returns `{"spec":{…,"quoteToken":"USDC","venue":"omen"},"settleFraction":"1.0","details":"template"}` [LIVE]. The DOC example has `"details":"price:76876.9"` for recurring.
- **Detection.** Watch the WS `outcomeMetaUpdates` event `{outcomeSettled: id}`, then refresh `spotClearinghouseState`. The `+enc` balance disappears and is credited as USDC [3P]. Exact timing and the `oN` balance representation are **UNKNOWN**.

### 3.9 Split, merge and negate (`userOutcome`, L1 action) [DOC exchange-endpoint]

```json
{"type":"userOutcome","splitOutcome":{"outcome":27121,"amount":"10.0"}}
{"type":"userOutcome","mergeOutcome":{"outcome":27121,"amount":null}}
{"type":"userOutcome","mergeQuestion":{"question":1738,"amount":"5"}}
{"type":"userOutcome","negateOutcome":{"question":1738,"outcome":27129,"amount":"5"}}
```

- `splitOutcome`: X USDC → X Yes + X No.
- `mergeOutcome`: X Yes + X No → X USDC. `amount: null` means max.
- `mergeQuestion`: one Yes of each question outcome → USDC.
- `negateOutcome`: X No → X Yes of every other outcome.
- These are not needed for a basic copilot. `mergeOutcome` is useful to exit a hedged Yes+No holding without the book.

---

## 4. Perps trading

### 4.1 Order wire format [DOC exchange-endpoint, PYSDK signing.py]

```ts
type OrderWire = {
  a: number;            // asset
  b: boolean;           // isBuy
  p: string;            // price
  s: string;            // size
  r: boolean;           // reduceOnly
  t: { limit: { tif: "Alo" | "Ioc" | "Gtc" } }
   | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  c?: string;           // cloid "0x" + 32 hex
};
type OrderAction = {
  type: "order";
  orders: OrderWire[];
  grouping: "na" | "normalTpsl" | "positionTpsl";
  builder?: { b: string; f: number };
};
```

- **Field order matters:** the action is msgpack-hashed, so keep `a,b,p,s,r,t,c`, `trigger:{isMarket,triggerPx,tpsl}` and `type,orders,grouping,builder`.
- Strip trailing zeros from numeric strings and lowercase addresses [DOC signing, tick-and-lot-size].
- Optional request fields: `vaultAddress` (sub-account or vault) and `expiresAfter` (ms) [DOC].
- NKSDK also accepts `tif:"FrontendMarket"` (like Ioc, labelled as a market order). It was observed live.

### 4.2 Size and price rounding [DOC tick-and-lot-size]

- **Size:** at most `szDecimals` decimals. Round **down** for closes. `szDecimals` comes from `meta.universe[i]`.
- **Price:** at most 5 significant figures **and** at most `MAX_DECIMALS − szDecimals` decimals, where `MAX_DECIMALS` = 6 for perps and 8 for spot. Integer prices are always valid (e.g. `123456`).
- Testnet `BTC` (szDecimals 5) allows 1 decimal, but 5 sig figs at ~62,300 means integers only: `62317`. ETH (szDecimals 4) allows 2 decimals and 5 sig figs: `1756.7`.
- Prices too far from the oracle are rejected: `Oracle: "Order price too far from oracle"` [DOC error-responses].
- The perp minimum notional is `$10`: `MinTradeNtl: "Order must have minimum value of $10."` [DOC].
- Maximum market order value depends on max leverage: `$30M` for ≥25x, `$5M` for [20,25), `$2M` for [10,20), else `$500k`. The limit-order maximum is 10× that [DOC contract-specifications].

PYSDK reference rounding for an aggressive price:

```py
px *= (1+slippage) if is_buy else (1-slippage)
round(float(f"{px:.5g}"), (6 if perp else 8) - szDecimals)
```

NKSDK `formatPrice(price, szDecimals, "perp"|"spot")` / `formatSize(size, szDecimals)` implement the same rules, truncating with ROUND_DOWN.

### 4.3 Market-like order (IOC limit plus slippage)

Hyperliquid has no native market type [NKSDK, PYSDK]. PYSDK `market_open` uses `DEFAULT_SLIPPAGE = 0.05` against `allMids`. Example: testnet BTC market buy of 0.001 at mid 62300 with 5% slippage → `p = 65415`:

```json
{"type":"order","orders":[{"a":3,"b":true,"p":"65415","s":"0.001","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"}
```

The response is `filled{totalSz, avgPx, oid}`, or `error` with `IocCancel: "Order could not immediately match against any resting orders."` or `MarketOrderNoLiquidity`. Use 1–5% slippage, and prefer the book side (best ask/bid) over the mid on thin testnet books.

### 4.4 Reduce-only close of X% of a position

1. Read the position from `clearinghouseState.assetPositions[].position` (§7): `szi` (signed).
2. Compute `sz = floorTo(|szi| * pct, szDecimals)` and `isBuy = szi < 0`. Use the exact `|szi|` string when pct = 100%.
3. Send IOC at the slippage price with `"r": true`. PYSDK `market_close` does exactly this.

```json
{"type":"order","orders":[{"a":4,"b":true,"p":"1844.5","s":"0.0167","r":true,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"}
```

This closes ~50% of an ETH short of `szi = -0.0335`.

Errors:
- `ReduceOnly: "Reduce only order would increase position."` [DOC].
- A partial close below `$10` notional fails `MinTradeNtl`. Probably exempt when closing the full position: **UNKNOWN**.
- Reduce-only and trigger orders are rejected when the user already has ≥1000 open orders [DOC rate limits].

### 4.5 TP/SL trigger orders [DOC exchange-endpoint, trading/tp-sl, PYSDK basic_tpsl.py]

- **TP/SL must be reduce-only.** "non-reduce-only TP/SL orders" is a pre-validation error [DOC error-responses].
- **Triggering:** uses **mark price** [DOC tp-sl].
- **Slippage:** `isMarket:true` triggers a market order with **10% slippage tolerance** in the UI [DOC tp-sl]. With `isMarket:false` the order rests at `p` once triggered.
- **Grouping:**

| `grouping` | Use |
|---|---|
| `"na"` | Standalone trigger order |
| `"normalTpsl"` | Parent order plus children in one action (OCO-like). Children are placed only if the parent fully fills, or partially fills and is then canceled for insufficient margin. Canceling a partially filled parent cancels the children [DOC tp-sl] |
| `"positionTpsl"` | TP/SL attached to the existing position. NKSDK: "adjusts proportionally with the position size" versus normalTpsl "fixed size" (SDK description). Exact size semantics are **UNKNOWN**; send `s = |szi|` |

SL plus TP on an existing long 0.01 BTC (testnet asset 3), entry ~62,000:

```json
{"type":"order","grouping":"positionTpsl","orders":[
  {"a":3,"b":false,"p":"54000","s":"0.01","r":true,"t":{"trigger":{"isMarket":true,"triggerPx":"60000","tpsl":"sl"}}},
  {"a":3,"b":false,"p":"59400","s":"0.01","r":true,"t":{"trigger":{"isMarket":true,"triggerPx":"66000","tpsl":"tp"}}}
]}
```

`p` is the worst acceptable fill once triggered. For a sell use `p ≈ triggerPx*(1−0.1)`, for a buy `p ≈ triggerPx*(1+0.1)`. Round per §4.2. The trigger direction must be valid relative to the current price, otherwise `BadTriggerPx: "Invalid TP/SL price."`

Entry with brackets uses the same action with `grouping:"normalTpsl"` and `orders:[entry, tp, sl]`. Trailing stops have their own action: `{"type":"trailingStop","asset":3,"isBuy":false,"sz":"0.01","reduceOnly":true,"retracement":{"pct":"1.5%"},"activationPx":null}` [DOC].

### 4.6 Leverage and margin [DOC]

```json
{"type":"updateLeverage","asset":3,"isCross":true,"leverage":10}
{"type":"updateIsolatedMargin","asset":3,"isBuy":true,"ntli":1000000}
{"type":"topUpIsolatedOnlyMargin","asset":3,"leverage":"5"}
```

- `updateLeverage`:
  - Integer leverage, up to the asset's `maxLeverage` and margin tier.
  - Assets with `onlyIsolated`/`marginMode:"strictIsolated"|"noCross"` (testnet HYPE) need `isCross:false`.
  - The response is `{"status":"ok","response":{"type":"default"}}`.
  - Leverage is only checked when a position is opened. It can be increased on an open position [DOC margining].
- `updateIsolatedMargin`: `ntli` is USDC × 1e6, so 1000000 = +$1.
- `topUpIsolatedOnlyMargin` targets a leverage instead of a USDC amount.
- Current leverage and max trade sizes: `{"type":"activeAssetData","user","coin"}` returns `{leverage:{type,value}, maxTradeSzs:[buy,sell], availableToTrade:[buy,sell], markPx}`. Perps only, also available on WS.

### 4.7 Cancel all

There is **no native cancel-all action**. Options:

1. `frontendOpenOrders`, then map each `coin` to `asset` (perp name → meta index, `@N` → 10000+N, `#enc` → 100000000+enc, `dex:X` → HIP-3 formula). Then send one batched `{"type":"cancel","cancels":[…]}`.
   - The batch weighs `1 + floor(n/40)` per IP and counts as n requests per address [DOC rate limits].
   - Do **not** set `f:true`, because that rejects trigger orders.
2. `scheduleCancel` with `time = now + 5s`. This uses one of the 10 daily triggers (§10).

### 4.8 Order status values

`orderStatus` / WS `orderUpdates` status values [DOC info-endpoint, LIVE]:

| Group | Values |
|---|---|
| Live and done | `open`, `filled`, `triggered` |
| Canceled | `canceled`, `marginCanceled`, `vaultWithdrawalCanceled`, `openInterestCapCanceled`, `selfTradeCanceled`, `reduceOnlyCanceled`, `siblingFilledCanceled`, `delistedCanceled`, `liquidatedCanceled`, `scheduledCancel`, `outcomeSettledCanceled` (LIVE/NKSDK only) |
| Rejected | `rejected`, `tickRejected`, `minTradeNtlRejected`, `perpMarginRejected`, `reduceOnlyRejected`, `badAloPxRejected`, `iocCancelRejected`, `badTriggerPxRejected`, `marketOrderNoLiquidityRejected`, `positionIncreaseAtOpenInterestCapRejected`, `positionFlipAtOpenInterestCapRejected`, `tooAggressiveAtOpenInterestCapRejected`, `openInterestIncreaseRejected`, `insufficientSpotBalanceRejected`, `oracleRejected`, `perpMaxPositionRejected` |

`{"type":"orderStatus","user","oid": <u64 | cloid hex>}` returns `{status:"order", order:{order:{…}, status, statusTimestamp}}` or `{status:"unknownOid"}`.

---

## 5. Signing

The docs recommend using an SDK: "There are many potential ways in which signatures can be wrong". A wrong signature recovers a *different* address, which produces `L1 error: User or API Wallet 0x… does not exist.` or `Must deposit before performing actions. User: 0x…` [DOC signing].

### 5.1 L1 actions (orders, cancels, modify, leverage, scheduleCancel, noop, userOutcome, …) [PYSDK signing.py, NKSDK _l1.ts]

```
connectionId = keccak256(
  msgpack(action)                                   // key order matters
  || uint64_be(nonce)
  || (vaultAddress ? 0x01 || 20-byte addr : 0x00)
  || (expiresAfter !== undefined ? 0x00 || uint64_be(expiresAfter) : <nothing>)
)
EIP-712 domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0000000000000000000000000000000000000000 }
types: { Agent: [ {name:"source", type:"string"}, {name:"connectionId", type:"bytes32"} ] }
primaryType: "Agent"
message: { source: "b" /* TESTNET; "a" = mainnet */, connectionId }
POST body: { action, nonce, signature: {r, s, v}, vaultAddress?, expiresAfter? }
```

- These are signed by the **agent key** (or the master key).
- In a browser wallet they appear as an unreadable "phantom agent" hash. That is why apps approve an agent once and sign L1 locally [NKSDK browser-wallets guide].
- The domain `chainId` 1337 will not match the user's wallet chain. Whether browser wallets refuse such a request is wallet-dependent: **UNKNOWN**. Avoid it by using an agent.

### 5.2 User-signed actions (approveAgent, withdraw3, usdSend, spotSend, sendAsset, usdClassTransfer, approveBuilderFee, tokenDelegate, cWithdraw, userSetAbstraction, …) [DOC, PYSDK]

```
domain: { name: "HyperliquidSignTransaction", version: "1", chainId: parseInt(action.signatureChainId, 16), verifyingContract: 0x0 }
message = the action fields, including hyperliquidChain: "Testnet"; nonce or time = outer nonce
```

- `signatureChainId` is "the chain used by the wallet to sign and can be any chain". `hyperliquidChain` is what prevents cross-environment replay [PYSDK comment].
- PYSDK hardcodes `"0x66eee"` (421614, Arbitrum Sepolia). The docs example uses `"0xa4b1"` (42161, Arbitrum). NKSDK defaults to the wallet's current chain id, which is good for browser wallets.
- `expiresAfter` is **not supported** on user-signed actions [DOC].

`approveAgent` typed data for testnet (primary type `HyperliquidTransaction:ApproveAgent`) [PYSDK sign_agent, NKSDK ApproveAgentTypes]:

```json
{
  "domain": { "name": "HyperliquidSignTransaction", "version": "1", "chainId": 421614, "verifyingContract": "0x0000000000000000000000000000000000000000" },
  "types": {
    "EIP712Domain": [ {"name":"name","type":"string"}, {"name":"version","type":"string"}, {"name":"chainId","type":"uint256"}, {"name":"verifyingContract","type":"address"} ],
    "HyperliquidTransaction:ApproveAgent": [
      {"name":"hyperliquidChain","type":"string"},
      {"name":"agentAddress","type":"address"},
      {"name":"agentName","type":"string"},
      {"name":"nonce","type":"uint64"}
    ]
  },
  "primaryType": "HyperliquidTransaction:ApproveAgent",
  "message": { "hyperliquidChain": "Testnet", "agentAddress": "0xagent…", "agentName": "glasses valid_until 1810000000000", "nonce": 1795140000000 }
}
```

POST `/exchange`:

```json
{
  "action": { "type": "approveAgent", "signatureChainId": "0x66eee", "hyperliquidChain": "Testnet",
              "agentAddress": "0xagent…", "agentName": "glasses valid_until 1810000000000", "nonce": 1795140000000 },
  "nonce": 1795140000000,
  "signature": { "r": "0x…", "s": "0x…", "v": 27 }
}
```

- `action.nonce` must equal the outer `nonce` [DOC].
- For an **unnamed** agent, PYSDK signs with `agentName: ""` and then **deletes** `agentName` from the posted action. NKSDK sends `agentName: ""`. Either appears accepted.
- NKSDK enforces a 16-character limit on the base name, excluding the ` valid_until …` suffix.

---

## 6. API (agent) wallets

| Topic | Fact | Source |
|---|---|---|
| Purpose | "A master account can approve API wallets to sign on behalf of the master account or any of the sub-accounts." API wallets only **sign**; queries must use the master or sub-account address | DOC nonces-and-api-wallets |
| Who signs approval | The master wallet (e.g. the user's browser wallet), as a **user-signed EIP-712** action (§5.2) | DOC exchange-endpoint, PYSDK |
| Agent key needs funds? | No. It is a pure signer. The registering account must hold funds, otherwise the agent may be pruned | DOC |
| Count | "An account can have 1 unnamed approved wallet and up to 3 named ones. And additional 2 named agents are allowed per subaccount." The sub-accounts page says "starts at 3 for all master accounts and increases by 2 per sub-account" | DOC exchange-endpoint, sub-accounts |
| Named vs unnamed | Approving a new **unnamed** agent deregisters the existing unnamed one. Approving with a **matching name** deregisters the old agent of that name. Named agents are listed by `{"type":"extraAgents","user"}`, which returned `[]` for a user whose unnamed agent shows in `webData3.userState.agentAddress` [LIVE]. The `extraAgents` response shape for a non-empty list is UNKNOWN | DOC, LIVE |
| Expiry | Append `valid_until <ms timestamp>` to `agentName`, at most **180 days** ahead. NKSDK docs say the default is 90 days; that is not in the official docs, so UNKNOWN officially. `webData3.userState.agentValidUntil` exposes the unnamed agent's expiry [LIVE] | DOC, NKSDK, LIVE |
| Revocation | No explicit revoke action is documented. To revoke, overwrite: approve a fresh throwaway address in the same slot (unnamed, or the same name), or let it expire. "Pruned" also happens if the account no longer has funds. An explicit revoke action is **UNKNOWN** | DOC |
| Address reuse | "strongly suggested to not reuse their addresses. Once an agent is deregistered, its used nonce state may be pruned … previously signed actions can be replayed." Generate a new key per approval | DOC |
| Identify | `{"type":"userRole","user":"0xagent"}` returns `{"role":"agent","data":{"user":"0xmaster"}}` [LIVE]. Weight 60 | DOC, LIVE |
| **Can an agent withdraw?** | The official docs have **no single sentence** stating it. The rules imply no: `withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `usdClassTransfer`, `approveAgent`, `cWithdraw` and `tokenDelegate` are user-signed EIP-712 actions verified against the user's own key. The docs explicitly provide separate agent-signable variants only for `agentSendAsset` ("Similar to send asset, but can be signed by an agent. **Destination must match the source address.**"), `cDeposit2` ("Deposit into staking (agent) … can be signed by an agent"), `agentSetAbstraction` and `agentEnableDexAbstraction`. Builder fee approval "must be signed by the user's main wallet, not an agent/API wallet". Chainstack (third-party) states: "Agents CANNOT transfer funds", "Agents CANNOT withdraw to L1", "Agents CANNOT approve other agents", "Agents CAN place and cancel orders", "Agents CAN modify leverage" | DOC exchange-endpoint, builder-codes; 3P Chainstack user-signed-actions |
| What an agent can do | All L1 actions: order, cancel, cancelByCloid, modify, batchModify, updateLeverage, updateIsolatedMargin, scheduleCancel, twapOrder, twapCancel, trailingStop, noop, reserveRequestWeight, userOutcome (split/merge/negate). It can also move funds between the user's own perp, spot and dex balances via `agentSendAsset` | DOC |
| Residual risk | A leaked agent key cannot withdraw. It **can** trade the account into losses, e.g. by crossing an attacker's quotes on a thin outcome book. Keep the key in secure storage, set short `valid_until`, cap order sizes client-side, and use `expiresAfter` | design inference |

`agentSendAsset`, an agent-signed L1 action that moves perp USDC to spot for outcome buys under standard mode [DOC]:

```json
{"type":"agentSendAsset","destination":"0xMASTER","sourceDex":"","destinationDex":"spot","token":"USDC:0xeb62eee3685fc4c43992febcd9e75443","amount":"50","fromSubAccount":"","nonce":1795140000000}
```

- `""` means the default USDC perp dex and `"spot"` means the spot balance.
- NKSDK exposes `client.agentSendAsset({destination, sourceDex, destinationDex, token, amount, fromSubAccount})`, signed as an **L1 action**. It injects the inner `nonce`, with the source comment "Equal to the envelope nonce … (server requires equality)" [NKSDK agentSendAsset.ts].

---

## 7. Account state for a "glance" HUD

### 7.1 Which source is authoritative

First call `{"type":"userAbstraction","user"}`. It returns `"unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction"`. The live testnet user returned `"default"` [LIVE, DOC].

- **Unified account / portfolio margin:** "spotClearinghouseState … is the source of truth for trading account balance across spot and perps". Per-perp-dex `clearinghouseState` balances "are not meaningful". Use `clearinghouseState` only for positions [DOC info-endpoint, account-abstraction-modes].
- **Standard / default / disabled:** perp and spot balances are separate. Equity = perp `marginSummary.accountValue` + spot USDC `total` + Σ spot token value + Σ outcome value.
- Unified and portfolio-margin accounts are limited to 50k user actions per day [DOC account-abstraction-modes].
- The default mode for a fresh testnet account is **UNKNOWN**.

### 7.2 `clearinghouseState` (perps, weight 2; WS `clearinghouseState` with `dex:""`)

```jsonc
{
  "marginSummary":      { "accountValue":"3370.641206", "totalNtlPos":"6838.058691", "totalRawUsd":"-3412.025485", "totalMarginUsed":"934.817672" },
  "crossMarginSummary": { "accountValue":"3343.540876", "totalNtlPos":"6810.362691", "totalRawUsd":"-3466.821815", "totalMarginUsed":"907.717342" },
  "crossMaintenanceMarginUsed":"453.858664",
  "withdrawable":"2397.029985",
  "assetPositions":[{ "type":"oneWay", "position":{
     "coin":"SOL", "szi":"2.21", "leverage":{"type":"cross","value":10},   // isolated adds "rawUsd"
     "entryPx":"85.5682", "positionValue":"159.984994", "unrealizedPnl":"-29.120862",
     "returnOnEquity":"-1.5399238615", "liquidationPx":null, "marginUsed":"15.998499", "maxLeverage":10,
     "cumFunding":{"allTime":"131.950135","sinceOpen":"131.950135","sinceChange":"-3.309964"} } }],
  "time": 1708622398623   // REST only
}
```

The example is a live testnet WS frame with the address omitted [LIVE]. **`liquidationPx` can be `null`.**

HUD formulas:
- Perp uPnL = Σ `unrealizedPnl`.
- Margin usage = `marginSummary.totalMarginUsed / marginSummary.accountValue`.
- Liquidation-risk ratio (cross) = `crossMaintenanceMarginUsed / crossMarginSummary.accountValue`. "Cross positions are liquidated when the account value … is less than the maintenance margin" [DOC margining]. A ratio ≥ 1 means liquidation; alert at e.g. 0.7.
- Unified accounts use the docs' `computeUnifiedAccountRatio` (TypeScript in DOC account-abstraction-modes).
- Mark price per position: `positionValue/|szi|` (derived), or exactly from `activeAssetCtx`/`metaAndAssetCtxs`/`fastAssetCtxs`.
- `entryPx` is given. `side = sign(szi)`.

### 7.3 `metaAndAssetCtxs` (market context, weight 20)

Returns `[meta, ctxs[]]`, where `ctxs[i]` = `{funding, openInterest, prevDayPx, dayNtlVlm, premium, oraclePx, markPx, midPx, impactPxs, dayBaseVlm}`, aligned with `meta.universe` [DOC, LIVE].

### 7.4 Recent fills

`{"type":"userFills","user","aggregateByTime":true}` returns at most 2000 most recent fills. Weight 20, plus extra weight per 20 items returned.

- Use `userFillsByTime` (`startTime` required, at most 2000 per response, only the 10000 most recent available) for paging [DOC].
- Fill fields: `coin, px, sz, side, time, startPosition, dir ("Open Long"/"Close Short"/"Buy"/"Sell"…), closedPnl, hash, oid, crossed, fee, feeToken, builderFee?, tid, cloid?, liquidation?, twapId`.
- Prefer WS `userFills` (snapshot `isSnapshot:true`, then streaming) [DOC, LIVE].

### 7.5 Other useful reads

| Request | Returns |
|---|---|
| `frontendOpenOrders` | Open orders including trigger and TP/SL flags |
| `userRateLimit` | `{cumVlm, nRequestsUsed, nRequestsCap, nRequestsSurplus}` [LIVE] |
| `userFees` | Fee rates and daily volumes |
| `portfolio` | Account-value and PnL history for sparklines (see DOC info-endpoint "Query a user's portfolio") |

---

## 8. WebSocket [DOC websocket, subscriptions, post-requests, timeouts; LIVE]

### 8.1 Protocol

- Subscribe with `{"method":"subscribe","subscription":{…}}`. The ack is `{"channel":"subscriptionResponse","data":{"method":"subscribe","subscription":{…normalized…}}}`.
- Unsubscribe with `{"method":"unsubscribe","subscription":{…identical…}}`.
- Data frames look like `{"channel":"<type>","data":…}`. Exceptions: `userEvents` arrives on channel **`user`**, and `activeAssetCtx` for spot or outcome coins arrives on channel **`activeSpotAssetCtx`**.
- **Errors:** `{"channel":"error","data":"Error parsing JSON into valid websocket request: …"}` (seen for `webData2`) [LIVE].
- **Keepalive:** the server closes a connection after 60 s with no message from the client. Send `{"method":"ping"}` and receive `{"channel":"pong"}`.
- **Reconnect:** disconnects "may happen periodically and without announcement". Resubscribe. Snapshots on resubscribe (`isSnapshot:true`) cover missed data.
- **Post over WS:** `{"method":"post","id":<n>,"request":{"type":"info"|"action","payload":{…}}}`. The response arrives as `{"channel":"post","data":{"id","response":{"type":"info"|"action"|"error","payload"}}}`. Signed actions can be sent this way.

### 8.2 Subscriptions relevant to the copilot

| Purpose | Subscription | Data |
|---|---|---|
| All prices (perps, spot, outcomes) | `{"type":"fastAssetCtxs"}` | base64 raw-DEFLATE `Record<coin,{markPx?,midPx?}>`. Snapshot first, then diffs |
| All mids (deprecated) | `{"type":"allMids"}` (optional `dex`) | `{mids: Record<coin,string>}`. Still works: 3532 coins including outcomes [LIVE] |
| Book | `l2Book` `{coin, nSigFigs?, mantissa?}` / `l2` `{c, s?, m?}` / `bbo` `{coin}` | `WsBook {coin, levels:[bids,asks], time}`, `WsLevel {px,sz,n}` |
| Trades | `{"type":"trades","coin"}` | `WsTrade[] {coin, side, px, sz, hash, time, tid, users:[buyer,seller]}` |
| Asset context | `{"type":"activeAssetCtx","coin"}` | perp `ctx {funding, openInterest, oraclePx, markPx, midPx, prevDayPx, dayNtlVlm, premium, impactPxs, dayBaseVlm}` |
| Positions and margin | `{"type":"clearinghouseState","user","dex":""}` | `{dex, user, clearinghouseState:{…§7.2}}`. About 1 push per block-ish (3 in 12 s observed) |
| All dexes | `{"type":"allDexsClearinghouseState","user"}` | `{user, clearinghouseStates:[[dex, state]]}` |
| Spot and outcome balances | `{"type":"spotState","user"}` | `{user, spotState:{balances}}` |
| Frontend aggregate | `{"type":"webData3","user"}` | `{userState:{agentAddress, agentValidUntil, serverTime, cumLedger, isVault, user, optOutOfSpotDusting?, dexAbstractionEnabled?}, perpDexStates:[{totalVaultEquity, perpsAtOpenInterestCap?, leadingVaults?}]}`. ~8 KB per push. "Additional undocumented fields … will be removed" |
| Order lifecycle | `{"type":"orderUpdates","user"}` | `WsOrder[] {order:{coin, side, limitPx, sz, oid, timestamp, origSz, cloid?}, status, statusTimestamp}` |
| Fills | `{"type":"userFills","user","aggregateByTime"?}` | `{isSnapshot?, user, fills: WsFill[]}` |
| Fills, funding, liquidation events | `{"type":"userEvents","user"}` → channel `user` | `{fills} \| {funding} \| {liquidation:{lid, liquidator, liquidated_user, liquidated_ntl_pos, liquidated_account_value}} \| {nonUserCancel:[{coin,oid}]}` |
| Ledger (deposits, transfers, liquidations) | `{"type":"userNonFundingLedgerUpdates","user"}` | typed deltas |
| Notifications | `{"type":"notification","user"}` | `{notification: string}` |
| Outcome lifecycle | `{"type":"outcomeMetaUpdates"}` | `[{outcomeCreated}\|{outcomeSettled}\|{questionUpdated}\|{questionSettled}]` |
| Leverage and max size | `{"type":"activeAssetData","user","coin"}` | perps only |

Alert ideas:
- **Liquidation proximity:** from `clearinghouseState`.
- **Fills / TP-SL triggered:** from `orderUpdates` status `triggered`/`filled`, and `userEvents` fills.
- **Liquidation event:** `userEvents.liquidation`.
- **Outcome settled:** `outcomeMetaUpdates`.
- **Price thresholds:** `fastAssetCtxs`.
- **Dead-man trigger:** order status `scheduledCancel`.

---

## 9. Rate limits [DOC rate-limits-and-user-limits]

**Per IP:**

| Limit | Value |
|---|---|
| REST weight | 1200 per minute total |
| `exchange` | Weight `1 + floor(batch_length/40)` |
| `info` weight 2 | `l2Book`, `allMids`, `clearinghouseState`, `orderStatus`, `spotClearinghouseState`, `exchangeStatus` |
| `info` weight 60 | `userRole` |
| `info` weight 20 | Everything else, including `outcomeMeta`, `metaAndAssetCtxs`, `openOrders`, `userFills` |
| Extra weight per 20 items returned | `recentTrades`, `historicalOrders`, `userFills`, `userFillsByTime`, `fundingHistory`, `userFunding`, … |
| Extra weight per 60 items returned | `candleSnapshot` |
| **WS connections** | At most **10** |
| New WS connections | At most **30 per minute** |
| WS subscriptions | At most **1000** |
| **Unique users across user-specific WS subscriptions** | At most **10**. This matters for any multi-user backend |
| WS messages sent | At most **2000 per minute** |
| In-flight WS posts | At most **100** |

**Per address** (actions only, not info):
- 1 request per 1 USDC of cumulative traded volume, plus an initial buffer of **10,000** requests.
- When limited: 1 request per 10 s.
- Cancels get `min(limit+100000, limit*2)`.
- A batch of n counts as n requests. Sub-accounts count separately.
- `reserveRequestWeight` buys extra requests at 0.0005 USDC each.
- Open order limit: 1000 plus 1 per 5M USDC of volume, capped at 5000.

Stale `expiresAfter` cancellations cost **5×** the address-based limit [DOC exchange-endpoint].

Budget for a HUD: one WS connection carrying `fastAssetCtxs`, `clearinghouseState`, `spotState`, `orderUpdates`, `userFills` and `outcomeMetaUpdates` costs zero REST weight in steady state. Use REST only for bootstrap: `meta` (20), `outcomeMeta` (20), `outcomeTemplates` (20) and `userAbstraction` (20).

---

## 10. Safety features

| Feature | Details |
|---|---|
| **scheduleCancel (dead man's switch)** | `{"type":"scheduleCancel","time": <ms>}` (L1, agent can sign). Omit `time` to remove the schedule. "The time must be at least 5 seconds after the current time. Once the time comes, all open orders will be canceled and a trigger count will be incremented. The max number of triggers per day is 10. This trigger count is reset at 00:00 UTC." Canceled orders get status `scheduledCancel` [DOC]. Does **not** close positions. Coverage of trigger/TP-SL orders is **UNKNOWN**: if it cancels SLs, a dead-man trigger would *remove* protection. Test this on testnet. Pattern: while the glasses session is alive, re-arm every ~20 s with `time = now + 60s`. On session end, either let it fire or clear it |
| **expiresAfter** | Request-level ms timestamp after which an L1 action is rejected. Use `now + ~10 s` for voice-confirmed orders so late deliveries never execute (the UI uses a 15 s "Action already expired" protection) [DOC exchange-endpoint, FAQ] |
| **noop** | `{"type":"noop"}` marks a nonce as used. "This can be a more effective way to cancel in-flight orders than the cancel action" [DOC] |
| **Reduce-only** | `r:true` on closes and TP/SL prevents accidental flips [DOC] |
| **ALO** | Post-only. Rejected with `BadAloPx` if it would cross [DOC] |
| **Self-trade prevention** | Expire-maker behaviour [DOC] |
| **Agent expiry** | `valid_until` ≤ 180 days. Use short expiries (e.g. 7 days) for a glasses session [DOC] |
| **Client-side guards (recommended)** | Max notional per order, max leverage, confirmation for size > X, testnet-only hard lock: refuse any URL other than `*.hyperliquid-testnet.xyz` and require `hyperliquidChain === "Testnet"` and phantom `source === "b"` |

---

## 11. Gotchas

### 11.1 Nonces [DOC nonces-and-api-wallets]

- Nonces are tracked **per signer**: the agent address if an agent signs. Sub-accounts signed by the same agent share its nonce set.
- The 100 highest nonces are kept. A new nonce must be **greater than the smallest** of them and **never used before**.
- Nonces must lie within `(T − 2 days, T + 1 day)` of block time T in ms.
- Use `nonce = max(Date.now(), last + 1)` per signer, as NKSDK's `createNonceManager` does.
- Use one agent per process or device to avoid collisions.
- User-signed actions carry `nonce`/`time` inside the action and it **must equal** the outer `nonce`.
- Batch IOC/GTC separately from ALO, since ALO-only batches are prioritized [DOC].

### 11.2 Signing pitfalls [DOC signing]

1. There are two schemes, L1 versus user-signed.
2. Msgpack field order matters.
3. Trailing zeros in number strings break hashes.
4. Lowercase addresses.
5. "Recover signer locally" can succeed while the server payload differs.
6. Optional flags `f` (cancel) and `a` (modify) must be **omitted** when false.

### 11.3 Testnet vs mainnet

| Aspect | Testnet | Mainnet |
|---|---|---|
| `hyperliquidChain` | `"Testnet"` | `"Mainnet"` |
| Phantom agent `source` | `"b"` | `"a"` |
| Perp asset indices | `BTC = 3` | `BTC = 0` |
| Spot and token ids | Testnet HYPE spot ID 1035, token 1105 | Mainnet 107 / 150 |
| Leverage | BTC 40x, HYPE isolated-only | differs |
| Outcome markets | ~702 outcomes, many deployer venues | ~313 |
| Recurring binary expiry | 03:00 UTC | 06:00 UTC |
| Deployer actions | Available | Testnet-only feature |
| Liquidity | Thin books; IOC rejects are common (`iocCancelRejected` seen often) | |
| Funding | Faucet requires a prior mainnet deposit by the same address | |

### 11.4 Common errors to map to HUD messages

| Error | Meaning / action |
|---|---|
| `Order must have minimum value of $10.` | Perp `MinTradeNtl` |
| `Order must have minimum value of 10 {quote_token}.` | Spot `MinTradeSpotNtl` |
| `Price must be divisible by tick size.` | Rounding (§4.2) |
| `Insufficient margin to place order.` | Margin |
| `Reduce only order would increase position.` | Reduce-only mismatch |
| `Post only order would have immediately matched, bbo was {bbo}.` | ALO crossed |
| `Order could not immediately match against any resting orders.` | IOC on a thin book |
| `Invalid TP/SL price.` | Trigger direction |
| `No liquidity available for market order.` | No liquidity |
| `Order price too far from oracle` | Oracle band |
| `Order would cause position to exceed margin tier limit at current leverage` | Margin tier |
| `(Spot-only) Order has insufficient spot balance to trade` | Outcome buys lacking spot USDC |
| `Order was never placed, already canceled, or filled.` | Cancel of a missing order |
| `L1 error: User or API Wallet 0x… does not exist.` / `Must deposit before performing actions. User: 0x…` | Bad signature, wrong chain flag, or unfunded account |
| `Action already expired` | UI wording for late actions. The exact API string for a stale `expiresAfter` is **UNKNOWN** |

- **Single-error batches:** a whole-batch pre-validation failure returns a single error, which is not per-order [DOC error-responses].
- **NKSDK behaviour:** `ApiRequestError` is thrown if **any** status in a batch has `error`. The successful statuses are still in `error.response`.

### 11.5 Miscellaneous

- `outcomeMeta` does not return coin strings or asset ids; compute them yourself [3P Chainstack].
- Use the **master** address in every info and WS user query.
- The HIP-4 docs still mention "Fees are currently zero"; fee rules changed (§3.1), so read fees from fills.
- Spot pairs other than `PURR/USDC` are `@index`. Some UI names are remapped (e.g. UBTC) [DOC info-endpoint].

---

## 12. TypeScript SDK evaluation

### 12.1 `@nktkas/hyperliquid` (recommended)

| Criterion | Finding |
|---|---|
| Version, date | npm `0.33.3`, published 2026-08-02. Previous releases: 0.33.2 2026-07-15, 0.33.1 2026-06-22, 0.33.0 2026-06-19. Repo HEAD commit 2026-08-02 [npm registry, git] |
| License | MIT |
| Runtime | Node ≥ 22.12, Deno, Bun, browsers; React Native ≥ 0.86 (polyfills needed for `fastAssetCtxs`) |
| Dependencies | `@nktkas/rews`, `@noble/hashes`, `decimal.js`, `valibot` |
| Listed by official docs | Yes, as a community TS SDK alongside `nomeida/hyperliquid` [DOC api] |
| Testnet | `new HttpTransport({ isTestnet: true })` / `new WebSocketTransport({ isTestnet: true })` set URLs, `hyperliquidChain:"Testnet"` and phantom `source:"b"` (`_l1.ts`: `source: isTestnet ? "b" : "a"`) |
| Wallets | Adapters for **viem local account**, **viem JSON-RPC account** (`createWalletClient({account, transport: custom(window.ethereum)})`), **ethers v6** and **ethers v5** signers. `signatureChainId` defaults to the wallet's chain id or can be configured. The guide shows exactly the flow needed: the browser wallet calls `approveAgent`, then a second `ExchangeClient` uses the agent key from `privateKeyToAccount` |
| HIP-4 | Info: `outcomeMeta`, `outcomeTemplates`, `settledOutcome`. Exchange: `userOutcome` (split/merge/negate), `activateOutcomeDeployer`. Subscription: `outcomeMetaUpdates`. `spotClearinghouseState` types include `+N`/`oN` coins. Order status includes `outcomeSettledCanceled`. Outcome orders go through the generic `order({orders:[{a: 100000000+enc, …}]})`. `SymbolConverter` maps URL-style slugs (e.g. `btc-above-61720-yes-jun-08-0600`) to asset ids |
| HIP-4 caveats | `SymbolConverter` hardcodes outcome `szDecimals = 5` (§3.5 conflict), so do not feed outcomes to `formatPrice`/`formatSize`; write a tiny outcome formatter instead. Its `OutcomeMetaResponse` type lacks the observed `venue`/`deployerFeeScale` fields (types lag the API). The README states that API-mirroring types change in patch releases |
| Exchange coverage | `order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `scheduleCancel`, `updateLeverage`, `updateIsolatedMargin`, `topUpIsolatedOnlyMargin`, `twapOrder`, `approveAgent`, `noop`, `agentSendAsset` (L1, agent-signable), `sendAsset`, `usdClassTransfer`, `withdraw3`, `userOutcome`, … |
| WebSocket | `SubscriptionClient` + `WebSocketTransport`: reconnecting socket (`@nktkas/rews`), keep-alive pings, automatic re-subscription after reconnect (`resubscribe` defaults to `true`), `fastAssetCtxs` decoded with `DecompressionStream("deflate-raw")`, subscriptions incl. `l2Book`, `bbo`, `trades`, `orderUpdates`, `userFills`, `userEvents`, `clearinghouseState`, `spotState`, `webData3`, `activeAssetCtx`/`activeSpotAssetCtx`, `outcomeMetaUpdates`. There is **no** `webData2` subscription, which matches the server change |
| Nonce | Global per-signer monotonic nonce manager (`Date.now()` or `last+1`) |
| Errors | Typed classes `ValidationError`, `FormatError`, `ApiRequestError` (with `.response`), `HttpRequestError`, `WebSocketRequestError`, `AbstractWalletError` |
| Risk | Single maintainer. Last release ~3.5 months before this research while the API keeps changing. Pin the exact version and smoke-test on testnet |

### 12.2 Alternatives

- **`hyperliquid` (nomeida, `nomeida/hyperliquid-api`).** npm 1.7.7, last modified 2025-09-05, MIT. **No HIP-4 support** (zero `outcome` references in the tarball). Not recommended.
- **Official Python SDK** v0.24.0. **No HIP-4 support**: `l2_snapshot("#10")` raises `KeyError` until `coin_to_asset` is patched [3P Chainstack; confirmed no "outcome" in source]. Still the canonical reference for signing.
- **Raw implementation.** About 150 lines with `viem` (`signTypedData`) + `@msgpack/msgpack` + keccak, following §5. This is feasible if NKSDK lags.

---

## 13. Open questions to verify on testnet before building (ordered by design impact)

**Answered 2026-11-20 (read-only checks on the builder's funded testnet account):**
- Faucet USDC lands in the **spot** balance: `spotClearinghouseState` shows `USDC total "999.0"` (1,000 minus the 1 USDC activation fee, [HL §1]); perp `clearinghouseState` shows `accountValue "0.0"`.
- The account's abstraction mode is **`unifiedAccount`** → spot USDC is the single source of truth for balance across spot, perps and outcomes [HL §7.1]; no `agentSendAsset` perp→spot step is needed for outcome buys on this account (keep the step only for `default`/`disabled` modes).
- An **unnamed** API wallet is registered: `webData3.userState.agentAddress` is set, `extraAgents` is `[]`, and `userRole(agent)` returns `{"role":"agent","data":{"user":<master>}}`. Its `agentValidUntil` is 2026-12-04 15:11 UTC (≈ 14 days; covers the deadline and Demo Day).

1. Outcome **minimum order size/notional**, and whether fractional sizes are rejected. Place 1 share at 0.01, then 0.5 share.
2. Outcome **price bounds and decimals**: test 0.000001 (6 dp), 0.99999 and 1.0.
3. Does **`scheduleCancel`** cancel TP/SL trigger orders? What error appears if it is set < 5 s ahead or after 10 triggers?
4. Exact semantics of `positionTpsl` sizing (and whether `s` may be `"0"`).
5. Whether reduce-only and trigger orders are accepted on outcome assets.
6. Default **account abstraction mode** for a fresh testnet account, and where faucet USDC lands (perp or spot). This determines whether `agentSendAsset` to spot is needed before outcome buys.
7. An end-to-end `agentSendAsset` perp→spot transfer signed by an agent on testnet. The docs and NKSDK say it works; no live confirmation yet.
8. Default agent expiry without `valid_until` (NKSDK claims 90 days), and the exact error when using an expired agent.
9. API error string for a stale `expiresAfter`.
10. How settled outcome balances appear right after settlement (`+enc` disappears vs `oN` row) and the latency to USDC credit.

---

## 14. Sources

**Official docs (GitBook, `.md` variants fetched 2026-11-19):**

| Topic | URL |
|---|---|
| Index | https://hyperliquid.gitbook.io/hyperliquid-docs/llms.txt |
| HIP-4 | https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-4-outcome-markets.md |
| Asset IDs | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids.md |
| Tick and lot size | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size.md |
| Nonces and API wallets | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets.md |
| Info endpoint | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint.md |
| Info: perpetuals | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals.md |
| Info: spot (outcomeMeta, outcomeTemplates, settledOutcome) | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot.md |
| Exchange endpoint | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint.md |
| WebSocket | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket.md |
| Subscriptions | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions.md |
| Post requests | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/post-requests.md |
| Timeouts and heartbeats | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats.md |
| Error responses | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses.md |
| Signing | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing.md |
| Rate limits | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits.md |
| HIP-4 deployer actions | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-4-deployer-actions.md |
| Contract specifications | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications.md |
| Fees | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees.md |
| TP/SL | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl.md |
| Order types | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types.md |
| Margining | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining.md |
| Liquidations | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations.md |
| Account abstraction modes | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes.md |
| Builder codes | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes.md |
| Sub-accounts | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/sub-accounts.md |
| Self-trade prevention | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/self-trade-prevention.md |
| Testnet faucet | https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet.md |
| "Action already expired" FAQ | https://hyperliquid.gitbook.io/hyperliquid-docs/support/faq/trade-outcome-looks-incorrect/what-does-action-already-expired-mean.md |
| Activation gas fee | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee.md |
| API overview | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api.md |

**SDKs:**
- https://github.com/nktkas/hyperliquid (cloned `--depth 1`, HEAD `db80d59`, 2026-08-02)
- https://www.npmjs.com/package/@nktkas/hyperliquid (registry metadata)
- https://github.com/hyperliquid-dex/hyperliquid-python-sdk (cloned, v0.24.0)
- https://www.npmjs.com/package/hyperliquid (nomeida)

**Third-party (non-authoritative):**
- https://www.quicknode.com/guides/hyperliquid/trade-hip-4-prediction-markets-on-hyperliquid
- https://docs.chainstack.com/docs/hyperliquid-hip4-outcome-markets-trading
- https://docs.chainstack.com/docs/hyperliquid-user-signed-actions
- https://supa.is/article/hyperliquid-schedulecancel-dead-mans-switch-cancel-all-orders-api (restates official scheduleCancel rules)

**Live probes (read-only):**
- `POST https://api.hyperliquid-testnet.xyz/info` with types `outcomeMeta`, `outcomeTemplates`, `allMids`, `meta`, `metaAndAssetCtxs`, `spotMeta`, `l2Book`, `recentTrades`, `spotClearinghouseState`, `frontendOpenOrders`, `historicalOrders`, `userFills`, `settledOutcome`, `extraAgents`, `userRole`, `userRateLimit`, `userAbstraction`, `userFees`, `exchangeStatus`, `perpDexs`.
- Same probes against mainnet `/info` for comparison.
- `wss://api.hyperliquid-testnet.xyz/ws` subscriptions: `l2Book`, `l2`, `bbo`, `trades`, `webData2` (rejected), `webData3`, `clearinghouseState`, `spotState`, `orderUpdates`, `userFills`, `userEvents`, `outcomeMetaUpdates`, `activeAssetCtx`, `fastAssetCtxs`, `allMids`, `ping`.
- Third-party testnet addresses observed in public trade data were used only to inspect response shapes. They are not recorded here.
