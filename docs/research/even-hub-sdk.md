# Even Hub SDK: technical reference for building a G2 app

Research date: 2026-11-19. This is research only. No app code or scaffold exists yet.

## How to read this

- **[OFFICIAL]** means the official docs at `https://hub.evenrealities.com/docs/...`, the published npm packages, or Even Realities' GitHub repos (`even-realities/everything-evenhub`, `even-realities/evenhub-templates`).
- **[SDK d.ts]** means the TypeScript definitions shipped inside `@evenrealities/even_hub_sdk@0.0.16` (`dist/index.d.ts`) plus its `README.md`. The docs page *Device APIs* calls these definitions "the authoritative source".
- **[COMMUNITY]** means `nickustinov/even-g2-notes`, `aleapc/even-hub-devguide`, `fabioglimb/even-toolkit` or `JustinasLa/evenhub-app-ui`. These are not affiliated with Even Realities. Most of them are reverse-engineered or based on what their authors measured.
- **UNKNOWN** means no source answers the question. Nothing in this document was filled in from memory.
- **INFERENCE** means I derived the value from source data, for example by computing it from the font metrics table. It has not been measured on hardware.

When sources disagree, the conflict is recorded inline and collected again in §10.

### Source snapshot

| Source | Version or commit read |
|---|---|
| Official docs (VitePress, 36 pages fetched) | Pages dated 2026-06-04 to 2026-11-10 |
| `@evenrealities/even_hub_sdk` | **0.0.16** (npm `latest`, 2026-09-24). Package metadata has `"minAppVersion": "2.2.10"` |
| `@evenrealities/evenhub-cli` | **0.2.0** (2026-10-20) |
| `@evenrealities/evenhub-simulator` | **0.9.5** (2026-09-01) |
| `@evenrealities/pretext` | **0.1.4** |
| `even-realities/everything-evenhub` | commit `cb8321f` (2026-10-21), 13 skills. Its `sdk-reference` skill still says "Current version: 0.0.12". |
| `even-realities/evenhub-templates` | commit `8cb0135` (2026-08-07). Its templates pin SDK `^0.0.10`, CLI `^0.1.12` and simulator `^0.7.2`, so they are stale. |
| `nickustinov/even-g2-notes` | commit `227c866` (2026-07-31). Measurements were made on firmware 2.2.7.14, Even App 2.2.7 and SDK 0.0.13. |
| `aleapc/even-hub-devguide` | commit `de51eb4` (2026-04-21). Written against **SDK 0.0.9**, so it is the oldest and least reliable source. |
| `fabioglimb/even-toolkit` | v1.7.8, commit `0e5408a` |
| `JustinasLa/evenhub-app-ui` | HEAD at clone time |

---

## 0. Architecture in one screen

```
[Your web app: HTML/CSS/TS] <-> EvenAppBridge (SDK, in WebView) <-> Even Realities App (Flutter host) <-BLE 5.2-> G2 glasses (display + input)
                                                                                                     <-BLE-> R1 ring (separate BLE device)
```

- The phone runs the Even Realities App, which is written in Flutter. It hosts the plugin in a WebView: **Chromium on Android, WKWebView on iOS**. All app logic runs in that WebView. The glasses only render containers and send back input. Apart from native scrolling, no app code runs on the glasses. [OFFICIAL `/docs/get-started/architecture`]
- In the Web → Glasses direction, `bridge.callEvenApp(method, params)` goes to `window.flutter_inappwebview.callHandler('evenAppMessage', ...)`, then to the Flutter app, then over BLE to the glasses. The promise resolves with the host's return value. [OFFICIAL architecture; SDK d.ts `postMessage` doc comment]
- In the Glasses → Web direction, the host calls `window._listenEvenAppMessage(...)`. The SDK parses the message and dispatches it to your `on*` callbacks. [OFFICIAL architecture; SDK d.ts `init` doc comment]
- Wire message types: `EvenAppMessageType.CallEvenAppMethod = "call_even_app_method"` and `EvenAppMessageType.ListenEvenAppNotify = "listen_even_app_data"`. DOM event names (`BridgeEvent`): `evenAppBridgeReady`, `deviceStatusChanged`, `evenHubEvent`, `evenAppLaunchSource`, `appLocationChanged`. [SDK d.ts]
- Only one surface is live today: **plugins**. Dashboard widgets, dashboard layouts and AI skills are listed as "coming". [OFFICIAL `/docs/get-started/overview`]
- A PWA is an option if you want to stay outside Even Hub distribution entirely. [OFFICIAL architecture]
- Hardware: dual micro-LED displays (one per lens) at 576×288 px per eye, monochrome green with 16 levels. A 4-mic array delivers a single 16 kHz PCM stream. There are touchpads on both temples. Connectivity is BLE 5.2. The optional R1 ring has the same gestures. There is no camera, no speaker and no haptics. [OFFICIAL overview; FAQ "Can I trigger haptics? No. No haptic actuator."]
- Both eyes show one canvas. The SDK has no per-eye addressing, and the two displays are "synced via physical FPC". [COMMUNITY even-g2-notes `architecture.md`] Rendering different content per eye is UNKNOWN and probably impossible.
- **UNKNOWN:** whether a third-party plugin's display is always visible or only when the user tilts their head up. The phone app has a "HeadUp Display angle" setting (0–60°, default 25°) [COMMUNITY evenhub-app-ui `references/app-guidelines.md`], but no source explains how it interacts with plugins.

---

## 1. npm packages, versions, CLI and simulator

### Packages

| Package | Role | Install | Current |
|---|---|---|---|
| `@evenrealities/even_hub_sdk` | Bridge SDK. Project dependency, ESM-first, ships types. Needs Node `^20 \|\| >=22` for builds. | `npm install @evenrealities/even_hub_sdk@latest` | 0.0.16 (needs Even App ≥ 2.2.10) |
| `@evenrealities/evenhub-cli` | CLI with binaries `evenhub` and `eh` | `npm install -g @evenrealities/evenhub-cli` (or `-D` plus `npx evenhub`) | 0.2.0 (Node 20.17+, 22.13+ or 23.5+) |
| `@evenrealities/evenhub-simulator` | Desktop simulator (Rust + LVGL + webview; native binaries ship per platform, including `sim-win32-x64`) | `npm install -g @evenrealities/evenhub-simulator` | 0.9.5 |
| `@evenrealities/pretext` | Pixel-accurate text measurement that matches the LVGL firmware font | `npm install @evenrealities/pretext` | 0.1.4 |

Sources: npm registry (`npm view`), [OFFICIAL `/docs/get-started/quickstart/install-tools`, `/docs/reference/changelog`].

**SDK version history** (from the SDK README changelog):

| Version | Changes |
|---|---|
| 0.0.8 | Launch source events. Container limit raised from 4 to 12. IMU. |
| 0.0.10 | "Enhanced WebView background keep-alive" |
| 0.0.11 | Location, album, camera, and the mic source parameter |
| 0.0.12 | `zOrderIndex`. LZ4 image compression. |
| 0.0.13 | `minAppVersion` metadata (2.2.6) |
| 0.0.14 | Contextual menu (`menuObject`), `LONG_PRESS_EVENT`/`LONG_PRESS_RELEASE_EVENT`, `textColor` 0–4, audio `direction`/`speakerRole`, 100 ms image pacing. Needs Even App 2.2.9. |
| 0.0.15 | Needs Even App 2.2.10. Long-press events keep `eventSource`. |
| 0.0.16 | "Fixed repeated execution of `setTimeout` / `setInterval` callbacks". `package.json` lists a side-effect module `./src/shadow-timers.ts`, so the SDK appears to wrap the global timers. Exactly how is UNKNOWN because the JS is obfuscated. |

### CLI commands (v0.2.0)

There is **no `dev` command and no `publish` command.** "Dev" means your own dev server (Vite) plus `evenhub qr`. Publishing to the store happens **in the portal only**. [OFFICIAL `/docs/cli/*`; CLI README; everything-evenhub `cli-reference` skill]

