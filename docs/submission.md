# HyperSight — DoraHacks submission

**Tracks:** Crypto & DeFi · Messaging & News (Telegram + Hyperliquid in one flow) · Special prize: Best Telegram integration

**One line:** Glance at the one number that matters, act on it with one tap: a Hyperliquid testnet copilot for Even Realities G2 glasses, for perps and prediction markets.

**Demo video (2 min):** https://youtu.be/oTGkwU4cZ1o

## The problem

People holding positions on Hyperliquid are rarely at a trading screen when it matters. They unlock the phone dozens of times a session to check one number (a PnL, the odds of the game they bet on, how far they are from liquidation) and fumble through an exchange UI to act on it.

## Who it is for

Traders with open perps or HIP-4 outcome positions who are on the move: on a call, walking, cooking, watching the game their position is about.

## How it works

- **Glance:** the glasses show one card per idea (account, each position, each watched market) with the key number first.
- **Act:** every card has one-tap actions with presets (close 50%, buy YES $5). Anything else is a short phrase (*"close half my ETH"*, *"buy twenty dollars of yes on bitcoin"*, also in Spanish). Every write goes through a confirm card priced from the live book, with a 15-second deadline and a price re-check at tap time.
- **Alerts from your own rules:** PnL thresholds with a suggested action ("your rule: take half"), odds moves, liquidation distance, fills, stops hit, settled markets.
- **Telegram signals:** add the bot to your trading group and follow it from the phone. A call like *"longing ETH here"* reaches the glasses as an alert with the trade proposed at your preset size; tap, confirm, filled, and the bot can reply to the call with the fill.
- **Phone companion:** watchlist, quick-action presets, risk limits, alert rules, Telegram chats, history of every order.
- **Real execution:** signed orders on Hyperliquid testnet through an agent wallet; tap → filled in about two seconds.

## Safety

The trading key is a Hyperliquid agent wallet: it can trade but can never withdraw. With device pairing the glasses show a code, the user approves a fresh agent from their own wallet on a web page, and the server verifies the approval on Hyperliquid before trading. Agent keys are encrypted at rest. Hard limits apply to every order ($250 per order, $2,000 per day, 5× leverage, allowed coins, slippage caps, one write per 2 s), the server refuses any non-testnet URL, and *Cancel orders* is always one menu tap away. Suggestions only come from rules the user wrote or chats the user chose to follow; a chat message never sets the size or leverage, and no trade runs without a confirm on the glasses.

## Try it

- **Watch:** the demo video above; every trade in it is real, on Hyperliquid testnet.
- **Glasses package:** `hypersight.ehpk` (attached, also on the GitHub v1.0.0 release) connects to the hosted testnet server at hypersight.fly.dev. One server serves one Hyperliquid account and the hosted one is tied to my testnet account, so to trade from your own account run the server yourself (five steps in the README).
- **No keys needed:** `pnpm e2e` runs the whole stack against captured market data with a fake executor and drives the Even Hub simulator through deck → actions → confirm → result.

## Business model

Free on testnet. On mainnet the natural model is a Hyperliquid builder code: the user approves a small builder fee once, on the same wallet page that approves the agent, and the app earns a fraction of each order it routes, with no custody and no subscription. Not part of this testnet build.

## Built with

Even Hub SDK 0.0.16 · TypeScript · Node 24 · Hyperliquid API (`@nktkas/hyperliquid`) · ElevenLabs Scribe v2 Realtime · Claude (intent fallback) · Telegram Bot API · SQLite (`node:sqlite`) · Hono · viem · Vitest (800+ tests) and a simulator end-to-end test.

## Links

- Code: https://github.com/ruizemanuel/hypersight
- Demo video: https://youtu.be/oTGkwU4cZ1o
- Plugin package: `hypersight.ehpk` (attached; also on the release: https://github.com/ruizemanuel/hypersight/releases/tag/v1.0.0)
