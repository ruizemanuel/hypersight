# Feature requests

Five things that would make HyperSight (and apps like it) better, found while building it.

## Hyperliquid

### 1. Scoped agent permissions

API (agent) wallets already cannot withdraw, which is what makes a glasses app safe to try. A leaked agent key can still trade the account into losses (for example by crossing an attacker's quotes on a thin outcome book). Let the master attach limits to an agent at approval time: maximum notional per order and per day, allowed assets, reduce-only. HyperSight enforces these on its own server today; enforcing them on the exchange would protect users from any buggy or compromised client.

### 2. Human-readable titles and asset ids in `outcomeMeta`

HIP-4 outcomes arrive as encoded descriptions (`class:priceBinary|underlying:BTC|expiry:20261125-0300|targetPrice:61509|period:1d`) plus templates, and the tradable asset id has to be computed (`100000000 + 10 × outcome + side`). Every client re-implements the same parser to show "BTC above 61,509 at Nov 25 03:00 UTC?". Shipping a display title, a short title and the side asset ids with each outcome would remove a whole class of bugs.

## Even Hub

### 3. Background notifications for plugins

Alerts are the reason to wear a trading copilot, but a plugin only runs while it is open. A way for a plugin's server to push a short notification card to the glasses (with the user's permission and rate limits), opening the plugin on tap, would make rule-based alerts work all day.

### 4. Built-in speech-to-text

Every voice plugin streams PCM to its own provider and pays for it. A platform speech-to-text API (push-to-talk, partial and final transcripts, a hint list for domain words like tickers) would make voice the default input for small plugins and keep audio off third-party servers.

### 5. Check-mark and cross glyphs in the firmware font

`✓ ✔ ✕ ✗ ☐ ☑` are missing from the firmware font, so confirmations and results fall back to words (`DONE`, `NOT EXECUTED`). Status glyphs are the most compact way to say "it worked" on a 576×288 display.