| Command | Purpose and key options |
|---|---|
| `evenhub login [-e email]` | Interactive. Prompts for a password, so it cannot be scripted. Saves credentials to `~/.config/evenhub/credentials.yaml` (`%APPDATA%` on Windows). The account must already exist; you create it in the phone app. |
| `evenhub logout` / `evenhub self-check` | `self-check` shows the account and role (`0` user, `1` developer, `42` admin). |
| `evenhub init [-d dir] [-o path]` | Writes a starter `app.json` with the SDK and app floors baked in. Exits `4` if the file already exists. No login needed. |
| `evenhub qr [-u url] [-i ip] [-p port] [--path p] [--http\|--https] [-e] [-s n] [--clear]` | Prints a QR code for the dev-server URL, which you scan from the phone. The IP is auto-detected and the parts are cached in `qr.yaml`. No login needed. |
| `evenhub pack <app.json> <dist> [-o out.ehpk] [--no-ignore] [-c] [--sdk-ver X] [--enforce-manual-version]` | Builds the `.ehpk`. No login needed. Stamps `min_app_version` from the SDK release's npm `minAppVersion`; **always pass `--sdk-ver` matching your installed SDK.** `-c` checks that the `package_id` is available. |
| `evenhub create <ehpk> --name --tagline [--description\|--description-file] [--icon icon.png]` | Creates the app and its first build, which starts as `Private`. |
| `evenhub upload <ehpk> -m "changelog"` | Uploads a new version. The changelog is required and capped at 500 characters. The version must be new. |
| `evenhub update ...` | Edits the listing of an unpublished app. A published app exits `7`. |
| `evenhub ls [pkg] [--channels] [--verbose]` | Lists apps, or builds for one app. |
| `evenhub promote <ver> --to beta` / `evenhub delist --from beta\|public` | Only beta works from the CLI. `--to public` is refused locally with exit `1`. |
| `evenhub testers [add a@x,b@y \| add --from file.csv \| rm email] [--reinvite]` | Each address can be invited at most 10 times per app and branch. Invitations expire after 7 days. |
| `evenhub rm <ver>` / `evenhub rm --app <pkg> --yes`, `evenhub download <ver> -o f.ehpk` | Removes a build or the whole app; downloads a build. |

- Exit codes: `0` ok, `1` usage, `2` not signed in, `3` not found, `4` exists, `5` pinned to a channel, `6` icon rejected, `7` needs review, `8` rate limit or cap, `9` local validation failed (server unchanged), `10` network, `11` partial write, `130` interrupted.
- `--json` works on every command and prints exactly one JSON object to stdout.
- Rate limit: **60 authenticated requests per minute per user.** [OFFICIAL `/docs/cli/scripting`; CLI README]

### Simulator

```bash
evenhub-simulator http://localhost:5173                       # positional [targetUrl] = your dev server
evenhub-simulator -g http://localhost:5173                    # glow effect
evenhub-simulator --automation-port 9898 http://localhost:5173
evenhub-simulator --list-audio-input-devices ; evenhub-simulator --aid <id> <url>   # pick the laptop mic for audioEvents
RUST_LOG=debug evenhub-simulator <url>                         # log every bridge call it receives
```

[OFFICIAL `/docs/test/simulator`; simulator README]

- The simulator loads your URL in its own webview, which you can inspect with right-click → Inspect Element. It plays the host role, emulating the bridge. Templates expose this as `"simulate": "evenhub-simulator http://localhost:5173"`.
- Window inputs: Up, Down, Click, Double Click, Long Press and Release (hold the control or use the keyboard shortcut), and the contextual menu. In the window, the menu opens with tap then long press. Clicking the display saves an RGBA PNG screenshot to the current directory.
- Audio: the simulator emits `audioEvent`s from a laptop mic at **16 kHz s16le mono, 100 ms per event (3200 bytes, 1600 samples)**.
- Automation API (`--automation-port`):

  | Endpoint | Purpose |
  |---|---|
  | `GET /api/ping` | Health check |
  | `GET /api/screenshot/glasses` | 576×288 RGBA PNG. A pixel is lit when alpha > 0. |
  | `GET /api/screenshot/webview` | Screenshot of the webview |
  | `GET /api/console[?since_id=N]` | Captured console output |
  | `DELETE /api/console` | Clears the console buffer |
  | `POST /api/input {"action":"up\|down\|click\|double_click\|long_press\|long_press_release\|context_menu"}` | Sends a touchpad action |

  Input is ignored until a container with `isEventCapture: 1` exists, so wait about 4 s after launch.
- Simulator limits:
  - Device status events are never emitted.
  - `eventSource` is always hard-coded to `1` (right temple).
  - `imuData` is always null.
  - Fonts and greyscale differ from the glasses.
  - Image size limits are not enforced, and LZ4 payloads are not decompressed.
  - List focus position can differ from the glasses.
  - Error handling differs from the glasses.
  - There is no background lifecycle.

  [OFFICIAL simulator page; everything-evenhub `test-with-simulator` skill]
- [COMMUNITY even-g2-notes `simulator.md`] reports that simulator 0.7.1 "rejects pages with more than 4 containers and does not support image containers larger than 200x100". That is probably stale now that 0.9.x exists. Verify it.

### Dev loop on a real device

[OFFICIAL `/docs/get-started/quickstart/hardware`, `/docs/test/local-testing`]

1. **Turn on Developer Mode.** There is no toggle. Sign in at `hub.evenrealities.com/login` with your phone-app account, force-quit the Even Realities App, and reopen it. A developer section with **Scan QR** appears at the top right of the **Even Hub** tab.
2. Run `npm run dev`. The templates use Vite `server: { host: true, port: 5173 }`. Then run `evenhub qr --url "http://<LAN-IP>:5173"` and scan the code from the phone. HMR works.
3. Pin `server.hmr.host` to the LAN IP so the phone's HMR connection doesn't try to reach `localhost`.
4. Typical network blockers:
   - Windows Defender blocking inbound connections: add an inbound TCP rule for port 5173 on the Private profile.
   - The macOS firewall.
   - Wi-Fi AP isolation. Fall back to a phone hotspot or Tailscale.
5. QR sideloading **stops working as soon as the phone locks or the app backgrounds.** The HMR WebSocket dies and you usually have to re-scan.
6. On-device console: the phone app's Developer Mode console. Remote inspection also works: Safari → Develop on iOS, `chrome://inspect` on Android. [COMMUNITY devguide `dev-workflow.md`]

---

## 2. App lifecycle and bridge init

### Required call order

[OFFICIAL `/docs/build/page-lifecycle`; SDK README; everything-evenhub `sdk-reference` skill]

1. `const bridge = await waitForEvenAppBridge()` must come before every other call. `new EvenAppBridge()` has a private constructor. `EvenAppBridge.getInstance()` returns the singleton synchronously, but use it only after the bridge is ready. Calling SDK methods before the bridge is ready "silently no-ops". [OFFICIAL first-app]
2. Register `bridge.onLaunchSource(cb)` as early as possible. It fires **once** per page load with `'appMenu'` or `'glassesMenu'`, and a reload does not fire it again.
3. `await bridge.createStartUpPageContainer(...)` is called **exactly once** per session. It returns `StartUpPageCreateResult`: `0` success, `1` invalid, `2` oversize, `3` outOfMemory.
4. After that, everything else is allowed: `rebuildPageContainer`, `textContainerUpgrade`, `updateImageRawData`, `audioControl(true, Glasses)`, `imuControl`, and event listeners. **Glasses mic and IMU fail until startup has succeeded.** Phone mic, location, album and camera do not need the startup page.

```ts
// [OFFICIAL] /docs/get-started/quickstart/first-app (abridged)
import { waitForEvenAppBridge, TextContainerProperty, TextContainerUpgrade,
         CreateStartUpPageContainer, OsEventTypeList } from '@evenrealities/even_hub_sdk'
const bridge = await waitForEvenAppBridge()
const mainText = new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288,
  borderWidth: 0, borderColor: 5, paddingLength: 4, containerID: 1, containerName: 'main',
  content: 'Hello from G2!', isEventCapture: 1 })
const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainText] }))
if (result !== 0) console.error('createStartUpPageContainer failed:', result)
```

### Startup pitfalls

[COMMUNITY even-g2-notes `page-lifecycle.md`, `performance.md`]

- A second `createStartUpPageContainer` in the same session is rejected with `invalid` (1) after blocking for **about 2.1 s**. Input is effectively lost during that time.
- Set your "startup called" flag whether or not the call succeeded. After a failure, fall back to `rebuildPageContainer`. Reset the flag on exit.
- Guard against double initialisation, for example a boot path and a UI effect both calling init.
- Don't `await getAppLocation()` before the first paint; it took about 3 s on the device.
- Auto-connect on page load. Don't wait for a phone tap, because the phone is often in the user's pocket. [COMMUNITY even-g2-notes `architecture.md`]

### Page lifecycle methods

[OFFICIAL page-lifecycle; SDK d.ts]

| Method | Returns | Behaviour |
|---|---|---|
| `createStartUpPageContainer(CreateStartUpPageContainer)` | `Promise<StartUpPageCreateResult>` | Called once. Optional `menuObject`. |
| `rebuildPageContainer(RebuildPageContainer)` | `Promise<boolean>` | Replaces the whole page. Scroll and list state are lost. Brief flicker on hardware. Leaving out `menuObject` clears the custom menu. |
| `textContainerUpgrade(TextContainerUpgrade)` | `Promise<boolean>` | In-place text update with no flicker. `containerID` and `containerName` must match exactly, otherwise the call silently no-ops. |
| `updateImageRawData(ImageRawDataUpdate)` | `Promise<ImageRawDataUpdateResult>` | Serial only. |
| `shutDownPageContainer(exitMode?)` | `Promise<boolean>` | `0` exits immediately. `1` shows the system exit-confirmation dialog. |
| `callEvenApp(method, params?)` | `Promise<any>` | Escape hatch. `EvenAppMethod` values are the native method names, for example `'getGlassesInfo'`. |

