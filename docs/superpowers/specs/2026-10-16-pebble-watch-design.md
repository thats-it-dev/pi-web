# pi-web on the wrist: design

Status: revised 2026-10-16 (Alloy, session menu, ring-started sessions), and again later that day after plan 1 shipped: **a WebSocket stream replaces the long-poll as the primary transport** and the app shows the reply text as it streams (§5.1, §6.4, §7.5). Plan 1 (hub) is merged; plan 2 (app) is written against this revision. Companion mockups: https://claude.ai/artifact/VWNxsE45NNUaSb5ve8C1Kz (private).

## 1. Intent

Michael runs pi sessions through pi-web and is often away from the keyboard
when an agent stops on a permission dialog or a question. Today that means
the session sits idle until he gets back to a phone or laptop. The goal is to
answer from the wrist in a few seconds: see what the agent wants, pick one of
its options, or reply in his own words by voice, and have the session carry
on.

Three pieces:

1. **A Pebble watchface** (`emery` = Pebble Time 2, `gabbro` = Pebble Round 2)
   that is a normal, minimal everyday face and, when a request is pending,
   shows it in a sheet. A wrist flick launches the app.
2. **A Pebble watchapp** that shows the request with its options, takes a
   choice by touch or buttons, or takes dictation; and, behind a menu, lets
   him switch sessions, read a session's history and change its model.
3. **Hub additions**: an API for the watch, and a webhook that accepts
   recordings from the Pebble Index 01 ring and turns their transcription into
   a reply to the request currently on the watch.

Success: a permission dialog or a question raised while Michael is away gets
answered from the watch (or ring) without opening the phone app, in under ten
seconds from the buzz, on an iPhone.

### Goals

- Answer approvals and questions from the watch, with the agent's own options.
- Free-text replies by watch dictation or by Index 01.
- See how a session is doing at a glance: context use, generation speed, model.
- Move between sessions, read back a conversation, change the model, and talk
  to a session that has nothing pending.
- Keep the face a good daily face: time, HR, steps, weather, date, battery.
- Build on what the hub already knows (dialogs, session state, push triggers);
  no second source of truth for "what is pending".

### Non-goals (v1)

- Pebble 2 Duo (`flint`) and older platforms. Alloy (§2) builds only for
  `emery` and `gabbro`, so these are out by construction.
- Android. Everything here must work with an iPhone; Android-only shortcuts
  (PebbleKit intents, notification replies) are not used.
- Starting a session from the watch by hand. (The ring can start one, §10.)
- Cost figures anywhere on the watch: the models are local, on the spark.
- Running our own speech-to-text on Index 01 audio. v1 uses the transcription
  the phone sends. The audio is kept so this can be added later.
