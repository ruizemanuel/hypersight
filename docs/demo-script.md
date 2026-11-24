# Demo script (≤ 3:00)

Recorded from the Even Hub simulator (glasses view) with the phone companion beside it, on Hyperliquid testnet. Captions in brackets; voice lines in quotes.

| Time | Scene | What the viewer sees |
|---|---|---|
| 0:00 | **The problem** | Someone on a call with a position open, unlocking the phone again and again. [You check one number dozens of times a session.] |
| 0:15 | **Glance** | Glasses deck: Account card (equity, open PnL), ETH LONG card (size, PnL, liquidation), BTC daily odds. Swipe through. [One card, one number.] |
| 0:40 | **Moment 1 — your rule fires** | Alert card *"ETH +5.5% · your rule: take half"* → TAP → confirm *"CLOSE 50% ETH LONG"* → TAP → *"Filled"*. Companion History shows the entry. [Suggestions only come from rules you wrote.] |
| 1:20 | **Moment 2 — say it** | HOLD → *"sell half my Hawks"* → live transcript → confirm card with shares and proceeds → TAP → result. [Voice → filled in about two seconds.] |
| 1:55 | **Moment 3 — macro odds** | *"What are the odds on the Fed?"* → odds result → *"buy twenty dollars of no change"* → confirm → TAP → *"Filled"*. Then *"¿cuánto gano?"* → PnL. [Perps and prediction markets, English or Spanish.] |
| 2:25 | **Safety** | Pairing: code on the glasses → `/link` page → wallet approves a trade-only agent. Companion risk limits, Mode info card *"Agent cannot withdraw funds"*, menu *Cancel orders*. [Testnet only · agent can't withdraw · caps on every order · confirm every write.] |
| 2:45 | **How it's built** | Architecture diagram from the README; test and e2e run. Close on the deck. [HyperSight · github.com/ruizemanuel/hypersight] |

## Recording checklist

- Server with `EXECUTOR=testnet` (real testnet fills) or `HL_FIXTURES=1 EXECUTOR=fake` for a repeatable take; HUD dev server; `evenhub-simulator --automation-port 9898 --aid <mic> http://localhost:5173`.
- Before moment 1: a PnL rule with "take half" on ETH from the companion, and an ETH long open.
- Before moment 2: a YES position on a sports market in the watchlist.
- Before moment 3: the Fed market (*June Fed rate change*) in the watchlist — it has no expiry, so voice only finds it when watched. Its sides are *Change* / *No Change*: say a side name; *"yes"* there is not a side and goes to the slower Claude fallback. Server with `VOICE_LANG=multi` for *"¿cuánto gano?"*.
- Keep each confirm under 15 s (the card expires and says so).
- Glasses frames: `node scripts/sim.mjs shot <file>`; phone frames: `curl http://127.0.0.1:9898/api/screenshot/webview -o <file>`.