### Exit and the review rule

- **The root page must call `shutDownPageContainer(1)` on double-tap.** Apps that use `0`, a custom exit UI or nothing on the root page are rejected. Non-root pages should treat double-tap as "back". [OFFICIAL `/docs/ship/app-submission`, page-lifecycle]
- After the user confirms exit, the phone-side WebView must close automatically. A WebView left open is a rejection. [OFFICIAL app-submission]
- Don't clean up before calling `shutDownPageContainer(1)`, because the user can cancel. Clean up on `SYSTEM_EXIT_EVENT` (7) or `ABNORMAL_EXIT_EVENT` (6). [OFFICIAL everything-evenhub `handle-input`; templates]
- [COMMUNITY even-g2-notes `page-lifecycle.md`] Two observations around the exit dialog:
  - The event sequence is inverted: `FOREGROUND_ENTER` (4) fires when the dialog appears, `FOREGROUND_EXIT` (5) when the user answers "No", and `SYSTEM_EXIT` (7) when they answer "Yes". Set a flag synchronously when you call `shutDownPageContainer(1)`.
  - On firmware 2.2.7.14, Even App 2.2.7 and SDK 0.0.13, after the dialog is shown and dismissed, every `updateImageRawData` returns `sendFailed` within 1–3 ms until the app restarts. The workaround in EvenChess: root double-tap opens an in-app menu, and its "Exit" item calls `shutDownPageContainer(1)`. The official docs list that pattern as acceptable (the "Chess" reference pattern).

### What happens when the user switches away, backgrounds or locks