- Answering from the watchface itself. Watchfaces receive no button or touch
  events on any platform (Touch guide: "Touch input is currently not supported
  in watchfaces"). If Core Devices lifts that, the sheet can grow options.

### Anti-goals

- A reply going to the wrong session. The routing rule must be simple enough
  to predict from the wrist: it answers what the watch is showing, or starts
  a new session in `~/pebble/`; it never picks a session on its own.
- The hub answering anything on the watch's behalf beyond what the existing
  approval modes already do.
- Any new way into the hub that bypasses the Tailscale identity check.
- A watchface that drains the battery by polling when nothing is happening.

## 2. Facts the design rests on

Verified 2026-10-16 against developer.repebble.com (every page has a `.md`
twin; `/llms-full.txt` is the whole site), the Core Devices mobile app source
(github.com/coredevices/mobileapp, commit ec2156c; Developer Connection in
`libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/connection/devconnection/DevConnectionLANServer.kt`,
PKJS lifecycle in `.../endpointmanager/CompanionAppLifecycleManager.kt`) and
PebbleOS (github.com/coredevices/PebbleOS, `fw/process_management/app_run_state.c`,
`fw/services/timeline/`). The Index 01 ring is set up and its webhook sent by
that same mobile app on the phone, so its requests travel the iPhone's
Tailscale tunnel like the watch's. Index webhook docs:
developer.repebble.com/index-01/webhooks/.

- A watchapp's PebbleKit JS (phone-side code) starts when that app starts on
  the watch and stops when it exits; only one app's JS runs at a time. A
  watchface counts as the running app, so **a watchface's JS runs whenever the
  face is on screen**, which is most of the day.
- On iOS the JS runs in JavaScriptCore with `XMLHttpRequest`, `WebSocket`,
  timers and `localStorage`; **no `fetch`, no `EventSource`**. iOS suspends the
  Pebble app when no Bluetooth activity is pending; timers then run late.
- `tailscale serve` is a reverse proxy: it passes WebSocket upgrades through
  and stamps `Tailscale-User-Login` on the upgrade request as on any other.
  Node 26 ships a WebSocket *client* only; a server needs the `ws` package.
- AppMessage (watch ↔ phone) carries one small dictionary at a time, each
  acknowledged before the next goes; a few messages a second is the practical
  rate. Whatever the phone receives faster than that, it coalesces.
- The phone cannot push data into a closed watchapp, and server-pushed timeline
  pins are gone. Local pins exist but can't be created while the app's JS isn't
  running.
- **Launching an app by UUID**: the Pebble app runs a Developer Connection
  WebSocket server on port 9000 (opt-in toggle per watch in the app's
  settings; no authentication; same code on iOS and Android). A binary frame
  `RelayToWatch` + raw Pebble Protocol is forwarded to the watch unfiltered. An
  AppRunState RUN message launches any installed app. The firmware does not
  pass a launch code on this path.
- iOS Shortcuts can launch a watchapp by UUID, but nothing on iOS triggers a
  Shortcut from another app's notification.
- Touch (Time 2, Round 2): apps get a TouchService and tap/pan/swipe
  recognizers; MenuLayer and ScrollLayer scroll by touch. Watchfaces get none.
- The accelerometer tap/flick service (`accel_tap_service_subscribe`) is
  available to watchfaces.
- The system LECO fonts contain digits and a few symbols only. Letters need a
  bundled font.
- Dictation API: available where `PBL_MICROPHONE` is defined (Time 2 and Round
  2 both have a mic); returns NULL if the phone app isn't connected or doesn't
  support voice. The new phone app transcribes (on-device model or cloud).
- Index 01 webhook: the phone POSTs `multipart/form-data` with `audio`
  (audio/mp4, 16 kHz mono), `transcription`, `recordedAt`, `client`, `test`;
  headers `X-Index-Webhook-Version: 1`, `X-Index-Trigger`, `X-Audio-Size`,
  `X-Index-Timestamp`, `X-Index-Delivery` and, when a secret is configured,
  `X-Index-Signature` = HMAC-SHA256 hex over
  `"v1\n" + timestamp + "\n" + delivery + "\n" + trigger + "\n" + testflag + "\n" + body`.
  Custom headers are sent verbatim. The response body is ignored. Failed
  uploads retry only on the next recording.
- **Alloy** (developer.repebble.com/guides/alloy/, examples at
  github.com/Moddable-OpenSource/pebble-examples, read 2026-10-16) is Core
  Devices' JavaScript framework for watchapps and watchfaces, built on the
  Moddable SDK. It builds only for `emery` and `gabbro`. Watch code lives in
  `src/embeddedjs/main.js` (ES modules, precompiled to bytecode, strict mode,
  no `eval`/`Proxy`/`WeakMap`/`BigInt`); a classic PebbleKit JS file still
  sits in `src/pkjs/index.js`. Available on the watch: the Piu UI toolkit
  (`Application`, `Column`, `Scroller`, `Text`, `Label`, `Inverter`, `Skin`,
  `Style`, `Timeline` animation, `Behavior`s with `onTouchBegan/Ended` when
  `touchCount` is set), Poco drawing, `pebble/button` (click, repeat, long
  press except on Back), `embedded:sensor/Accelerometer` with `onTap`,
  `pebble/vibes`, `pebble/dictation` (built-in confirm screen, `onReadable`,
  `onError`), `pebble/message` (watch may send only after the phone has sent
  once), `pebble/wakeup`, `localStorage` and key-value storage, `watch`
  events `minutechange`, `secondchange`, `willFocus`, `didFocus`, `connected`,
  `resize`, and `screen.width/height/round/color`. `fetch`/`WebSocket` from
  the watch exist but go through the phone via `@moddable/pebbleproxy`.
  System fonts by name and exact size: Gothic Regular 9/14/18/24/28/36, Gothic
  Bold 14/18/24/28/36, Leco Bold 20/26/32/36/38, Leco Regular 42, Leco Light
  28, Bitham, Roboto Condensed 21. Custom fonts are subset at build time in
  `manifest.json` (`blocks: ["Basic Latin"]`). The `piu/apps/words` example
  has a `Menu` module: a `Column` of rows with an `Inverter` bar that slides
  to the selection with a bounce, driven by Up/Down/Select. No API lets one
  app launch another. The agent skill and `pebble new-project --ai --alloy`
  cover Alloy.
- The hub already: tracks pending dialogs per session (`Dialog` in
  `shared/src/protocol.ts`, raised in `hub/src/rpc-handle.ts`), has a per-session
  `LiveState` (`idle | running | needs_you | error`), and decides when a session
  deserves a push in `hub/src/push-watch.ts` (`needs_you`, `finished`, `error`,
  only when no app is viewing). Requests are authenticated in `hub/src/auth.ts`
  by Origin, Host and the `Tailscale-User-Login` header. It also has, per
  session: `SessionSummary` (model, contextTokens, state, name, firstPrompt,
  updatedAt), `SessionStats` (tokens in/out/cache, `contextUsage` with
  percent and window), the model list from pi (`get_available_models`) and a
  `set_model` command, and history for live and closed sessions
  (`readHistory`). The pi-web app computes a live context estimate and
  tokens-per-second between stat refreshes in `app/src/lib/live-stats.ts`.

## 3. What Michael decided

These are his calls, as he made them:

- Platforms: Time 2 and Round 2 only for now.
- The agent's message appears on the face as a **popup sheet over the bottom
  third**. The time and all four corner widgets stay visible and live; they
  move up to make room. No response options on the face.
- A **wrist flick launches the app**. Flick means launch, nothing else.
- Back in the app **closes the request** (dismisses it without answering).
- The app shows the **options under the query, separated by a rule, in the
  bottom section, with the selected one highlighted**, following Pebble's own
  list pattern (`pebble-examples/ui-patterns`, list-message window).
- **LECO** typography, minimal, modelled on fit-face
  (github.com/michaelthatsit/fit-face): big time, four configurable corners.
- The face supports other widgets: heart rate, step count, weather, and so on.
- **Dark/light is a setting** of the face.
- The Index 01 webhook comes in **over Tailscale**; the phone is on the
  tailnet.
- An Index 01 reply goes to **whichever request is currently active on the
  watch**.
- Index 01 replies use the **phone's transcription as text**; an audio-based
  upgrade can come later.
- When the options don't fit, he answers in his own words, by watch dictation
  or by Index 01.
- **The watch stays quiet while a pi-web app is open.** Same rule as the
  phone push: the sheet and buzz appear only when no pi-web app is viewing,
  and a `finished`/`error` request also ends as soon as an app opens.
- **Double delivery** (the Pebble app mirrors the iPhone's pi-web push as a
  system notification over the face) is handled by **muting pi-web in the
  Pebble app's per-app notification settings**, not by the hub. The phone
  push stays unchanged as the fallback that wakes iOS when the face's
  connection has gone quiet. Revisit after the hardware check (§14 milestone
  1) says whether that fallback is ever needed.
- **An Index 01 recording with nothing pending starts a new session** in
  `~/pebble/`, with the transcription as its first prompt. Sessions begun from
  the ring live in that folder.
- **The app opens on the request and its options**, always. With nothing
  pending it stays on the current session, showing its last reply as the
  query, and `say it` sends a new prompt to it.
- **A session menu**, reached by holding Select (or a `menu` row when nothing
  is pending): `sessions` (switch), `history` (read the conversation),
  `model` (pick from pi's list). No `stats` entry.
- **Stats are a toolbar on the query screen**, not a menu entry: context bar
  with percent, generation speed, model name. **No cost figure**; the models
  run locally on the spark.
- **Built with Alloy** (JavaScript on the watch, Piu UI), both face and app.
  Chosen 2026-10-16 after reading the docs and examples; it replaces the C
  plan.
- **Push over a WebSocket** (2026-10-16, after plan 1 merged). The app shows
  the reply text as it streams and context and speed about once a second.
  Over a long-poll every one of those events ends the held request and the
  phone opens a new one; a socket carries them as frames. The long-poll stays
  as the fallback (no `WebSocket` in the phone-side runtime) and as the curl
  path. Michael's call; the shape is §5.1.

## 4. The request model (hub)

A **request** is anything the watch may show. The hub derives requests from
state it already has; nothing new is stored about pi.

| Kind | Source | Message shown | Options |
|---|---|---|---|
| `dialog` | a pending `Dialog` in an rpc session (`needs_you`) | `title`, then `message` if any | select: the dialog's options; confirm: `yes`, `no`; input/editor: none |
| `finished` | the same condition as push kind `finished`: a run ended and the last message is from the assistant | the last assistant message's text, clipped | none |
| `error` | push kind `error` | the error text, clipped | none |

Every request also carries `id`, `sessionId`, `sessionTitle` (from
`sessionTitle()` in push-watch.ts), `tool` (the pending tool's name for
dialogs, if known: `RpcHandle.pendingTool()` is private today and gets
exposed on the handle; `question` for a finished turn), `createdAt`, and the
option list. `finished`/`error` requests need a small in-memory record of
turn endings; push-watch.ts already tracks those transitions, and that
tracker becomes a shared "turn outcome" source used by both push and the
watch rather than being copied. The app always appends `say it`; for `finished` and `error` it
also appends `open on phone` (no-op on the watch beyond dismissing; it exists
so the list is never empty besides `say it`) and `dismiss`.

Request ids: `dialog:<sessionId>:<dialogId>`, `finished:<sessionId>:<messageIndex>`,
`error:<sessionId>:<messageIndex>`. Deterministic, so the face and app agree
without extra state.

Lifecycle:

- A `dialog` request ends when the dialog is answered or closed from anywhere
  (app, terminal, timeout, auto-approve), or the session's handle goes away.
- A `finished`/`error` request ends when the watch dismisses it, when a new
  prompt goes to that session from anywhere, or when the session starts
  running again.
- **Dismissed** (Back in the app) hides a request from the watch only. For a
  dialog, pi is still waiting; pi-web's phone app still shows it. Dismissals
  are kept in hub memory, keyed by request id, and dropped when the request
  ends.
- The hub remembers **`showing`**: the request id the watch most recently
  reported as on screen, with a timestamp. This is the routing target for
  Index 01 (§7).

Only rpc (headless) sessions produce requests, as with push: a bridge session
has a terminal in front of someone.

**Viewer gate.** The hub already counts open pi-web apps (`Viewers` in
`hub/src/push-watch.ts`; push is sent only when `watching()` is false). The
watch follows the same count:

- While any app is viewing, `/api/watch/pending` returns an empty list. The
  face drops its sheet (no vibe) and reports `showing: null`.
- `finished`/`error` requests are recorded only when no app was viewing at
  the moment the turn ended, exactly as push decides, and are dropped when an
  app starts viewing. They do not come back when the app closes.
- `dialog` requests are not dropped by a viewer, since pi is still waiting:
  they are hidden while an app is viewing and reappear, with one vibe, when
  the last app closes and the dialog is still pending. (My call: it keeps
  "walk away from the desk with a dialog up" working, which is the moment
  this project exists for.)

The gate is global, not per session, because that is what the hub knows
today. A per-session "which session is on screen" signal would be a later
refinement for both push and the watch.

## 5. Hub API for the watch

All under `/api/watch/`. Same Host and `Tailscale-User-Login` checks as
everything else. The **Origin check is replaced** on these paths by a bearer
token (§9), because PebbleKit JS sends no usable Origin.

| Method, path | Purpose |
|---|---|
| `GET /api/watch/stream` (WebSocket) | The primary transport (§5.1). On connect the hub sends the current `WatchPending`; after that, a `pending` frame whenever anything changes and `text` frames while the current session streams a reply. The client may send `showing` frames. |
| `GET /api/watch/pending?since=<cursor>&wait=1` | The fallback and the curl path. Returns `{ cursor, requests: Request[], showing, sessions }`. With `wait=1` the hub holds the response up to 25 s until something changes (long-poll), then returns. Without it, returns at once. `requests` is the full current list (small), sorted oldest first, dismissed ones excluded. |
| `POST /api/watch/showing` | `{ requestId: string \| null }`. The face or app reports what is on screen. |
| `POST /api/watch/answer` | `{ requestId, option?: string, text?: string }`. Exactly one of `option`/`text`. Returns `{ ok: true }` or `{ ok: false, reason: "gone" \| "no_match", options?: string[] }`. |
| `POST /api/watch/dismiss` | `{ requestId }`. |
| `GET /api/watch/health` | `{ ok, hubVersion, sessions: { running, pending } }` for the face's pi corner widget. |
| `GET /api/watch/sessions` | `{ sessions: WatchSession[] }`: live sessions first (most recently updated first), then the 20 most recent closed ones. |
| `GET /api/watch/history?session=<id>&before=<n>&limit=<k>` | `{ turns: Turn[], total }`. A `Turn` is `{ i, role: "you" \| "agent" \| "tool", text }`, text clipped to 240 chars, tool calls as one line (`bash: git push …`). Newest last; `before` pages backwards. |
| `GET /api/watch/models?session=<id>` | `{ current: { provider, id, name }, models: { provider, id, name }[] }`, from the handle's model list. |
| `POST /api/watch/model` | `{ sessionId, provider, modelId }` → the existing `set_model` command. |
| `POST /api/watch/prompt` | `{ sessionId, text }` → `prompt { text, mode: "send" }` to that session (used by `say it` when nothing is pending). |

`WatchSession` is `{ id, title, state, live, model (short name), contextPercent,
contextTokens, contextWindow, tps, updatedAt }`. `tps` is tokens per second of
the reply streaming now, else of the last reply, else `null`. The hub computes
it from the same events the pi-web app uses; `LiveStats` moves from
`app/src/lib/live-stats.ts` to `shared/src/live-stats.ts` so both use one
implementation. Every `pending` frame (and long-poll response) **also carries
`sessions`**, so the toolbar and the sessions list are live without a second
connection; stats changes for the session the watch reports as current wake
it too (`POST /api/watch/showing` takes an optional `sessionId`).

### 5.1 The stream

`GET /api/watch/stream` upgrades to a WebSocket. Auth is the same Host and
`Tailscale-User-Login` check as every other watch route, applied to the
upgrade request; a failed check answers `403` and closes. Frames are JSON
text.

Hub → client:

| Frame | When |
|---|---|
| `{ type: "pending", cursor, requests, showing, sessions }` | once on connect, then whenever the cursor moves (same coalescing as the long-poll: one frame per burst of changes; speed ticks for the current session at most once a second) |
| `{ type: "text", sessionId, text, streaming }` | while the **current session** (the `sessionId` the client last reported in `showing`) streams an assistant reply: the last 240 characters of the partial message, at most every 250 ms, and once more with `streaming: false` when the message ends. Sent once immediately when `showing` moves onto a session that is mid-reply. Nothing for other sessions. |

Client → hub:

| Frame | Meaning |
|---|---|
| `{ type: "showing", requestId, sessionId? }` | same as `POST /api/watch/showing`; it also selects the session whose text is streamed |

Answers, dismissals, prompts and model changes stay HTTP POSTs: they are
rare, they want a reply, and curl can do them. The hub pings every 30 s and
drops a socket that misses two pongs; hub shutdown closes every socket with
code 1001.

Resync is trivial: a reconnecting client gets a full `pending` frame, and the
`text` frame is a tail, not a delta, so nothing is replayed. The long-poll's
`since` cursor matters only to the fallback.

Why not the long-poll for this: at a few stats or text events a second it
degenerates into a reconnect per event. Why not SSE: PebbleKit JS on iOS has
no `EventSource`. Why the long-poll stays: the emulator's phone simulator and
any other runtime without `WebSocket` still work, and the API stays
curl-able.

Answer mapping:

| Request kind | `option` | `text` |
|---|---|---|
| dialog/select | `dialog_response { value: option }` (must be one of the dialog's options; else `no_match`) | match `text` to an option: exact (case-insensitive, trimmed), else the single option that starts with or contains the text as a whole word, else yes/no synonyms for confirm-like selects (`yes`, `yeah`, `ok`, `go ahead`, `do it` → the allow-like option as found by `auto-approve.ts`'s allow detection; `no`, `nope`, `don't`, `stop` → the deny-like option). No single match → `no_match` with the options, nothing sent to pi. |
| dialog/confirm | `yes` → `confirmed: true`; `no` → `confirmed: false` (as the pi-web app's "no" button does; `cancelled: true` is reserved for closing without answering and the watch never sends it) | same synonym matching |
| dialog/input, dialog/editor | n/a | `dialog_response { value: text }` |
| finished | n/a | `prompt { text, mode: "send" }` via the existing command path (`registry.ensure(id).command(...)`) |
| error | n/a | same as finished |

Change sources: the hub's `Registry.onChange` and each handle's broadcast
(tapped with `observe()`, which does not count as a viewer). The watch
service subscribes to those once and fans out to stream subscribers and to
waiting pollers alike. One client at a time is expected (the face, or the
app), but nothing breaks with two.

Push: the existing web push is unchanged. The watch does not use it, and
the hub does not suppress it when the face is connected (§3: the duplicate
is muted on the Pebble app side). `watch/README.md` documents the one-time
setup step: Pebble app → Notifications → pi-web → off.

## 6. The watchface

Project `watch/face/`, an Alloy project (see §12 for layout). UUID fixed in
`package.json`. `projectType: "moddable"`, `targetPlatforms: ["emery",
"gabbro"]`, `watchface: true`, capabilities `health`, `location`,
`configurable`. Drawn with Piu.

### 6.1 Idle

fit-face's layout: time centred in system Leco (`"42px Leco"` regular, or
Leco Bold 38, builder's pick for fit), four corners in Leco Bold 20/26.
Corner widgets, each assignable in the phone config page (Clay, as in
fit-face; the builder confirms Clay runs under Alloy's PebbleKit JS in
milestone 1, else a plain config page):

`heart rate`, `steps`, `weather` (temperature; needs the phone's location via
PebbleKit JS and a weather source, see §11), `date` (e.g. `THU 16`),
`battery`, `pi` (count of sessions running / pending, from
`/api/watch/health`), `none`.

Text that isn't digits (weekday, `pi` label, the sheet) uses a bundled
**LECO 1976** TTF (freely licensed; builder confirms the license file ships
with it), declared in `src/embeddedjs/manifest.json` and subset to Basic
Latin at the sizes used (16 and 14), as the `hellopiu-text` example does.
Nothing on either screen is set below 14 px: the panel has no anti-aliasing,
and 14 is the smallest size that reads.

Settings (Clay): four corner assignments, dark/light, hub URL, temperature
unit. Settings persist on the watch in `localStorage`.

Dark/light inverts paper and ink everywhere (idle, sheet). Default: dark.

### 6.2 Sheet

When the pending list goes from empty to non-empty, or a new request appears
while others are pending: one short vibe, then the sheet rises from the bottom
over the bottom third of the screen (84 px on emery's 228 px; on gabbro, the
bottom segment of the circle of the same height), with a 2 px rule along its
top. The rise and the shift are one Piu `Timeline`, 350 ms, quad ease-out. The time and all four corners animate upward so they stay fully visible
above the rule; the bottom corners keep their edge padding, now measured from
the rule. The sheet shows:

- eyebrow: `PI-WEB · <TOOL or QUESTION>`, LECO 1976 14;
- the message, two lines of LECO 1976 16; if it doesn't fit, it scrolls
  slowly (marquee) after a two-second pause;
- footer: `FLICK TO OPEN` on the left, `n OF m` on the right, 14.

The sheet shows the **oldest pending request**. If more arrive, the counter
updates; the face does not rotate through them. When the shown request ends,
the sheet switches to the next oldest or slides away.

The face reports `showing` to the hub whenever the sheet's request changes
(including to `null` when the sheet goes away).

### 6.3 Flick

While a sheet is showing, the face holds an `Accelerometer` with `onTap`
(no `onSample`, so no streaming). A tap event launches the app (§8). While no
sheet is showing, the sensor is closed, so a flick at any other time does
nothing and costs no battery. A vibration-caused tap is already filtered by
firmware. Whether tap events reach an Alloy *watchface* (the examples only
use them in apps) is checked in milestone 1; the C service is available to
faces, so it should.

### 6.4 Phone-side code (PebbleKit JS), face and app

The face and the app share one phone-side design; the app's copy is plan 2,
the face reuses its modules in plan 3.

- **Transport.** On `ready`: send one hello message to the watch (Alloy's
  `Message` can only send after it has received), load settings, then open
  the stream (§5.1) with the runtime's `WebSocket`. If the runtime has no
  `WebSocket`, long-poll `/api/watch/pending?wait=1` with `XMLHttpRequest`
  instead; the two paths feed the same code. Networking stays on the phone
  on purpose: a socket from the watch through the proxy would keep the watch
  radio busy for every frame.
- **Reconnect.** On close or error, reconnect after 1 s, doubling to 30 s;
  a successful open resets the delay. Every (re)connect yields a full
  `pending` frame, so there is no cursor to carry.
- **The phone is the model, the watch is the view.** The phone keeps the
  full pending list, the sessions list and loaded history pages; the watch
  holds only what is on screen. The phone decides which request the watch
  shows (the one it was showing if still pending, else the hub's `showing`,
  else the oldest) and sends it as one compact dictionary: id, kind, tool,
  message (clipped to 240 chars), options, position and count, session id
  and title. Lists go to the watch in pages of at most 1000 bytes.
- **Pacing to the watch.** One AppMessage in flight at a time; while one is
  being acknowledged, newer values of the same kind replace the queued one
  (latest pending list wins, latest text tail wins, latest stats win), and
  replies and list pages queue in order. Stats go at most once a second,
  text tails at most every 250 ms (the hub already paces both).
- **Idle (face only).** When nothing has been pending and no session has
  been running for ten minutes, close the socket and poll once a minute
  instead, to let iOS suspend the app; the first poll that sees activity
  reopens the socket. The first new request after going idle may arrive up
  to 60 s late; acceptable for v1. The app never idles: its JS lives only
  while the app is on screen.
- Weather (face): fetched at most every 20 minutes while the face is running,
  from the source in §11.
- The watch-side code never blocks on the phone: no data yet means the
  widget shows `--`. Messages arrive through `pebble/message`'s `onReadable`.

### 6.5 Battery

No per-second health polling (fit-face polls every second because it's a
workout face; this one is a daily face). `minutechange` for time, health
events for HR/steps, AppMessage for the rest. The accelerometer is open only
while a sheet shows (§6.3).

## 7. The app

Project `watch/app/`, an Alloy project, `watchface: false`, same platforms,
capabilities `configurable`. Launched by the flick (§8) or by hand from the
launcher or a quick-launch button. Drawn with Piu; the menu is the `Menu`
module from `piu/apps/words`, adapted (rows 32 px, no colour variant).

### 7.1 Pixel budget and type

Every screen is built from the same pieces, top to bottom, on emery's 200×228:

| Piece | Height | Type |
|---|---|---|
| status line | 18 | LECO 1976 14, left and right |
| toolbar (query screens only) | 16 | LECO 1976 14; 8 px context bar |
| query block | whatever is left | LECO 1976 18, 1.2 leading |
| rule | 2 | |
| menu rows | 32 each (44 for two-line rows) | LECO 1976 18; meta line 14 |

Nothing is set below 14 px. With four menu rows the query gets two lines,
with three rows three; longer queries are clipped (the full text is in
history). The toolbar shows: `CTX` + bar + percent (a tick on the bar marks
the compaction threshold), speed as `62 T/S` (blinks while a reply streams,
shows the last reply's figure otherwise, `--` with none), and the model's
short name (`QWEN3`). Dark/light follows the app's own setting (same Clay
keys; default dark); dark is paper black, ink white.

The status line's left text is the connection cue as well: `CONNECTING` until
the phone has reached the hub, `OFFLINE` while it cannot (the phone reports
both over AppMessage), and `PI-WEB n/m` otherwise. No icon, no second line.

### 7.2 Request screen (home)

Status line `PI-WEB n/m` left, time right. Toolbar for the request's session.
Query: for a dialog, `<tool>: <title>` then the message; for `finished`, the
reply text; for `error`, the error. Rule. Menu rows: the request's options,
then `say it`, then for `finished`/`error` `dismiss`. Selected row inverted
(Piu `Inverter`).

Input:

- Up/Down move the selection (repeat on hold); Select picks; **hold Select
  opens the menu (§7.6)**; Back dismisses the request and exits to the face.
- Touch (emery, gabbro): tap a row to pick it, via Piu `onTouchEnded` on the
  row with `touchCount: 1`. Buttons always work. Swiping between requests is
  a stretch goal (Alloy exposes raw touch points, not gestures).

Opening: the phone-side JS fetches `/api/watch/pending` once and the app
opens on the request the hub reports as `showing` if it's still pending, else
the oldest pending, else the home-with-nothing-pending screen (§7.5). It
reports `showing` (request id, or `null`, plus the current session id)
whenever the screen's request or session changes, and `null` on exit.

### 7.3 Picking an option

Select on an option row: the watch sends the request id and the option text
to the phone JS, which POSTs `/api/watch/answer`. While waiting, the row shows
`…`; on `ok` the row shows `sent` for a second and the app moves to the next
pending request, or to the home screen (§7.5) of that session. On `gone`
(someone answered elsewhere) it shows `already answered` and moves on. On
`no_match` (can't happen for an option) it shows the error.

### 7.4 Say it

`say it` starts `pebble/dictation` with `confirm: true`, so the firmware's own
confirmation screen shows the transcript and offers retry. On `onReadable` the
app shows the transcript under the query, right-aligned like a user turn in
history (§7.8), with a dimmed `sending…` row and a `say it
again` row, and POSTs `/api/watch/answer` with `text` (or, with
nothing pending, `/api/watch/prompt` to the current session). `ok` → `sent`,
move on. `no_match` (select or confirm dialogs only) → the query block shows
`didn't match: <options>` and the option rows return so one can be picked.
`onError` → the firmware's error dialog (`errorDialogs: true`), then back to
the menu.

### 7.5 Home with nothing pending

The app does not exit. Status line `PI-WEB 0/0`, toolbar, and the current
session's last assistant message as the query, with a 14 px hint line
`<SESSION TITLE> · <STATE>`. **While the session is running, the query block
is live**: it shows the tail of the reply as it streams (the stream's `text`
frames, §5.1), the toolbar's speed figure blinks, and when the message ends
the final tail stays as the last reply. The phone fetches the last reply
from `/api/watch/history` when the current session changes and no stream text
has arrived for it. Rows: `say it` (sends a new prompt to this
session, §7.4) and `menu` (§7.6). The current session is the one the watch
last showed; failing that, the most recently updated live session; failing
that, the most recent closed one, whose `say it` reopens it through
`registry.ensure`. Back exits to the face.

### 7.6 Menu

Hold Select on any screen (or the `menu` row). Status line `MENU`, time.
Query block: session title (14) and `<model> · <state>` then `<used>k of
<window>k`. Rows: `sessions` (count on the right), `history` (turn count),
`model` (short name). Back returns to the previous screen.

### 7.7 Sessions

Status line `SESSIONS n`. No query block: the list fills the screen. Two-line
rows (44 px): title; then `<STATE> · <MODEL> · <ctx%>` in 14. Live sessions
first, most recently updated first; then recent closed sessions, dimmed, with
`CLOSED · <age>` as the meta line. Select makes it current and returns to the
home screen for that session (its pending request if it has one, else §7.5).
Up/Down past the ends stop (no wrap). No scrollbar; the count in the status
line is the only position cue. The list comes from the stream's `sessions`
and refreshes in place.

### 7.8 History

Status line `HISTORY · i/n` (the turn at the top of the screen, of n). A Piu
`Scroller` of turns, opened at the bottom, laid out as a chat, not a terminal:
your turns right-aligned, inset 32 px from the left; the agent's
left-aligned, inset 24 px from the right; both in the same ink on the same
paper, no fills or bubbles, alignment alone tells them apart;
tool calls one dimmed 14 px line each (`bash · git push …`). No scrollbar and
no fade at the edges: the `i/n` counter in the status line is the position
cue, and text is cut cleanly at the screen edge. No prompt characters,
cursors or chevrons anywhere in the app. Up/Down scroll by about half a screen; touch drags.
Loads the last 12 turns from `/api/watch/history`, and 12 more when the top
is reached. Read only. Back returns to the menu.

### 7.9 Model

Status line `MODEL`. Query block: session title (14) and `model for this
session`. Rows: pi's models for that session, short names, current one marked
`●` on the right. Select POSTs `/api/watch/model`, shows `set` for a second,
returns to the menu. The toolbar updates on the next `pending` frame.

### 7.10 Round 2

Same pieces. The status line and query are centred; the menu keeps the
selected row centred, as the `words` example does on gabbro. The builder
adjusts paddings by screenshot, as fit-face does.

## 8. Launching the app from the face

The flick path, in order of preference. Alloy has no API for one app to
launch another, so the paths are unchanged by the Alloy choice. The builder confirms the first on real
hardware before building further on it (milestone 1, §12).

1. **Local Developer Connection.** The face's JS opens
   `ws://127.0.0.1:9000/` on the phone (the Pebble app's own Developer
   Connection server; the user turns it on in the Pebble app's settings for
   this watch) and sends one binary frame: `RelayToWatch` followed by a Pebble
   Protocol AppRunState message that launches the app's UUID. Constants come
   from the mobile app source (`DevConnectionLANServer.kt`,
   `ClientMessageType`, the AppRunState endpoint and the firmware's
   `app_run_state.c`); the builder verifies them there rather than from this
   document. No hub involvement, no phone IP discovery.
2. **Hub-side Developer Connection.** If the loopback socket can't be opened
   from PebbleKit JS on iOS, the face's JS instead POSTs
   `/api/watch/launch`, and the hub, using Node's built-in `WebSocket` client,
   connects to `ws://<phone tailnet IP>:9000/` and sends the same frame. The
   phone's tailnet IP comes from `X-Forwarded-For` on the face's own requests
   (tailscale serve sets it) and is remembered per token.
3. **Manual.** Quick launch (firmware: long-press Up/Down or Back+Up from any
   face, assigned in the watch's settings) or the launcher. Always works; the
   mockup footer stays `FLICK TO OPEN` only if 1 or 2 works.

Whichever path is used, the sheet shows `opening…` in its footer for up to
three seconds after a flick; if the app hasn't launched by then it reverts to
`FLICK TO OPEN`.

## 9. Security

- **Tailnet identity only.** On `/api/watch/*` and `/api/index/webhook` the
  Origin check is skipped (neither caller is a web page); the Host check and
  `Tailscale-User-Login` check still apply, so a request must come from a
  tailnet device logged in as the allowed user. **No watch token and no Index
  signing secret** (Michael's call, 2026-10-16: the hub is reachable only
  over his single-user VPN, so anything on his own devices is trusted). What
  this gives up: a web page open in a tailnet browser, or an app on a tailnet
  device, that knows the hub's hostname could call these routes with his
  identity. The first version of this section had a bearer token and an
  HMAC-signed webhook for exactly that; the code is in git history
  (`d7ea588` and before) if the threat model changes.
- **Replay.** `/api/index/webhook` still rejects an `X-Index-Delivery` id
  seen in the last hour (409), so a retried upload doesn't act twice. The
  Index app's "Sign requests" toggle stays off.
- The Developer Connection on the phone has no auth. Path 1 in §8 never
  exposes it beyond the phone. Path 2 relies on Tailscale and the toggle in
  the Pebble app; the design notes that any tailnet device could then launch
  apps on the watch, which is acceptable for a single-user tailnet.
- Nothing in these additions answers a dialog without a human action on the
  watch or the ring.

## 10. Index 01 webhook

`POST /api/index/webhook`, multipart. Steps:

1. Verify signature and freshness (§9). `test=true` events: 200, no action.
2. Save the audio to `<dataDir>/index/<delivery>.m4a` with a JSON sidecar
   (headers, transcription, the routing decision). Keep the last 200.
3. Choose the target request: the hub's `showing` if it is still pending;
   else the most recently shown request if still pending (my call); else
   none.
4. With a target and a non-empty `transcription`: run the answer mapping of
   §5 with `text`. `ok` → done. `no_match` → log; nothing is sent to pi.
5. With no target and a non-empty `transcription`: **start a new session**.
   The hub creates `~/pebble/` if it doesn't exist (my call; it's the same
   `~`-relative resolution as `POST /api/sessions`), calls
   `registry.create(cwd)`, and sends `prompt { text: transcription, mode:
   "send" }`. The session gets the hub's default approval mode. A busy
   session with nothing pending is not interrupted; a new one is started
   instead. The turn's outcome then reaches the watch as an ordinary
   `finished`/`error` request (subject to the viewer gate), so the next ring
   recording continues that conversation. The sidecar records
   `{ action: "new_session", sessionId }`.
6. Empty transcription: log and keep the audio. Nothing else in v1.

The response is always 200 with an empty body (the Index app ignores it) once
the signature passes.

## 11. Weather and other external data

Weather needs a source reachable from the phone. The hub already has outbound
internet. To keep API keys off the watch and the phone, the **hub proxies
weather**: `GET /api/watch/weather?lat=&lon=` returns `{ tempC, code }`,
fetched from Open-Meteo (no key) and cached ten minutes per rounded
coordinate. The face's JS gets coordinates from `navigator.geolocation`
(available in the Pebble app's JS). My call; a different provider is a
one-file change.

## 12. Repository layout and tooling

```
watch/
  README.md           build, install, emulator, hardware notes, Pebble-app setup
  shared/js/          modules both projects import: theme, type scale, layout
                      helpers, request/AppMessage packing
  face/               Alloy project: package.json, src/embeddedjs/{main.js,
                      manifest.json}, src/pkjs/index.js, src/c/mdbl.c,
                      resources/ (LECO 1976 TTF + licence)
  app/                Alloy project, same shape; src/embeddedjs/{main.js,
                      views/*.js, modules/Menu.js}
  screenshots/        emulator captures, emery + gabbro, light + dark
hub/src/watch.ts      request model, stream fan-out + long-poll, text tail, sessions, answer mapping
hub/src/watch-stream.ts  the WebSocket endpoint (ws package), auth on upgrade, pings
hub/src/index-webhook.ts
shared/src/live-stats.ts   moved from app/src/lib (tps + live context)
```

Inside `watch/app/src/pkjs/`: `index.js` (wiring only), `hub.js` (the hub
client: socket, long-poll fallback, reconnect, POSTs), `bridge.js` (the
phone-side model: request selection, pacing, AppMessage packing, commands
from the watch), `config.js` (Clay page). The face reuses `hub.js` and the
packing half of `bridge.js`.

- Scaffold each project with `pebble new-project --alloy --ai <name>` and
  keep the generated `CLAUDE.md`. `watch/face` and `watch/app` are **not**
  npm workspaces of the repo root; each has its own `package.json` and
  `node_modules` (Clay). The root README gets a `watch` section.
- Tooling: `uv tool install pebble-tool`, `pebble sdk install latest`; the
  emulator runs with `--vnc` on the headless spark. Install the official
  agent skill (github.com/coredevices/pebble-watchface-agent-skill) into
  `.claude/skills/` for the build/screenshot loop (`pebble build`, `pebble
  install --emulator emery`, `pebble screenshot --no-open`, `pebble
  emu-button`, `pebble logs`).
- Shared JavaScript: each project's `src/embeddedjs/manifest.json` lists
  `../../shared/js/*` modules under `modules`. Keep the module count low;
  each costs RAM.
- `@moddable/pebbleproxy` is **not** a dependency: all networking is in
  `src/pkjs/` (plain ES5, `WebSocket` with an `XMLHttpRequest` long-poll
  fallback, Clay). The watch talks to the phone with `pebble/message` only.
- The hub gains one runtime dependency, `ws` (and `@types/ws`); the hub's
  self-update already runs `npm install`.
- Emulator development: the Vite dev server already plays `tailscale serve`
  for the browser app (it adds the identity header to proxied `/api`
  requests). It proxies WebSocket upgrades too, so the emulator's phone-side
  JS points its hub URL at `http://127.0.0.1:5173` and reaches a local dev
  hub with the right headers.
- Memory: start from the `words` example's `Application` options
  (`displayListLength`, `commandListLength`, `pixels: screen.width * 4`) and
  tune by `pebble logs`; the history screen keeps at most 24 turns in memory.
- Both projects need the hub URL; v1 enters it twice (two Clay pages). A
  later improvement is a QR or deep link.

## 13. Testing

- Hub: `node:test` as today. The request model is tested against a fake
  registry (dialog raised → request appears; answered elsewhere → gone;
  dismiss hides; finished turn → request; new prompt clears it; viewer gate:
  app open → list empty, finished dropped, dialog reappears on close). Answer
  mapping has table tests for the synonym rules. Long-poll returns early on
  change and at 25 s without. Stream tests, with Node's own `WebSocket`
  client: an upgrade without the identity is refused; connect gets a
  `pending` frame; a raised dialog arrives as a frame; a `showing` frame sets
  the hub's showing; text tails arrive for the current session only, at most
  every 250 ms, and a final one with `streaming: false`; a closed socket is
  forgotten. Webhook tests sign a fixture multipart body and
  cover bad signature, stale timestamp, replay, test event, match, no match,
  empty transcription, and no pending → a session is created in `~/pebble/`
  (folder made if missing) and the transcription is its first prompt.
- Hub, menu endpoints: sessions ordering (live first, closed capped at 20),
  history paging and clipping, model set round-trip, prompt to a closed
  session reopens it, `tps` present while streaming and after.
- Watch: emulator screenshots for every screen in the mockups on emery and
  gabbro, light and dark, checked into `watch/screenshots/`. The phone-side JS
  is plain ES5 and gets a `node:test` suite with stubbed `Pebble`,
  `WebSocket` and `XMLHttpRequest` globals: the hub client (socket, fallback
  when there is no `WebSocket`, reconnect back-off), request selection,
  pacing and coalescing, list paging and AppMessage packing. Watch-side
  modules that hold logic (request packing, option matching for `no_match`
  display, history paging, toolbar formatting) are kept free of Piu imports
  so `node:test` can import them directly.
- Hardware (manual, recorded in `watch/README.md`): on Michael's Time 2 and
  iPhone: the flick path (§8), the socket surviving the phone locked in a
  pocket for 30 minutes (and how fast it reconnects), dictation round trip,
  an Index 01 reply landing in the right session.

## 14. Milestones

1. **Launch and background check on hardware.** A throwaway Alloy face that
   holds the stream open from pkjs (§5.1) and, on `onTap`, tries §8 path 1,
   then path 2. Outcome decides the launch path, whether the idle policy in
   §6.4 is enough on iOS, whether `Accelerometer.onTap` fires in an Alloy
   watchface, and whether Clay works from Alloy's pkjs. Half a day. The face
   is built on what it finds. (Order changed after the fact: the hub and the
   app come first because they can be verified on the emulator; this spike
   moved into plan 3.)
2. **Hub**: request model, `/api/watch/*`, tests. Usable from `curl`. **Done
   (plan 1, merged 2026-10-16).** The stream endpoint (§5.1) is the first
   part of plan 2.
3. **App** (plan 2): the stream on the hub, the phone-side client and model,
   then the request screen, answer, dictation, touch, home with live text,
   emulator screenshots; then the menu: sessions, history, model.
4. **Face**: idle, corners, settings, sheet, flick → app.
5. **Index 01 webhook** and a short "watch" note in the pi-web app's settings
   (the mute step).
6. Hardware pass of §13, README, and the known-issues list.

## 15. Risks and open unknowns

- **iOS suspension.** If the Pebble app is suspended with the phone locked,
  the face's socket is frozen or dropped until Bluetooth traffic wakes it,
  exactly as a long-poll would be. Milestone 1 measures this. If it's bad,
  the fallback is the hub sending a web push notification (already exists)
  so the iPhone wakes and the Pebble app sees Bluetooth activity; the sheet
  then appears late but appears.
- **No `WebSocket` where the phone-side JS runs.** The emulator's phone
  simulator may lack it, and the real app's runtime is only documented, not
  yet measured. The long-poll fallback covers both; a status cue on the
  watch (§7.1) says which transport is up.
- **AppMessage throughput.** Streaming text is paced to the watch at four
  tails a second at most, in 240-character pieces; if the emulator or the
  watch drops messages at that size the cap halves. The watch never sees the
  raw delta stream.
- **Developer Connection availability.** The toggle may reset on app updates
  or reconnects. The sheet's manual path (§8.3) is always there.
- **Dictation on iOS** depends on the phone app's transcription setup
  (on-device model download or cloud). Documented in `watch/README.md`.
- **Alloy is new.** Examples date from May 2026; the proxy package is 0.2.x.
  Expect rough edges and tight RAM for the history screen. Fallback for any
  one screen is Poco drawing instead of Piu; fallback for the whole thing is
  the C plan this document replaced (git history has it).
- **Transcripts that don't match a select option.** The watch shows the
  options again; a ring reply that doesn't match is logged and lost. A later
  version could ask the agent, or fall back to steering text.

## 16. Left to the builder

- Exact paddings and the animation curves within the type scale of §7.1;
  match the mockups by screenshot.
- The AppMessage dictionary keys and the font subset blocks in the manifest.
- Piu `Application` memory options per project.
- How many turns of history to clip per turn (240 chars is the starting
  point) and how `Scroller` paging feels on buttons.
- Whether `finished` requests clip at the first paragraph or at N characters.
- Menu behaviour at the ends (wrap vs. stop) and swipe thresholds.
