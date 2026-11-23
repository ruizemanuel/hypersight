# HyperSight

A Hyperliquid **testnet** copilot for Even Realities G2 smart glasses: glance at one number, act with one tap or a short voice phrase, always behind a confirm card. Covers perpetuals and HIP-4 outcome (prediction) markets.

> Testnet only. The trading key is a Hyperliquid API (agent) wallet that can place and cancel orders but can never withdraw funds. Hard risk limits apply to every order. Nothing here is financial advice.

Status: under construction for the *Heads Up: Even Realities* hackathon (Track 02 · Crypto & DeFi), Nov 23–29, 2026.

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | Shared zod schemas for the WebSocket protocol, cards and intents |
| `apps/server` | Node server: Hyperliquid data and execution, speech-to-text, intent parsing, risk, alerts |
| `apps/hud` | Even Hub plugin (web app rendered on the glasses) |
| `docs/research/` | Hyperliquid, Even Hub SDK and speech-to-text research notes and spike results |

## Development

Requires Node 24 and pnpm 12.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## Built during the hackathon

- **Before Nov 23, 2026 (allowed preparation, no product code):** API research notes in `docs/research/` and throwaway spikes whose conclusions are recorded in `docs/research/spike-results-2026-11-20.md` (their code is not in this repository).
- **From Nov 23, 2026:** all code in this repository.
- Third-party open-source libraries are used as declared in each `package.json`; the HUD starts from the official Even Hub minimal template.