| Situation | What happens | Source |
|---|---|---|
| iOS (WKWebView) backgrounded | The WebView keeps running and in-memory state survives. | [OFFICIAL `/docs/build/background-lifecycle`] |
| Android (Chromium) backgrounded | The WebView may be suspended under memory pressure. If the process is reclaimed, in-memory state is gone. Treat it as a cold start. | [OFFICIAL background-lifecycle] |
| Suspended WebView | `audioControl` capture stops, `startAppLocationUpdates` stops, WebSockets usually drop on Android, and in-flight `fetch` stalls. Re-arm everything on foreground. | [OFFICIAL background-lifecycle, FAQ] |
| User leaves your app on the glasses, or something overlays it | `sysEvent.eventType === FOREGROUND_EXIT_EVENT (5)`, then `FOREGROUND_ENTER_EVENT (4)` when the user returns. | [OFFICIAL handle-input skill, SDK enum] |
| **Contextual menu opens or closes** | `FOREGROUND_ENTER (4)` → `menuItemClickEvent` → `FOREGROUND_EXIT (5)`. This "exit" means only that the overlay closed; your page is still mounted. Make foreground handlers idempotent. | [OFFICIAL `/docs/build/contextual-menu`] |
| Timers while backgrounded | JS keeps running, but render calls are silently dropped. | [COMMUNITY devguide `sdk-quirks.md` #14; note it mislabels 4 and 5] |
| Host background strategy | Headless-WebView migration: on `inactive` the host snapshots `window.__getStateSnapshot()`, on `paused` it starts a `HeadlessInAppWebView` with the same URL plus `__restoreState(snapshot)`, and on `resumed` the snapshot is injected back into the foreground WebView. The skill describes the API as `setBackgroundState(key, () => obj)` and `onBackgroundRestore(key, saved => ...)`. **WARNING: neither function appears in the SDK 0.0.16 `index.d.ts` exports, so treat this as UNVERIFIED.** Plan to persist state yourself. | [OFFICIAL everything-evenhub `background-state` skill] versus [SDK d.ts] |
| Review gate | With a beta build, lock the phone for 5 minutes, then unlock: state must be preserved, with no spinner and no black screen. After 2 minutes idle the app must still respond. With the phone locked, the core flow must run end-to-end using only glasses and ring input. Timers must complete while the phone is locked. | [OFFICIAL app-submission, beta-testing] |
| Background launch, push, schedules | Not possible. Plugins are foreground-only, and there are no push notifications. The workaround is a separate native companion app that schedules OS notifications, which the Even app forwards to the glasses. | [OFFICIAL FAQ; COMMUNITY devguide `mobile-companion.md`] |

**UNKNOWN:** whether, when the app is launched from the glasses menu, the WebView exists and is visible on the phone (as opposed to headless).

---

## 3. Display model

### Canvas and containers

[OFFICIAL `/docs/build/display`; SDK d.ts; everything-evenhub `glasses-ui` skill]

- The canvas is 576×288 with the origin at the top left. Colour is 4-bit greyscale shown as 16 levels of green: white is bright green, and black is *off*, meaning transparent (the real world shows through). There is no background or fill property; the only decoration is a border.
- Per page there are **at most 12 containers**: `textObject` up to 8 and `imageObject` up to 4, with a stated rule of "4 image + 8 other". `containerTotalNum` must be 1–12 and must equal the actual count. The maximum number of list containers in the public SDK is UNKNOWN; the enterprise docs say `listObjects` can have up to 4. [OFFICIAL `/docs/enterprise/evenhub`]
- **Exactly one** container has `isEventCapture: 1`. Image containers cannot capture events.
- `containerID` must be unique per page. The enterprise docs add that it must be non-zero. `containerName` must be unique and at most 16 characters; the firmware-level enterprise docs say 1–15 bytes, **so keep names ≤15 ASCII characters.**
- `zOrderIndex` (0.0.12+) is all-or-nothing per page, must be unique, and larger values render in front. If you omit it everywhere, later declarations render on top. A violation means `createStartUpPageContainer` returns `invalid` and `rebuildPageContainer` returns `false`. Validators exported by the SDK: `validateEvenHubPageContainer`, `validateEvenHubPageContainerZOrder`, `validateEvenHubPageContainerMenu`, `validateEvenHubPageContainerTextBrightness` and `formatEvenHubPageContainerValidationError`.
- [COMMUNITY devguide `sdk-quirks.md` #10, SDK 0.0.9 era] claims "more than 4 containers degrades reliability". even-g2-notes' demo app uses 4 images plus 8 others. Assume 12 works, but test it.

### Shared container fields

All fields are optional in the constructors (`Partial<T>`).

| Field | Range | Notes |
|---|---|---|
| `xPosition`, `yPosition` | 0–576, 0–288 | |
| `width`, `height` | 0–576, 0–288 | Image containers: width 20–288, height 20–144 |
| `borderWidth` | 0–5 | Text and list containers only |
| `borderColor` | 0–15 (text docs say 0–16) | Text and list only. 5 is a subtle grey, 13 is bright. Simulator default is `0`. |
| `borderRadius` | 0–10 | Text and list only |
| `paddingLength` | 0–32 | Uniform on all sides. Text and list only. |
| `isEventCapture` | 0 or 1 | |
| `zOrderIndex` | number | |

Padding and border both reduce the text area: **inner = size − 2·(padding + border)**. [OFFICIAL font-measurement skill]

### Text containers (`TextContainerProperty`)

- Plain text, left-aligned and top-aligned. No alignment options, no font size, no bold or italic. To centre text, pad it with spaces. `\n` breaks a line. Text wraps at the container width.
- `textColor` is a brightness level from **0 to 4** (0.0.14+). Default `4` on create and rebuild. If you omit it on upgrade, the current level is kept. Level `0` may be effectively invisible. Values outside 0–4 fail locally with `INVALID_TEXT_BRIGHTNESS`.
- **Content limits:**

  | Call | Documented limit | Firmware-level limit | Safe budget |
  |---|---|---|---|
  | `createStartUpPageContainer` | 1000 characters | 999 bytes | ≤999 UTF-8 bytes |
  | `rebuildPageContainer` | 1000 characters | 999 bytes | ≤999 UTF-8 bytes |
  | `textContainerUpgrade` | 2000 characters | 1999 bytes | ≤1999 UTF-8 bytes |

  Firmware-level figures come from the simulator ("text container bytes limit to 999") and the enterprise docs (`content` up to 999 bytes; `updateText` up to 1999 bytes). Budget in bytes, because CJK characters and box-drawing glyphs take 3 bytes each.
- Overflow: if the content is taller than the container **and** the container has `isEventCapture: 1`, the firmware scrolls it internally and shows a scrollbar. Otherwise the overflow is clipped. A trailing `\n` can push content past the height and trigger an unwanted scrollbar. [COMMUNITY even-g2-notes `display.md`]
- There is **no API to read or set the scroll position**.
- `TextContainerUpgrade` fields: `{ containerID, containerName, contentOffset?, contentLength?, content, textColor? }`. Use offset and length to replace part of the string. The templates usually pass `content` alone for a full replacement; the skill suggests `contentOffset: 0, contentLength: 0`.

### Fitting text into 576×288

[OFFICIAL font-measurement skill; `@evenrealities/pretext` README; templates `text-heavy/src/paginate.ts`]

- There is a single LVGL font baked into the firmware. It is **proportional, not monospaced**. Missing glyphs are silently dropped. Simulator 0.7.0+ notes firmware placeholder handling; even-g2-notes says nothing is shown.
- **Line height is a fixed 27 px.** A full-height container with padding 4 has an inner height of 280, so floor(280/27) gives **10 lines**.
- List items are 40 px tall with 12 px horizontal padding per side. [OFFICIAL font-measurement skill] This conflicts with even-g2-notes, which says "item height = containerHeight/itemCount".
- **Measuring text:** use `@evenrealities/pretext` rather than estimates.

  | Function | Returns |
  |---|---|
  | `getTextWidth(text)` | Width in px, with kerning |
  | `measureTextWrap(text, innerWidth)` | `{ lineCount, height: lineCount*27, lineWidths[] }` |
  | `pxTruncate(text, maxPx)` | The text, cut to fit and ending in `'...'` |
  | `getAdvW(cp)` | Advance width in 1/16 px |

  Font fallback chain: `evenroster` → `evenroster_crylgrek` → `cn` → `evenemoji`.
- Rules of thumb:
  - The docs say ~400–500 characters fill a full-screen container.
  - The ASR template trims its transcript to the last **240** characters.
  - **INFERENCE** from pretext's glyph table: Latin lowercase is mostly 11–12 px (i and l are 4 px, m and w are 16 px), the space is 5 px, digits are about 12 px, and the frequency-weighted average for English prose is about **9.2 px per character**. That gives **about 60 characters per 552–568 px line** and roughly 450–600 characters per screen after word-wrap losses.
  - CJK, box-drawing and geometric glyphs (`━ ─ █ ▲ ● ■ ★ │ ╭`, fullwidth forms) come from the `cn` font at a **fixed 20 px** each, so about 28 fit on a full line.
  - The README's own examples ("Hello, world!" = 79) don't match the shipped table, which sums to 106 without kerning. **Measure at runtime; never hard-code these numbers.**
- Monospace workaround for grids: use fullwidth characters (ASCII + `0xFEE0`) and `　` (ideographic space) for empty cells. [COMMUNITY even-g2-notes]
- Unicode coverage:
  - Present: ASCII except `` ` `` and possibly `$` (pretext maps `$` to the second font); Latin-1 except `¨ ¯ ´ µ ¸`; the arrows `← ↑ → ↓ ↔ ↕ ↖ ↗ ↘ ↙ ⇒ ⇔`; most single and heavy box-drawing; the blocks `▁–█ ▉–▏ ▒`; selected geometric shapes `■ □ ▲ △ ▶ ▷ ▼ ▽ ◀ ◁ ◆ ◇ ● ○ ◎ ◢ ◣ ◤ ◥`; `★ ☆ ♠ ♣ ♥ ♡`; super- and subscript digits; `© ® ™ ° ∞`; and CJK.
  - Missing: `✓ ✔ ✕ ✗ ☐ ☑`, the Miscellaneous Technical block (`⏱ ⌖`), dingbats, `▀ ▐ ░ ▓`, quadrants and `♦`. The official skill's card-suit list includes `♦`, but pretext has no glyph for it.
  - [COMMUNITY even-g2-notes, tested on an early simulator; cross-checked with pretext ranges]
- **Emoji conflict:** the official FAQ says "Can I render emoji? No". pretext's fallback chain, however, includes an `evenemoji` font with **102 glyphs** (😀😂😊👍👋❤🔥✅✨💯🎉🙏 and others), and simulator 0.7.2 "improved emoji rendering". Treat emoji as UNVERIFIED and avoid them.

### List containers (`ListContainerProperty` + `ListItemContainerProperty`)

- `itemContainer: { itemCount 1–20, itemWidth (0 = auto), isItemSelectBorderEn 0|1, itemName: string[] }`. Each name can be 64 characters (firmware: 63 bytes), and `itemCount` must equal `itemName.length`.
- The firmware handles scrolling and the highlight natively. There is no per-item styling, no row-height control and no separators. Items are a single line of plain text. **You cannot update a list in place;** rebuild the page. A rebuild loses the selection.
- Example: [COMMUNITY even-g2-notes] `new ListContainerProperty({ x 0, y 0, w 576, h 288, borderWidth 1, borderColor 13, borderRadius 6, paddingLength 5, containerID 1, containerName 'my-list', isEventCapture 1, itemContainer: new ListItemContainerProperty({ itemCount 5, itemWidth 560, isItemSelectBorderEn 1, itemName: [...] }) })`.

### Image containers (`ImageContainerProperty`)

- Width 20–288 and height 20–144, at most 4 per page. No border and no event capture.
- An image container is a **placeholder** until you call `updateImageRawData`. You cannot send image data during `createStartUpPageContainer`.
- Covering the full canvas takes a 2×2 grid of 288×144 containers.
- `ImageRawDataUpdate { containerID, containerName, imageData: number[] | string(base64) | Uint8Array | ArrayBuffer }`. The SDK converts typed arrays to `number[]` and applies LZ4 internally (0.0.12+).
- **Accepted formats.** The sources disagree:
  - The official image template, the sample PNG and even-g2-notes send **encoded PNG or JPEG bytes**; the host decodes them and converts to gray4.
  - Simulator 0.9.2 also accepts "raw Gray8 and packed Gray4".
  - Simulator 0.9.3 matches the glasses' "cover resizing and center cropping when image and container dimensions differ".
  - even-g2-notes says image data smaller than the container gets *tiled*.
  - The SDK README example shows `/* grayscale bytes */`.
  - **Practical advice:** send a PNG at exactly the container size, greyscale, on a black background.
- Preprocessing:
  - The official template says dithering is optional; for photos, a contrast boost plus Floyd–Steinberg can help.
  - even-g2-notes advises *against* 1-bit dithering and recommends BT.601 luminance → PNG.
  - devguide (SDK 0.0.9 era) says 24-bit RGBA PNGs from `canvas.toDataURL` were silently rejected and recommends `upng-js` 16-colour indexed PNGs. This may be fixed now; verify.
- Results:

  | Value | Meaning |
  |---|---|
  | `success` | Means the host accepted the data, **not** that the pixels are lit |
  | `imageException` | Generic image processing error |
  | `imageSizeInvalid` | Image size doesn't match the container |
  | `imageToGray4Failed` | Greyscale conversion failed |
  | `sendFailed` | Transport error |

- Size: devguide claims more than ~200×100 fails on hardware (SDK 0.0.9). even-g2-notes measured up to 272×130 working on SDK 0.0.13. The enterprise docs allow up to 1 MB of data per image.
- **`min_app_version` trap:** SDK 0.0.12–0.0.13 image sends were broken on Even App versions below 2.2.7. [COMMUNITY] This no longer matters now that 0.0.16 forces Even App ≥ 2.2.10.

### Updating efficiently: measured costs

[COMMUNITY even-g2-notes `performance.md`, firmware 2.2.7.14; OFFICIAL display/FAQ]

| Call | Cost |
|---|---|
| `textContainerUpgrade` | **~83 ms** per call |
| `rebuildPageContainer` | **~165 ms**, flat regardless of how many containers |
| `createStartUpPageContainer` | ~100–135 ms |
| `updateImageRawData` | **~104 ms fixed + ~3.9 ms per KB of gray4** (w·h/2 bytes). A 288×144 image is about 185 ms; the official docs quote a full-screen image refresh at **~800 ms** after the pipeline rework. |
| Image pacing (0.0.14+) | **100 ms hold**: a call that arrives inside the window is held and flushed with the next one. [OFFICIAL] |

Consequences:

- Fewer calls beats smaller payloads.
- Updating 1–2 text containers is cheaper as upgrades; updating 3 or more is cheaper as one rebuild.
- Merge images into one container where they fit inside 288×144.
- Image "animation" tops out at about 9.5 fps for one container and drops to about 2.3 fps across four. The official docs describe it as turn-based; it is not video.
- Text is the fast path for anything that has to feel instant.
- **Serialise every bridge call** through one promise queue. Concurrent image sends lock up the bridge, and concurrent render and storage calls can crash the connection.
- Add a timeout of a few seconds to each call, because a flaky BLE hop can hang for about 30 s. [OFFICIAL glasses-ui skill]
- Debounce live text. The ASR template uses 120 ms, because "the BLE queue can't keep up with per-token writes".
- devguide: wait about 100 ms between `rebuildPageContainer` and the first `updateImageRawData` (SDK 0.0.9).

---

## 4. Input events

### Gestures and sources

- On both the G2 temples and the R1 ring: **press, double press, swipe up, swipe down, and long press with release**. [OFFICIAL overview, `/docs/build/device-apis`]
- Tap then long press is **reserved by the OS** for the contextual menu.
- The R1 is a separate BLE device that you pair in the app under Devices → Add device → Even R1.
- IMU: `imuControl(true, ImuReportPace.P100…P1000)`. Samples arrive on `sysEvent` with `eventType 8` and `imuData {x, y, z}` as floats. The pace values are "protocol pacing codes, not literal Hz". The skill interprets them as milliseconds (P100 = 10 Hz). Units are UNKNOWN; the FAQ says "units table TBD".

### `OsEventTypeList`

[SDK d.ts]

| Value | Name | Value | Name |
|---|---|---|---|
| 0 | `CLICK_EVENT` | 6 | `ABNORMAL_EXIT_EVENT` |
| 1 | `SCROLL_TOP_EVENT` | 7 | `SYSTEM_EXIT_EVENT` |
| 2 | `SCROLL_BOTTOM_EVENT` | 8 | `IMU_DATA_REPORT` |
| 3 | `DOUBLE_CLICK_EVENT` | 9 | `LONG_PRESS_EVENT` (0.0.14+, Even App 2.2.9+) |
| 4 | `FOREGROUND_ENTER_EVENT` | 10 | `LONG_PRESS_RELEASE_EVENT` |
| 5 | `FOREGROUND_EXIT_EVENT` | | |

`EventSourceType`: `0` TOUCH_EVENT_FORM_DUMMY_NULL, `1` TOUCH_EVENT_FROM_GLASSES_R, `2` TOUCH_EVENT_FROM_RING, `3` TOUCH_EVENT_FROM_GLASSES_L. It is carried on `sysEvent.eventSource`.

### Payload (`onEvenHubEvent(cb)` returns an unsubscribe function)

[SDK d.ts]

```ts
type EvenHubEvent = {
  listEvent?: { containerID?, containerName?, currentSelectItemName?, currentSelectItemIndex?, eventType? }
  textEvent?: { containerID?, containerName?, eventType? }
  sysEvent?:  { eventType?, eventSource?: EventSourceType, imuData?: {x?,y?,z?}, systemExitReasonCode? }
  audioEvent?: { audioPcm: Uint8Array, source: AudioInputSource, direction: number|null, speakerRole: AudioSpeakerRole }
  menuItemClickEvent?: { itemID?: number }   // 0.0.14+
  jsonData?: Record<string, any>             // raw passthrough
}
```

The host push format used by tests and the simulator is `{ type:'listen_even_app_data', method:'evenHubEvent', data:{ type:'listEvent', jsonData:{...} } }`. The `list_event` / `data` variant and the array form are also accepted, and key casing is normalised by `pickLoose`. [OFFICIAL sdk-reference skill]

### Routing

The sources conflict; handle every envelope.

- Official docs: when a text container captures, events arrive as `event.textEvent`; when a list captures, as `event.listEvent`. Long press and release **always** arrive on `sysEvent`. `menuItemClickEvent` arrives regardless of which container captures. [OFFICIAL device-apis]
- Official skill (`handle-input`): when a text container captures, **swipes arrive as `textEvent` (1 or 2), while taps and double taps arrive as `sysEvent`**. With a list: swipes move the highlight with **no event**, a tap gives a `listEvent` with `currentSelectItemIndex`, and a double tap gives a `sysEvent` with type 3.
- even-g2-notes: SCROLL_TOP and SCROLL_BOTTOM are **boundary** events, fired when the internal scroll reaches the top or bottom. The official docs table says "Swipe up / scroll reaches top boundary". For a text container whose content doesn't overflow, every swipe acts as a boundary event, so it fires every time; the templates rely on this for paging.
- devguide (0.0.9): hardware uses `sysEvent` and the simulator uses `textEvent`. even-g2-notes says the reverse. **Conclusion: check `sysEvent`, `textEvent` and `listEvent` for every gesture.**
- **Protobuf zero omission:** `CLICK_EVENT = 0` arrives as `eventType: undefined`, and list index 0 arrives as `currentSelectItemIndex: undefined`. Resolve the default **inside** the envelope check. The canonical helper, from all four official templates:

```ts
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm; if (pcm) stt?.sendPcm(pcm)          // audio branch first
  const sysType = eventTypeOf(event.sysEvent), textType = eventTypeOf(event.textEvent)
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) { bridge.shutDownPageContainer(1); return }
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) { /* prev */ return }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) { /* next */ return }
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) { /* tap */ return }  // CLICK last
  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) unsubscribe()
})
```

Never write `event.sysEvent?.eventType ?? CLICK_EVENT` at the top level. If you do, every audio frame, scroll and lifecycle event fires the tap handler. Match explicit IDs (3, 1, 2, 4–10) first and CLICK last. [OFFICIAL evenhub-templates README]

- Telling click from scroll: compare `eventType` (0/undefined, 1, 2, 3). Telling temple from ring: `sysEvent.eventSource` (1 or 3 for the glasses, 2 for the ring). For long press, 0.0.15+ keeps `eventSource`, but the official docs (dated 2026-08-29) say it is absent. Taps that arrive on `textEvent` or `listEvent` carry no source, so per-device routing works only for `sysEvent`.
- Long press example [OFFICIAL]: record `Date.now()` on `LONG_PRESS_EVENT` and compute the duration on `LONG_PRESS_RELEASE_EVENT`. A rebuild while the finger is still down still delivers the release. Don't make long press the only path to a feature.
- **Debounce and dedupe:**
  - devguide: one swipe can emit 5–10 scroll events, so use a 300 ms cooldown.
  - even-g2-notes: duplicate `sysEvent`s arrive 50–100 ms apart, so dedupe by type over about 600 ms.
  - even-toolkit `gestures.ts`: tap duplicate window 90 ms, double-tap window 140 ms, tap cooldown 220 ms, same-direction scroll 350 ms, direction change 50 ms, suppress scrolls for 110 ms after a tap, and **suppress scrolls for 80 ms after every text update** ("G2 re-layout fires spurious events").
- **Focus and selection:**
  - Lists: the firmware owns the highlight. There is no API to read or set it before a click, and a rebuild resets it. Track the index yourself as a fallback.
  - Text-container menus: draw a `>` cursor and move it on SCROLL 1/2 with `textContainerUpgrade`, or toggle `borderWidth` on stacked row containers (needs a rebuild).
  - An event-capture layer for image UIs must be a **text** container (`content: ' '`, full screen, behind the image). A 1-item list never emits scroll events. [COMMUNITY even-g2-notes `ui-patterns.md`; OFFICIAL display]

### Contextual menu (0.0.14+, Even App 2.2.9+)

[OFFICIAL `/docs/build/contextual-menu`]

```ts
await bridge.createStartUpPageContainer({ containerTotalNum: 1, textObject: [/*...*/],
  menuObject: { menuItems: [ { itemName: 'Restart', itemID: 1 }, { itemName: 'Recenter', itemID: 2 } ] } })
bridge.onEvenHubEvent(e => { const id = e.menuItemClickEvent?.itemID; if (id !== undefined) handlers[id]?.() })
```

- At most **10** items. `itemID` must be a unique, non-zero uint32. `itemName` is at most **32 UTF-8 bytes** (about 10 CJK characters); keep it under about 16 ASCII characters, because labels don't wrap.
- Items render in array order. They sit between system slots that the app cannot address: Display off and Brightness above, "Close [app name]" below.
- Items are fire-and-forget: labels never re-render, so name them as verbs.
- `menuObject` is replaced wholesale. **A rebuild without `menuObject` clears the menu**, so carry it forward on every rebuild.
- Don't add your own Exit item; the system already provides one.
- Validation codes: `TOO_MANY_MENU_ITEMS`, `INVALID_MENU_ITEM_ID`, `DUPLICATE_MENU_ITEM_ID`, `INVALID_MENU_ITEM_NAME`.

---

## 5. Audio and microphone

[OFFICIAL device-apis; SDK README and d.ts; templates `asr/`]

```ts
import { AudioInputSource, AudioSpeakerRole } from '@evenrealities/even_hub_sdk'
await bridge.audioControl(true, AudioInputSource.Glasses)   // default source; needs createStartUpPageContainer first
// await bridge.audioControl(true, AudioInputSource.Phone)  // no startup-page requirement
bridge.onEvenHubEvent(e => { const a = e.audioEvent; if (!a) return; /* a.audioPcm: Uint8Array */ })
await bridge.audioControl(false)                             // stop
```

- `audioControl(isOpen, source?)` returns `Promise<boolean>`. A `false` result for the glasses mic usually means the startup page doesn't exist yet. The source is re-chosen on every `audioControl(true, …)` call.
- **Format:** PCM, **16 kHz, signed 16-bit little-endian, mono**, on both sources. The 4-mic array is delivered as a **single** processed stream; per-mic capture and DOA are on the roadmap.
- The enterprise docs say the native SDK **decodes** the glasses stream into PCM16 before you see it. The BLE codec is UNKNOWN. even-g2-notes mentions "10 ms frame (dtUs 10000), 40 bytes per frame". 40 bytes per 10 ms is consistent with LC3 at 32 kbps (INFERENCE), but **web apps receive decoded PCM16, not LC3.**
- Chunk size: the simulator sends **100 ms = 3200 bytes = 1600 samples** per event. The hardware chunk size is **UNKNOWN**. Buffer and re-chunk yourself rather than assuming a size.
- Extra fields (0.0.14+):
  - `direction` is a raw signed int16 tag on glasses frames, with no conversion; it is `null` for the phone mic.
  - `speakerRole` is `AudioSpeakerRole.Self | Other | Unknown`. It is the app's own voice-classification result ("not a firmware identity assertion"), so it is useful for telling the wearer from other speakers.
- Permissions: declare `g2-microphone` for the glasses mic and `phone-microphone` for the phone mic in `app.json`. Declaring one you don't use gets flagged at review.
- Capture stops if the WebView is suspended (Android). Re-enable it on foreground with the same source. Always call `audioControl(false)` on exit, because otherwise the mic can stay on. The FAQ says there is no ambient capture without `audioControl(true)` and the user's grant.
- **How the ASR template streams to STT:** the provider is a **blank stub**. `src/asr/stt.ts` defines `SttClient { sendPcm(chunk: Uint8Array); close() }`, `startSttStream(apiKey, onSnapshot, onError)` and `SttSnapshot { finalText, interimText, finished }`. You are told to use a "WebSocket for streaming, HTTP for batch" from Deepgram, AssemblyAI, Whisper, Soniox or a self-hosted service. `main.ts`:
  - forwards every `audioEvent.audioPcm` into `stt.sendPcm` unchanged;
  - renders `(finalText + interimText).slice(-240)` through `textContainerUpgrade`, debounced to **120 ms**;
  - toggles the mic with `audioControl(micOn)` on tap, without closing the STT socket;
  - cleans up on exit events and on `beforeunload`.

  The key comes from `VITE_STT_API_KEY` in `.env.local`. **Do not ship that.** The official docs say any key bundled into an `.ehpk` can be extracted, so proxy it server-side. Add `{ "name":"network", "whitelist":["https://api.provider.com","wss://stream.provider.com"] }`; `evenhub pack` rejects an empty whitelist. Whether `wss://` origins are matched literally is not stated; the template lists both forms.
- Community STT implementations:
  - [COMMUNITY even-toolkit `stt/`] **Soniox**: `wss://stt-rt.soniox.com/transcribe-websocket`, first message JSON `{api_key, model:'stt-rt-v4', audio_format:'pcm_s16le', sample_rate:16000, num_channels:1, enable_endpoint_detection:true}`.
  - **Deepgram**: `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&interim_results=true`, with auth through the WebSocket subprotocol `['token', apiKey]`, which exposes the key client-side.
  - **Whisper API**: batch.
  - Its `GlassBridgeSource` converts `audioPcm` to Float32 with `DataView.getInt16(i*2, true)/32768`. There is also an optional VAD with a default 1500 ms silence threshold.
  - [COMMUNITY devguide `distributed-backend.md`] speechcoach uses `POST /sessions/:id/audio` with a JSON number[] body and SSE back. That works but is inefficient; prefer a binary WebSocket.
- **Audio output:** none (no speaker). The SDK cannot play audio on the glasses. Whether a WebView `AudioContext` plays through the phone speaker or earbuds is UNKNOWN. even-toolkit's `keep-alive.ts` plays a 1 Hz oscillator at gain 0.001 plus a `navigator.locks` lock to keep the WebView alive, so an `AudioContext` can at least be created.

---

## 6. `app.json`, permissions, icon, packaging and publishing

### Manifest fields

[OFFICIAL `/docs/ship/packaging`, `/docs/ship/app-submission`; CLI skills]

| Field | Required | Rules |
|---|---|---|
| `package_id` | yes | Reverse domain, at least 2 segments. Each segment starts with a lowercase letter and contains only `[a-z0-9]`. No hyphens, underscores or uppercase. **Permanent once published.** |
| `edition` | yes | Exactly `"202601"` |
| `name` | yes | At most 20 code points. **Must not contain "Even" (case-insensitive)**; reviewers auto-reject it as impersonation. Must match the store and on-glasses name. |
| `version` | yes | `x.y.z`. No `v` prefix, no pre-release suffix. Each upload needs a new version. Fix-forward only, with no rollback. |
| `min_sdk_version` | yes | Match your installed SDK. The docs say "Current SDK floor: 0.0.14" and the build skill uses `"0.0.16"`. Raising it strands users on older firmware. |
| `min_app_version` | no | **Derived by the CLI** from the SDK's npm `minAppVersion` and stamped into the `.ehpk`. The higher of your value and the floor wins. Users below it are blocked at open. SDK 0.0.16 sets the floor at 2.2.10. |
| `entrypoint` | yes | File relative to the build folder, for example `index.html`. It must exist in `dist/`. |
| `permissions` | yes | **An array of objects** (not a map): `{ name, desc (1–300 chars, shown to the user), whitelist? }`. May be `[]`. |
| `supported_languages` | yes | A subset of `en de fr es it zh ja ko`. At runtime the app picks the first match for the device locale, or the first item. |

- Older docs and examples also show `tagline`, `description` and `author`. [COMMUNITY even-g2-notes `packaging.md`] The listing now lives in the portal or `evenhub create --tagline/--description`. Whether `app.json` accepts those keys is UNKNOWN.
- [COMMUNITY devguide quirk #20] claims only `["en","es"]` is accepted. That is stale; the official docs list 8 languages.

### Permissions

The six valid `name` values are `network`, `location`, `g2-microphone`, `phone-microphone`, `album` and `camera`.

```json
"permissions": [
  { "name": "network", "desc": "Streams audio to our speech service.", "whitelist": ["https://api.example.com", "wss://stt.example.com"] },
  { "name": "g2-microphone", "desc": "Captures your voice from the glasses for live captions." }
]
```

- **Whitelist format:** one *full origin* per entry, such as `https://api.example.com`. **No bare hostnames and no wildcards.** Use HTTPS in production; `http://` is only for a LAN dev server. Anything not on the list is blocked before it leaves the WebView. If you change the list, repack and re-upload. [OFFICIAL `/docs/build/networking`]
- **CORS is enforced on top.** The whitelist is not a CORS bypass. The server must send `Access-Control-Allow-Origin` and handle the `OPTIONS` preflight for JSON or custom headers. Otherwise proxy through your own server. Public CORS proxies are unreliable. In development, the Vite `server.proxy` avoids CORS, but it doesn't exist in the `.ehpk`.
- **UNKNOWN:** the page origin of an installed `.ehpk`, which matters for exact-origin CORS and cookies. Log `location.origin` on the device, or use `Access-Control-Allow-Origin: *` with token auth rather than cookies.
- Permission prompts appear on **first use**, not at launch. Reviewers check every permission's denial path. [OFFICIAL private-testing, beta-testing]
- `getUserInfo()` returns `{uid, name, avatar, country}`. The FAQ mentions a "user-info permission", but no such permission name exists in the manifest schema. UNKNOWN.

### Icon (store listing)

[OFFICIAL `/docs/build/design-guidelines`; CLI icon rules]

- A 24×24 PNG of at most 1 MB.
- Every pixel is either fully transparent or opaque **`#F4F4F4`**, so it is 1-bit with no greys and no anti-aliasing.
- **Lit pixels must form raster-aligned 2×2 blocks.** The thinnest stroke is 2 px, so the effective detail budget is 12×12.
- Draw it in the portal's pixel editor, or validate locally with `evenhub create/update --icon`. Exit `9` names the offending pixel; exit `6` means the server rejected it.
- The server stores an SVG generated from the bitmap.
- Reviewers also require that the listing icon is legible, that both the foreground and background asset are supplied, that all assets are monochrome or greyscale, and that screenshots match the device. The simulator's screenshot export is the recommended way to capture them.

### Pack, upload, test and publish

[OFFICIAL `/docs/test/*`, `/docs/ship/*`]

```bash
npm run build
evenhub pack app.json dist -o myapp.ehpk --sdk-ver 0.0.16      # .ehpk = zip of dist + manifest; max 100 MB, practical ~10 MB (BLE install UX)
evenhub create myapp.ehpk --name "My App" --tagline "..." --icon icon.png   # first time  (or upload via portal Builds tab)
evenhub upload myapp.ehpk -m "What changed"                     # later versions
evenhub testers add me@example.com && evenhub promote 0.1.1 --to beta
```

| Mode | How | What it validates |
|---|---|---|
| Simulator | `evenhub-simulator <url>` | Layout and logic only |
| Local (QR) | `evenhub qr` → phone **Scan QR** | Real BLE, input, mic and IMU, with HMR. Dies on lock. Some permission prompts are skipped. |
| Private build | Upload, then on the phone **Me → Apps → Private builds → Install** | Real manifest, icon, permissions and boot. Phone-launched only, so it **won't appear in the glasses menu**. Only partly survives lock. |
| Beta | Promote to Beta (one slot per app) and an **`Active`** tester. On the phone: **Me → Beta tester → Install** | Matches production: appears in the glasses menu and has the real lifecycle. **This is required before submission.** "Test version expired" means one of the two gates is missing. |
| Publish | In the portal: click the build's tag → **Public** → "Submit this build for review?" | Confirm stays disabled until the listing is complete: developer info, screenshots, permission info and icon. Status then goes `In Review` → `Approved`/`Rejected` → `Published`. The decision email comes from `noreply@evenrealities.com` and contains no outcome. |

- The portal is `hub.evenrealities.com/login`; the docs also link `https://evenhub.evenrealities.com`.
- Pre-submission checklist:
  - Lock the phone for 5 minutes.
  - Root double-tap shows the system dialog.
  - Each permission's denial path works.
  - A first-party app such as Conversate relaunches after you exit without restarting the glasses.
  - The console is clean at boot.
  - No black screen on first run: show setup instructions on the glasses and remember the setup.
  - A privacy policy covers every permission.
  - Backend domains are documented.
  - No medical, financial or emergency-routing features.
- There is no paid distribution, no regional targeting, and no hotfix that bypasses review. [OFFICIAL FAQ, app-submission]

---

## 7. Storage and phone-side UI

### Storage

- **Bridge storage** [SDK d.ts]: `bridge.setLocalStorage(key: string, value: string): Promise<boolean>` and `bridge.getLocalStorage(key): Promise<string>`, which returns `''` for a missing key. There is **no remove**, so write `''`. Values are strings only, so JSON-encode. It persists on the phone side.
- Quotas are UNKNOWN. The official skill chunks large content at 50,000 characters per key.
- Writes share the BLE and bridge path: debounce them, serialise them with other bridge calls, and flush on `FOREGROUND_EXIT` or exit. [OFFICIAL glasses-ui skill]
- **Browser `localStorage`/IndexedDB conflict:**
  - [OFFICIAL docs: FAQ, background-lifecycle, app-submission] "`localStorage` — survives suspension, kill, and update. Cleared on uninstall." Remember setup "use the `localStorage` API". IndexedDB and OPFS are "best-effort, persistent", quotas undocumented.
  - [OFFICIAL everything-evenhub `device-features` skill, plus COMMUNITY even-g2-notes] "Browser IndexedDB and browser `localStorage` do NOT reliably persist across app restarts… SDK localStorage is the only reliable persistence."
  - **Recommendation:** treat bridge storage as the source of truth. Keep an in-memory cache with write-through: preload the known keys at boot, read synchronously, write in the background (even-g2-notes pattern; even-toolkit `storage.ts` chains writes). Mirror to `localStorage` only as a cache.
- Storage is sandboxed per `package_id`. App state lives only in the phone WebView; the glasses store nothing. [OFFICIAL FAQ]

### Phone-side UI

**Yes, the phone shows a settings page while the glasses show the HUD.**

- The plugin *is* a normal web page. Whatever you render in `index.html`'s DOM appears on the phone inside the Even Realities App, while the glasses show only SDK containers.
- Every official template does this: the ASR template's `ui.ts` shows a status chip and a live transcript mirror, and text-heavy mirrors the current page. The minimal template shows "Companion app is running. Check the glasses display." [OFFICIAL evenhub-templates]
- Both are driven from the same JS state. Interacting with the DOM on the phone (for example, settings that call `rebuildPageContainer`) is ordinary web development.
- The templates lock zoom with `<meta name="viewport" ... maximum-scale=1.0, user-scalable=no>` and CSS `touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none;`.
- Caveats:
  - The phone UI is only visible while the user has your plugin open on the phone. Reviewers test with the phone locked and in a pocket, so **the core flow must work from glasses and ring alone**. Treat the phone UI as setup, settings and history.
  - Whether the phone shows your page when the app was launched from the glasses menu is UNKNOWN.
  - On confirmed exit, the phone WebView must close.
  - `window.open(url, '_system')` and deep links to the system browser are **TBD/unsupported** [OFFICIAL FAQ]. This is consistent with Google sign-in not working, because Google blocks embedded-WebView OAuth. No official auth guidance exists (UNKNOWN). The device-code flow, magic codes, or pairing through your own backend are the likely workarounds; that is a recommendation, not a sourced fact.
- Phone-UI design system. The official skill and the community skill disagree on some values:

  | Element | `design-guidelines` skill [OFFICIAL] | `evenhub-app-ui` skill [COMMUNITY] |
  |---|---|---|
  | Light-mode tokens | Text `#232323`, dim `#7B7B7B`, background `#FFFFFF`, surface `#EEEEEE`, accent `#FEF991` (brand yellow, sparingly) | Page background BC-3rd `#EEEEEE`, cards BC-1st `#FFFFFF`, red `#FF453A`, green `#4BB956` |
  | Dark-mode tokens | Text `#FFFFFF`, background `#111111`, surface `#1A1A1A` | — |
  | Display green `#3CFA44` | Never use in the phone UI (yet the ASR template does use it in its status chip) | — |
  | Font | **FK Grotesk Neue** with tight letter-spacing, fallback Source Han Sans for CJK | FK Grotesk Neue: Large Title 20, Medium 17, Normal 15 (Light 300 for body), Subtitle 13, Detail 11 |
  | Spacing | 4/8 grid, card padding 16, screen edge 20 | **12 px screen margin**, 16 px card inset, **6 px card radius** with 60% corner smoothing, gaps 0/6/12/24 px |
  | Header | — | 60 px tall |
  | Toggle | — | 36×24 |
  | Icons | — | Official SVGs; don't use Unicode glyphs as icons |

  even-toolkit provides React components, themes and icons for this phone UI. [COMMUNITY even-toolkit, even-g2-notes `browser-ui.md`]

---

## 8. Pitfalls and undocumented behaviour

1. **`eventType 0` and index 0 arrive as `undefined`.** Use the template's `eventTypeOf`. [OFFICIAL templates]
2. **Events arrive in different envelopes** on the simulator and on hardware, and for text versus list containers. Handle `sysEvent`, `textEvent` and `listEvent` for taps. [§4]
3. **`createStartUpPageContainer` is one-shot.** A retry blocks for about 2.1 s and returns `invalid`. [COMMUNITY]
4. **Serialise every bridge call** and never run two `updateImageRawData` calls at once; the bridge locks up. Add timeouts. [OFFICIAL skill, COMMUNITY]
5. **Call overhead dominates:** about 83 ms per text upgrade, 165 ms per rebuild, and 104 ms plus pixels per image. Image refresh tops out around 9.5 fps (one container), and the official figure for a full-screen image is about 800 ms. Debounce text at about 100–150 ms. [COMMUNITY performance.md; OFFICIAL]
6. A rebuild flickers on hardware and resets list selection and scroll. A text upgrade is flicker-free on hardware but still visibly redraws in the simulator. [COMMUNITY]
7. **A rebuild without `menuObject` deletes your contextual menu.** [OFFICIAL]
8. **FOREGROUND 4/5 also fire for the contextual menu and the exit dialog**, not only for real backgrounding. Don't tear down on 5. [OFFICIAL contextual-menu; COMMUNITY]
9. After the system exit dialog is cancelled, image sends can fail with `sendFailed` until restart (firmware 2.2.7.14). Prefer root double-tap → in-app menu → "Exit" → `shutDownPageContainer(1)`. [COMMUNITY]
10. Duplicate `sysEvent`s and bursts of scroll events arrive per physical gesture. Spurious scroll events also follow text updates. Dedupe and debounce (§4). [COMMUNITY]
11. Limits are in **bytes** at the firmware level: text 999 / 1999, list item 63, container name 15, menu item 32. CJK and box-drawing glyphs take 3 bytes. [OFFICIAL enterprise, simulator changelog]
12. Text width: use `@evenrealities/pretext` with the *inner* width (subtract padding and border). Overflow in an event-capture container produces a scrollbar; a trailing `\n` can cause one too. [OFFICIAL skill, COMMUNITY]
13. Missing glyphs vanish silently (✓, ✕, ⏱, ⌖ and others). Emoji are unverified (§3). [COMMUNITY, pretext]
14. The whitelist is not CORS. Never bundle API keys, because the `.ehpk` is extractable. [OFFICIAL]
15. Android may kill the WebView in the background. Mic, location and WebSockets stop; re-arm them on `FOREGROUND_ENTER` and on relaunch. Persist state eagerly. [OFFICIAL]
16. QR dev mode dies on phone lock. Use a beta build to test lock behaviour. [OFFICIAL]
17. A private build doesn't appear in the glasses menu; only beta and published builds do. [OFFICIAL]
18. `onDeviceStatusChanged` and IMU never fire in the simulator, and `eventSource` is always 1 there. [OFFICIAL]
19. `getAppLocation` took about 3 s; never block the first paint on it. [COMMUNITY]
20. The official skill's `setBackgroundState` / `onBackgroundRestore` are not in the SDK 0.0.16 typings. The FAQ's `getDeviceInfo().locale` isn't in the `DeviceInfo` type either. Verify before relying on either. [SDK d.ts]
21. The templates and skills pin old versions (SDK `^0.0.10`, `min_app_version "2.0.0"`). Upgrade to SDK 0.0.16 and let the CLI stamp `min_app_version` (2.2.10). [npm]
22. Templates' `index.html` kills iOS double-tap zoom and rubber-banding; copy those meta and CSS rules into the phone UI.
23. **UNKNOWN:** raw BLE throughput (only call-level timings exist), the hardware audio chunk size, storage quotas, the IMU units, the WebView origin, and whether head-up gating applies.

---

## 9. Design guidelines from Even

- **Canonical source:** the Figma file "Even Realities – Software Design Guidelines (Public)", `https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=2922-80782`. It covers layout, components, interaction patterns and visual standards for both the glasses and the companion app. [OFFICIAL `/docs/build/design-guidelines`] I did not open the Figma file; its content beyond what the docs quote is UNKNOWN.
- **Display rules** [OFFICIAL]:
  - The whole 576×288 canvas is renderable.
  - Design in shades of grey; the glasses render them as green.
  - Black is transparent, so "less lit = less obstruction".
  - There is no fill; structure comes only from borders, text and images.
  - The limit is 4 images plus 8 other containers.
  - Design around **one** active input target.
- **Official UI patterns:** fake buttons with a `>` cursor; selection by toggling `borderWidth`; multi-row layouts from stacked text containers (for example 3 × 96 px); progress bars from `━`/`─` or `█▇▆▅▄▃▂▁`; page flipping by pre-paginating at about 400–500 characters (better: pretext measurement); a small `3 / 12` page indicator ("Readers lose their place on a HUD more easily"). [OFFICIAL design-guidelines, text-heavy README]
- **Useful glyphs:** navigation `▲△▶▷▼▽◀◁`, selection `●○ ■□ ★☆`, borders `╭╮╯╰ │─`. [OFFICIAL]
- **Icons (in-app pixel art):**
  - Draw large, then downscale to the actual size (24×24 is the norm) and threshold to on/off pixels with no anti-aliasing.
  - Fill the frame edge to edge.
  - Use one flat subject, strokes at least 2 px, and a silhouette readable from shape alone.
  - Avoid gradients, hairlines, outline styles, text and fine detail.
  - Test with simulator glow or on hardware.

  [OFFICIAL]
- **Interaction rules:**
  - Root double-tap opens the system exit dialog; elsewhere double-tap means back.
  - Every gesture needs visible feedback.
  - Never show a black screen; if setup is needed, explain it on the glasses.
  - Remember setup.
  - The app must be usable with the phone locked, from glasses and ring alone.
  - The contextual menu is for actions the current screen can't reach, has at most 5–6 items, and uses verb labels.
  - Long press is an enhancement, not the only path.

  [OFFICIAL app-submission, contextual-menu, device-apis]
- **"Quiet Tech":** this term appears **only in Even's marketing** (blog post "Best Smart Glasses for 2026: Why Quiet Tech Defines the Next Standard", `https://www.evenrealities.com/.../blogs/buyers-guide/best-smart-glasses-2026-quiet-tech`), not in the developer docs. Its themes are:
  - "Undisturbed Connections": digital help without breaking presence.
  - No redundant icons, no colourful distractions, and no visible tech when idle.
  - "Always Ready, not Always On".
  - Success means "reduce how often you reach for your smartphone".

  Take it as product philosophy: glanceable, sparse, dark-by-default screens that are dormant until invoked. There is no formal developer spec for "glanceable UI". UNKNOWN beyond this.

---

## 10. Conflicts register

| Topic | Source A | Source B | Resolution or recommendation |
|---|---|---|---|
| Browser `localStorage` persistence | Official docs: survives kill and update | Official skill + even-g2-notes: unreliable | Use bridge storage as the source of truth |
| Text-container taps | Docs: `textEvent` | Skill: `sysEvent` | Handle both (templates do) |
| Long-press `eventSource` | Docs (Aug 29): absent | SDK 0.0.15 changelog: preserved | Read it if present |
| SCROLL_TOP/BOTTOM semantics | Templates: per swipe | even-g2-notes: boundary-only | Per swipe when the text doesn't overflow; avoid overflowing event-capture text |
| List item height | pretext skill: 40 px fixed | even-g2-notes: containerHeight/itemCount | Measure on hardware |
| Characters per screen | Docs ~400–500, ASR template 240 | pretext-derived ~450–600 (INFERENCE) | Measure with pretext |
| Max containers | SDK: 12 | devguide (0.0.9): 4 reliable | 12, but test |
| Image max reliable size | SDK: 288×144 | devguide (0.0.9): ~200×100 | 288×144 measured OK on 0.0.13 (272×130) |
| `imageData` format | README: grayscale bytes | Template/notes: PNG bytes; simulator: PNG, Gray8, Gray4 | Container-sized greyscale PNG |
| Emoji | FAQ: no | pretext: 102-glyph `evenemoji` font | Avoid |
| Background state API | Skill: `setBackgroundState` | SDK 0.0.16 d.ts: not exported | Unverified; persist yourself |
| `min_sdk_version` | Docs: 0.0.14 | build skill: 0.0.16 | Match the installed SDK (0.0.16) |
| Phone UI screen margin | Official skill: 20 px | evenhub-app-ui: 12 px | Check the Figma file |
| Exit gesture | devguide (old): triple-tap + `shutDownPageContainer(0)` | Official: root double-tap + `shutDownPageContainer(1)` | **Official** (review requirement) |

---

## 11. Source index

**Official docs** (`https://hub.evenrealities.com/docs/`):

- `get-started/overview`, `get-started/architecture`
- `get-started/quickstart/{hardware,install-tools,first-app,sign-in,templates}`
- `build/{page-lifecycle,display,design-guidelines,device-apis,contextual-menu,networking,background-lifecycle}`
- `test/{simulator,local-testing,private-testing,beta-testing}`
- `ship/{packaging,app-submission}`
- `cli/{project,auth,apps,builds,testers,scripting}`
- `enterprise/evenhub`
- `learn/index`, `learn/claude-code`
- `reference/{glossary,versioning,changelog,faq}`

**npm package contents:**

- `@evenrealities/even_hub_sdk@0.0.16`: `README.md`, `dist/index.d.ts`, `package.json`
- `@evenrealities/evenhub-cli@0.2.0`: `README.md`
- `@evenrealities/evenhub-simulator@0.9.5`: `README.md`
- `@evenrealities/pretext@0.1.4`: `README.md`, `dist/font_measure.d.ts`, and the font data in `dist/font_measure.js`, which I parsed as data and did not execute

**GitHub repos:**

- `even-realities/everything-evenhub`: `plugins/everything-evenhub/skills/{sdk-reference,glasses-ui,handle-input,device-features,background-state,build-and-deploy,cli-reference,design-guidelines,font-measurement,quickstart,template,test-with-simulator,simulator-automation}/SKILL.md`
- `even-realities/evenhub-templates`: `README.md`, `{minimal,asr,image,text-heavy}/{README.md,app.json,package.json,index.html,vite.config.ts,src/**}`
- `nickustinov/even-g2-notes`: `docs/{architecture,display,input-events,page-lifecycle,device-apis,performance,error-codes,packaging,simulator,ui-patterns,browser-ui}.md`
- `aleapc/even-hub-devguide`: `docs/{sdk-quirks,lifecycle,dev-workflow,event-handling,distributed-backend,mobile-companion,pixel-art}.md`
- `fabioglimb/even-toolkit`: `stt/{types.ts,sources/glass-bridge.ts,providers/deepgram.ts,providers/soniox.ts}`, `glasses/{gestures,storage,keep-alive,useGlasses,sdk-wrapper}.ts`
- `JustinasLa/evenhub-app-ui`: `skills/evenhub-app-ui/{SKILL.md,references/app-guidelines.md}`

**Marketing:** the evenrealities.com blog post "best-smart-glasses-2026-quiet-tech" (seen through web search results only).
