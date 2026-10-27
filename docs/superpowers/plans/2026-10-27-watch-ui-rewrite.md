# Watch UI Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pi-web watchapp with a Pebble-native one (session list, session, full-screen queries with an action drawer), backed by a hub-level query contract that pi dialogs and ring-profile share, with native-notification (or auto-launch) alerts when the app is closed.

**Architecture:**
- **Hub (TypeScript).** A new `QueryStore` owns every query: pi dialogs mapped in, and external ones raised on a loopback-only internal API. `WatchService` exposes queries and session statuses to the watch over the existing WebSocket. A `Notifier` alerts the closed app through the phone's Developer Connection.
- **Watch app (Alloy/Piu).** Rebuilt on pebble-ui: `Menu`, `ActionMenu` and `StatusBar`, plus one custom `TextScreen` view.
- **Phone side (PebbleKit JS).** Relays hub frames to compact AppMessage dicts and watch commands back to the hub.

**Tech Stack:**
- Hub: Node 24 TS (`node --test`), `ws`.
- Watch: Moddable Alloy SDK 4.33.1, pebble-ui (git submodule), PebbleKit JS ES5 with `@rebble/clay`.

**Spec:** `docs/superpowers/specs/2026-10-27-watch-ui-design.md`. Clickable reference: `docs/superpowers/mockups/2026-10-27-watch-ui-prototype.html`. Related: `~/workspace/ring-profile/docs/superpowers/specs/2026-10-27-ring-profile-design.md`. This plan owns the hub query contract; ring-profile builds the notes webhook on top of it.

Branch: `feat/watch-ui-rewrite` (already created from `master`, holds the spec). Commit as `git -c user.name="Michael Gutensohn" -c user.email=michael@gutensohn.me commit …`, and end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Global Constraints

**Platform and build**
- Target **emery only**. Set `targetPlatforms: ["emery"]` and drop gabbro.
- Mod archive (`build/mods/emery/mc.xsa`) **≤ 42,500 B**. Measure with `bash ../pebble-ui/tools/sizes.sh .` after every watch build. If a build is over, stop and report (see using-pebble-ui, "Memory budget").
- Machine sizes as in pebble-ui's fitsky example: `stack 5120, slot 45056, chunk 21504` (`mdbl.c` and `manifest.json` `config.creation`).

**Text and colour**
- Fonts:
  - words: Gothic Bold;
  - digits (clock and times): LECO. Only use LECO for strings drawn from its set: `0-9 : / . , ° A P M H B L T I N -`.
- Text is left-aligned. Body text is 18–24 px Gothic Bold; nothing is under 14 px.
- Colours:
  - waiting `#FFAA00`;
  - pi / running `#0055AA`, or `#55AAFF` as text on Dark;
  - ring-profile `#00AA55`;
  - error `#FF0055`;
  - done `#AAAAAA` on Light, `#555555` on Dark.
- **Selection is amber `#FFAA00`:** the selected Menu row with black text, and the selected ActionMenu item.

**Screen chrome**
- **Clock bar** on every app screen: the time in LECO, on the theme's background and text colour. No coloured fill.
- **Header line** under the clock on the session and query screens:
  - label on the left, LECO time on the right, both in the source colour;
  - no fill;
  - a 1 px bottom border in the theme's text colour.
- **Action drawer:**
  - black;
  - the left margin is the theme background;
  - a 1 px left border in the theme's text colour (black on Light, white on Dark);
  - a crumb dot in the margin in the theme's text colour;
  - no coloured rail.

**Behaviour**
- Buttons: Back goes back (out of the app from Home). Select opens the drawer. Up/Down scroll or move.
- Settings (Hub URL, Theme) are only in the Clay page. There is no Settings row on the watch.
- Skip on a pi dialog only hides it from the watch (today's `dismiss`); pi keeps waiting.
- An agent-webhook ring note answers **only a query on screen**. If it doesn't match, nothing is approved or denied: the query stays up and the watch shows "Didn't catch that".
- While the web app is open (`viewers.watching()`), pi queries are held back from the watch. ring-profile queries never are.

**Hub**
- Auth is tailnet identity only. No tokens.
- The internal API listens on `127.0.0.1` only.
- Keep the hub's non-watch behaviour unchanged.

## Review Focus

1. **Query resolved elsewhere while the watch shows it** (answered in the web app, or the session closed). The watch must leave the query screen within one frame and go back to where Michael was, not show a stale query or crash. Test in Task 3 and Task 8.
2. **App closed and the phone unreachable when a query arrives.** The notifier fails, the query stays pending and undelivered, and expiry reports `expired-undelivered`. The hub must not throw or retry in a loop. Test in Task 6.
3. **Query text longer than one screen, with an over-long option label.** Down scrolls to the end and stops. Labels are clipped to fit the drawer and the full option string is still sent back. Test in Task 7 (clipping) and Task 8 (scroll bounds).
4. **Two queries pending.** Answering the one on screen shows the next. Home lists the waiting session first. A ring note never answers the hidden one. Test in Task 3 and Task 5.
5. **The hub restarts, or the WebSocket drops while a query is on screen.** pkjs reconnects, the watch gets a fresh `home` and the query again, and nothing is answered twice. Test in Task 7.

---

### Task 1: Spike: alert the closed app (throwaway, on hardware)

Settles spec §7 before anything depends on it. The scripts are throwaway; only the results are kept.

**Files:**
- Create (scratch, not committed): `$SCRATCH/spike/notify.mjs`, `$SCRATCH/spike/launch.mjs`
- Modify: `docs/superpowers/specs/2026-10-27-watch-ui-design.md` (§7: append a "Spike results" subsection)
- Create (only if notifications work): `hub/test/fixtures/notification-frame.hex`

- [ ] **Step 1: Find the phone.** Use the `pebble-phone-dev-connection` pi skill's `find-phone.sh`, or the hub's `watch.phone`. Have Michael turn on the Developer Connection in the Pebble app.
- [ ] **Step 2: Auto-launch.** Install the current app with `pebble install --phone <ip>` from `watch/app` on master. In `launch.mjs`, send `launchFrame(uuid)` from `hub/src/watch-launch.ts` to `ws://<phone>:9000/`. Michael records whether the app opens, with the Pebble app (a) in the foreground, (b) in the background for 1 min, (c) in the background for 10 min with the phone locked.
- [ ] **Step 3: Native notification.** In `notify.mjs`, send a BlobDB insert (RelayToWatch 0x01, endpoint 0xB1DB) of a Notification timeline item. Take the item and attribute layout from `coredevices/mobileapp` (libpebble3 `TimelineItem` / `BlobCommand`) and PebbleOS `fw/services/timeline`. It needs:
  - parent UUID = the watchapp UUID `6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b`;
  - title "pi · watch-ui", body "Run npm test in pi-web/hub?";
  - one action of type OpenWatchApp (0x07) with launch code `42`.

  Run the same three conditions. Record whether the popup appears, whether the action opens the app, what the app logs for `watch.launch.reason` / `watch.launch.arguments` (add a one-line `console.log` in a scratch build), and whether the phone's BlobDB sync later removes the item.
- [ ] **Step 4: Record.** Append "Spike results (date)" to spec §7: a table of path × condition → outcome, the launch reason and arguments strings, and the chosen default `watchAlert` (`"notification"` or `"launch"`). If notifications worked, save the exact frame bytes that worked as hex to `hub/test/fixtures/notification-frame.hex`, with the inputs that produced them in a comment line starting `#`.
- [ ] **Step 5: Commit** the spec update and fixture: `docs: watch alert spike results`.

**If neither path works on iOS in the background**, stop and report to Michael before Task 6. Tasks 2–5 and 7–10 don't depend on the result.

---

### Task 2: pebble-ui: theme options for StatusBar and ActionMenu

In `~/workspace/pebble-ui` (its own repo; commit there). Defaults must leave every existing screen unchanged.

**Files:**
- Modify: `~/workspace/pebble-ui/modules/StatusBar.js`
- Modify: `~/workspace/pebble-ui/modules/ActionMenu.js`
- Modify: `~/workspace/pebble-ui/README.md` (document the options)

**Interfaces:**
- Produces:
  - `StatusBar({ color, dotted, font, background })`. `font` defaults to the current Gothic 18 and accepts `"LECO_20_BOLD_NUMBERS"`, a key handled the way `StatsScreen` handles its LECO fonts. `background` defaults to transparent.
  - `ActionMenu` data gains `crumb` (dot colour, default `foreground`), `border` (colour of a 1 px vertical line at the rail's right edge, default none) and `sheet` (the item area's colour, default `#000000`). Existing `background` stays the rail colour. The app passes the theme background as `background`, so the rail looks like margin.

- [ ] **Step 1:** Build `examples/fitsky-patterns` and screenshot the action menu and a status-bar screen (`pebble screenshot --no-open --emulator emery`).
- [ ] **Step 2:** Implement the options. The crumb's anti-aliased corners blend between `background` and `crumb`, where they used to blend with `foreground`.
- [ ] **Step 3:** Rebuild fitsky-patterns and compare against `screenshots/emery/actionmenu.png`, `actionmenu-2.png` and a status-bar screen with `python3 tools/diff.py`. Expected: identical.
- [ ] **Step 4:** In a scratch copy of fitsky-patterns, push an ActionMenu with `{ background: "#FFFFFF", crumb: "#000000", border: "#000000", sheet: "#000000", foreground: "#FFAA00" }` and a `StatusBar({ font: "LECO_20_BOLD_NUMBERS", color: "#000000" })`, then screenshot. Expected: white margin with a black dot, a 1 px black line, a black sheet and an amber selected item, plus LECO clock digits. Show Michael the screenshot.
- [ ] **Step 5:** `bash tools/sizes.sh examples/fitsky-patterns`: ActionMenu grows ≤ 300 B.
- [ ] **Step 6: Commit** in pebble-ui (`feat: StatusBar font/background, ActionMenu crumb/border/sheet`) and push to its remote (the library is public and pi-web pins it as a submodule).

---

### Task 3: Hub: QueryStore and the watch protocol

**Files:**
- Create: `hub/src/queries.ts`
- Modify: `shared/src/protocol.ts` (watch section, lines ~309–352)
- Modify: `hub/src/watch.ts`
- Test: `hub/test/queries.test.ts`, `hub/test/watch.test.ts` (update)

**Interfaces (Produces):**

```ts
// shared/src/protocol.ts — replaces WatchRequest/WatchRequestKind/WatchPending/WatchClientFrame
export type QuerySource = "pi" | "ring-profile";
export interface WatchQuery { id: string; source: QuerySource; sessionId: string | null; label: string; text: string; options: string[]; createdAt: number }
export type SessionStatus = "waiting" | "running" | "done" | "error";
// WatchSession gains: status: SessionStatus
export interface WatchPending { cursor: number; queries: WatchQuery[]; showing: Showing | null; sessions: WatchSession[] }
export interface Showing { queryId: string | null; sessionId: string | null }
export type QueryOutcome =
  | { kind: "option"; option: string } | { kind: "skip" } | { kind: "ring-answer"; text: string }
  | { kind: "cleared-by-ring"; text: string } | { kind: "expired-delivered" } | { kind: "expired-undelivered" };
export type WatchStreamFrame = ({ type: "pending" } & WatchPending) | { type: "text"; sessionId: string; text: string; streaming: boolean } | { type: "notice"; text: string };
export type WatchClientFrame = { type: "showing"; queryId: string | null; sessionId: string | null };
```

```ts
// hub/src/queries.ts
export interface RaiseInput { source: "ring-profile"; label: string; text: string; options: string[]; timeoutMs: number; onOutcome: (o: QueryOutcome) => void }
export class QueryStore {
  constructor(deps: { now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; onChange: () => void });
  raise(input: RaiseInput): WatchQuery;               // id "rp:<n>"
  external(): WatchQuery[];                           // pending external queries, oldest first
  resolve(id: string, o: QueryOutcome): boolean;      // fires onOutcome once, clears timer, onChange
  markDelivered(id: string): void;
  delivered(id: string): boolean;
  close(): void;                                      // clears timers, no outcomes
}
```

**WatchService** changes:
- `pending()` returns `queries`:
  - pi dialogs as `WatchQuery` (`id` stays `dialog:<sid>:<did>`, `source: "pi"`, `label: "pi · <sessionTitle>"`, `text` = the dialog message, `options` = `dialogOptions(d)`);
  - plus `queryStore.external()`;
  - ordered oldest first;
  - pi ones dropped while `viewers.watching()` or dismissed.
- `answer(queryId, { option?, text? })`: pi as today. External queries resolve `{kind:"option"}`, or `{kind:"ring-answer"}` for text.
- `skip(queryId)`: pi goes to `dismiss`; external resolves `{kind:"skip"}`.
- `showing({ queryId, sessionId })`: marks the query delivered.
- `onScreen(): Showing | null` (replaces `currentTarget`).
- `sessionList()` sets `status`, in this order:
  1. `waiting` if any visible query has that `sessionId` or `liveState()==="needs_you"`;
  2. `error` if `liveState()==="error"` or the last outcome was `error`;
  3. `running` if `"running"`;
  4. otherwise `done`.

  Order: `waiting` first, then by `updatedAt` desc.
- Remove `outcomeRequests`. Keep the `outcomes` map as turn alerts, exposed as `turnAlerts(): { sessionId: string; kind: "finished" | "error"; title: string; text: string }[]` for the Notifier (Task 6), plus `onTurnAlert(fn)`.

- [ ] **Step 1: Write the failing tests** in `hub/test/queries.test.ts`, with injected fake timers:
  - `raise assigns rp:1, rp:2 and lists them oldest first`;
  - `resolve fires onOutcome exactly once and removes the query`, where a second `resolve` returns false and no second call happens;
  - `timeout resolves expired-undelivered when never delivered`;
  - `timeout resolves expired-delivered after markDelivered`;
  - `close clears timers without outcomes`.
- [ ] **Step 2:** Run `node --test hub/test/queries.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `QueryStore`.
- [ ] **Step 4: Update `hub/test/watch.test.ts`** to the new shapes and add:
  - `pi dialog appears as a query with source pi and label "pi · <title>"`;
  - `pi queries are held while the web app is open; ring-profile queries are not`;
  - `skip on a pi query hides it from the watch but the dialog stays pending in the handle`;
  - `answering a dialog in the web app removes the query and the next pending query is first` (Review Focus 1 and 4);
  - `session status: waiting > error > running > done, waiting sessions listed first`;
  - `showing marks an external query delivered`.
- [ ] **Step 5:** Implement the WatchService changes. Update `hub/src/watch-routes.ts`:
  - `/api/watch/answer` takes `queryId`;
  - add `POST /api/watch/skip {queryId}`;
  - `/api/watch/showing` takes `{queryId, sessionId}`;
  - remove `/api/watch/dismiss`;
  - make the matching changes in `watch-stream.ts` and `watch-routes.test.ts` / `watch-stream.test.ts`.
- [ ] **Step 6:** Run `npm run test -w hub && npm run typecheck`. Expected: PASS. Fix the face/old-app consumers of the removed types by deleting them in Task 8, not here: if `shared` typecheck fails only because of `watch/` JS, that's fine, since it isn't typechecked.
- [ ] **Step 7: Commit** `feat(hub): query store and watch query protocol`.

---

### Task 4: Hub: internal API for external queries

**Files:**
- Create: `hub/src/internal-server.ts`
- Modify: `hub/src/config.ts` (`internalPort: number`, default `7879`), `hub/src/main.ts`
- Test: `hub/test/internal-server.test.ts`

**Interfaces:**
- Consumes: `QueryStore.raise/resolve`, `WatchService` (to read pending and `onScreen`).
- Produces (loopback HTTP, JSON):
  - `POST /queries {label, text, options: string[], timeoutMs?: number (default 600000, max 3600000), callbackUrl: string}` returns `201 {id}`. On resolution, the hub POSTs `{id, outcome: QueryOutcome}` to `callbackUrl`, one attempt with a 5 s timeout; failures are logged, never retried.
  - `POST /queries/:id/clear-by-ring {text}` returns `200 {ok: true}`, or `404` if the query is gone. It resolves `{kind:"cleared-by-ring", text}`. This is what ring-profile's notes forwarder calls.
  - `GET /queries` returns `{queries: WatchQuery[]}`.
- `createInternalServer(deps: { store: QueryStore; fetchFn?: typeof fetch; log?: (m: string) => void }): http.Server`, listening on `127.0.0.1:<internalPort>` from `main.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `raise via POST /queries returns 201 with id and the query appears in GET /queries`;
  - `outcome is POSTed to callbackUrl once`, against a local test server;
  - `validation`: missing text 400; options not string[] 400; timeoutMs > 3600000 400; callbackUrl not http(s) 400;
  - `clear-by-ring on an unknown id returns 404`;
  - `callback failure is logged and not retried`;
  - `binds 127.0.0.1 only`: `server.address().address === "127.0.0.1"`.
- [ ] **Step 2:** Run `node --test hub/test/internal-server.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:http`, reusing `readJson` / `sendJson` from `http.ts`.
- [ ] **Step 4:** Run `npm run test -w hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): loopback API for external queries`.

---

### Task 5: Hub: agent-webhook routing

**Files:**
- Modify: `hub/src/index-webhook.ts` (`decide`, lines ~101–110)
- Test: `hub/test/index-webhook.test.ts`

**Interfaces:**
- Consumes: `watch.onScreen()`, `watch.answer()`, `watch.prompt()`, `watch.startRingSession()`, and a new `watch.notice(text: string): void` that emits `{type:"notice", text}` to subscribers.
- Sidecar `action` values become:
  - `answered`;
  - `no_match` (with `queryId`);
  - `prompted` (with `sessionId`, sent to the open session);
  - `new_session`;
  - `kept_audio`.

`decide` order (spec §5):
1. If `onScreen().queryId` is pending, `answer(queryId, { text })`. On `no_match`, call `watch.notice("Didn't catch that")` and leave the query.
2. Else, if `onScreen().sessionId`, call `prompt(sessionId, text)`.
3. Else call `startRingSession(text)`.

A query that is pending but not on screen is never answered (Review Focus 4).

- [ ] **Step 1:** Replace the `currentTarget` tests with:
  - `on-screen pi query + "yes" answers it`;
  - `on-screen pi query + unmatched text keeps it and emits a notice frame`;
  - `on-screen ring-profile query + text resolves ring-answer`;
  - `open session, no query on screen → prompt to that session`;
  - `pending query not on screen + nothing open → new session, query untouched`;
  - `nothing on screen → new session`.
- [ ] **Step 2:** Run `node --test hub/test/index-webhook.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `decide` and `WatchService.notice`. Remove `currentTarget` and `lastShown`.
- [ ] **Step 4:** Run `npm run test -w hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): ring agent gesture answers only the on-screen query`.

---

### Task 6: Hub: Notifier (alerts when the app is closed)

**Files:**
- Create: `hub/src/notifier.ts`, `hub/src/notification-frame.ts` (only if Task 1 chose notifications)
- Modify: `hub/src/config.ts` (`watchAlert: "notification" | "launch" | "off"`, default from Task 1), `hub/src/main.ts`
- Test: `hub/test/notifier.test.ts`, `hub/test/notification-frame.test.ts`

**Interfaces:**
- Consumes:
  - `launchOnPhone(host, uuid)` (`watch-launch.ts`);
  - `watch.phone`;
  - `stream.clientCount()` (from `attachWatchStream`);
  - `QueryStore.markDelivered`;
  - `watch.onTurnAlert`.
- Produces:
  - `notificationFrame(input: { appUuid: string; itemId: string; title: string; body: string; launchCode: number; time: number }): Uint8Array`, matching the Task 1 fixture byte for byte;
  - `class Notifier { constructor(deps: { mode: "notification" | "launch" | "off"; appUuid: string; phone: () => string | null; appOpen: () => boolean; send?: (host: string, frame: Uint8Array) => Promise<boolean>; markDelivered: (queryId: string) => void; log?: (m: string) => void }); query(q: WatchQuery): Promise<void>; turn(a: { sessionId: string; kind: "finished" | "error"; title: string; text: string }): Promise<void> }`.

Launch codes: a 32-bit integer. The high bit set means a session alert; the low 31 bits index a small table `launchTargets: Map<number, { queryId } | { sessionId }>` that the Notifier keeps (last 32 entries). The watch sends the code back on launch (Task 9), and pkjs resolves it with `GET /api/watch/launch-target?code=N`, which returns `{queryId} | {sessionId} | 404`.

- [ ] **Step 1: Write the failing tests:**
  - `app open → no alert, query is delivered by showing only`;
  - `app closed, mode notification → one frame sent to phone:9000 and markDelivered called`;
  - `app closed, phone unreachable → no throw, not delivered, no retry` (Review Focus 2);
  - `mode launch → launchOnPhone called, delivered on ok`;
  - `mode off → nothing sent`;
  - `turn alert uses a session launch code` (high bit set).
  - If notification mode: `notificationFrame matches fixture` (read `hub/test/fixtures/notification-frame.hex` with the inputs from its comment line).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Wire it in `main.ts`:
  - external raises and newly visible pi queries call `notifier.query`;
  - `onTurnAlert` calls `notifier.turn`;
  - add the `launch-target` route to `watch-routes.ts`.
- [ ] **Step 4:** Run `npm run test -w hub && npm run typecheck -w hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): alert the closed watchapp`.

---

### Task 7: Phone side: bridge rewrite and message keys

**Files:**
- Modify: `watch/app/package.json` (`messageKeys`, `targetPlatforms`)
- Rewrite: `watch/app/src/pkjs/bridge.js`
- Modify: `watch/app/src/pkjs/index.js`, `watch/app/src/pkjs/config.js` (keep `HUB_URL`, `DARK`; labels "Hub URL", "Dark theme")
- Modify: `watch/shared/pkjs/hub.js` (new endpoints: `skip`, `showing{queryId,sessionId}`, `launch-target`, `abort`, `archive`)
- Test: `watch/app/test/bridge.test.js` (rewrite), `watch/app/test/hub.test.js` (update)

**Message keys:** `["MSG","CMD","CMD_ID","ID","SESSION_ID","LABEL","SOURCE","TEXT","OPTIONS","ROWS","AT","STATUS","NOTICE","NET","DARK","HUB_URL","LIST","PROVIDER","MODEL_ID","CODE","OK"]`

**Phone → watch (`MSG`)**

| MSG | Fields |
|---|---|
| `home` | `ROWS`: up to 12 rows. Rows are joined by `\x1e`; each row is `id\x1ftitle\x1fstatus\x1fsub`. status is `w`/`r`/`d`/`e`; sub is the LECO-safe time `"4:12"` (running, elapsed) or `"13:40"` (done, clock), or `""`. Title clipped to 40 chars. The whole dict ≤ 1000 B: drop rows from the end to fit. |
| `query` | `ID`, `SOURCE` (`pi`/`ring`), `LABEL` (≤ 40), `TEXT` (≤ 600), `OPTIONS` (`\x1f`-joined, each ≤ 24 chars for display; the bridge keeps the full strings to send back), `AT` (clock). Sent for the oldest visible query whenever it changes. |
| `query_gone` | `ID` |
| `reply` | `SESSION_ID`, `LABEL` (title), `TEXT` (≤ 600, the last agent turn or the live tail), `AT`, `STATUS` |
| `notice` | `NOTICE` |
| `cfg` | `DARK` (0/1) |
| `net` | `NET` (`online`/`offline`/`unconfigured`) |
| `models` | `SESSION_ID`, `LIST` (`\x1e`-joined `provider\x1fid\x1fname`) |

**Watch → phone (`CMD`)**
- `showing {ID?, SESSION_ID?}`
- `answer {ID, OPTION index as OK}`
- `skip {ID}`
- `open {SESSION_ID}` (the phone fetches `/api/watch/history?session=…&limit=1` and sends `reply`)
- `continue {SESSION_ID}` (prompt `"continue"`)
- `stop {SESSION_ID}` (abort)
- `archive {SESSION_ID}`
- `models {SESSION_ID}`
- `model {SESSION_ID, PROVIDER, MODEL_ID}`
- `launched {CODE}`

Hub additions the bridge needs, added in `hub/src/watch-routes.ts` + `watch.ts` with tests in `watch-routes.test.ts`:
- `POST /api/watch/abort {sessionId}` sends the `abort` command;
- `POST /api/watch/archive {sessionId}` adds to a set persisted at `${dataDir}/watch-archive.json` as `{[sessionId]: archivedAtMs}`; `sessionList()` omits a session while its `updatedAt <= archivedAt`.

- [ ] **Step 1: Write failing tests** in `bridge.test.js`, using the existing `test/support/fakes.js` pattern:
  - `pending frame → home dict under 1000 B with waiting rows first`;
  - `13 sessions → 12 rows max and the dict fits`;
  - `oldest visible query → query dict; resolved → query_gone then the next query` (Review Focus 1 and 4);
  - `long option is clipped for display but answer sends the full option` (Review Focus 3);
  - `answer sends {queryId, option}`;
  - `skip sends {queryId}`;
  - `reconnect after WebSocket drop re-sends home and the current query, and a queued answer is not sent twice` (Review Focus 5);
  - `notice frame → notice dict`;
  - `launched with a code fetches launch-target and sends query or reply`.
- [ ] **Step 2:** Run `node --test watch/app/test/`. Expected: FAIL.
- [ ] **Step 3:** Implement `bridge.js` (ES5) and the `hub.js` client changes, then the hub routes.
- [ ] **Step 4:** Run `npm run test:watch && npm run test -w hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(watch): phone bridge for the query protocol`.

---

### Task 8: Watch app scaffold and Home

**Files:**
- Delete: `watch/face/` (whole), the old `watch/app/src/embeddedjs/views/*`, `modules/{Menu,ListScreen,listWindow,piuView}.js` and their tests (`listWindow.test.mjs`, `scaffold.test.js` if face-specific)
- Add submodule: `git submodule add https://github.com/michaelthatsit/pebble-ui.git watch/pebble-ui` (pinned to the Task 2 commit)
- Modify: `watch/app/src/c/mdbl.c`, `watch/app/src/embeddedjs/manifest.json`, `watch/app/src/embeddedjs/main.js`, `watch/app/src/embeddedjs/modules/model.js` (rewrite)
- Create: `watch/app/src/embeddedjs/windows/home.js`, `watch/app/src/embeddedjs/theme.js`
- Modify: root `package.json` (`test:watch` → `node --test watch/app/test/`)
- Test: `watch/app/test/model.test.mjs` (rewrite)

**Interfaces:**
- `theme.js`: `export function palette(dark: boolean): { bg, fg, sub, done, pi, ring, err, wait, line }`, with `pi` = `#0055AA` on Light and `#55AAFF` on Dark, `line` = `fg`.
- `model.js` (pure, testable in node): `createModel()` returns `{ apply(dict): Change, home: Row[], query: Query|null, reply: Reply|null, dark: boolean, notice: string|null }`, where `Row = {id,title,status:"w"|"r"|"d"|"e",sub}`, and `parseRows(s)` / `parseOptions(s)` split on `\x1e` / `\x1f`.
- `main.js`:
  - `Application` with `behavior: new WindowStack`, home window `"windows/home"`, Piu lists 1024;
  - `createLink({keys,onMessage})` from `watch/shared/js/link.js`, feeding `model.apply`;
  - on `query` with the app foregrounded: push `"windows/text"` in query mode, plus one `vibration` short pulse;
  - on `query_gone` for the shown query: pop back to the window below;
  - sends `showing` on every window change.
- `windows/home.js`:
  - pebble-ui `Menu` with `highlight: ["#FFAA00", "#000000"]`, `normal: [bg, fg]`, `cellHeight: 44`;
  - a custom `Item`: title Gothic 18 Bold, sub line Gothic 14 Bold (`"Waiting · approval"`, `"Running · 4:12"`, `"Done · 13:40"`, `"Error"`; digits in LECO only if it fits the row, else Gothic), and a 10 px status dot at right (12 px from the edge, vertically centred) in the status colour, with a 1 px black outline when the row is highlighted;
  - `StatusBar({ font: "LECO_20_BOLD_NUMBERS", color: fg, background: bg })` above the menu;
  - Select sends `open` (or opens the query when the row's status is `w`).
  - Empty or offline states: one full-screen Gothic 24 Bold line: "No sessions", "Hub unreachable", or "Set the hub URL in the Pebble app".

- [ ] **Step 1: Write failing `model.test.mjs` tests:**
  - `parseRows splits rows and fields`;
  - `apply(home) replaces rows`;
  - `apply(query) then apply(query_gone same id) clears query`;
  - `query_gone for another id leaves the current query`;
  - `apply(cfg DARK=1) sets dark`.
- [ ] **Step 2:** Run `node --test watch/app/test/model.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `model.js`, `theme.js`, `main.js`, `home.js`, the manifest (map `pebble-ui/{sdk,View,WindowStack,Menu,ActionMenu,StatusBar}` as `../../../pebble-ui/modules/<X>`) and `mdbl.c` sizes. Delete the old views and face.
- [ ] **Step 4:** Run `npm run test:watch`. Expected: PASS.
- [ ] **Step 5:** In `watch/app` run `pebble build`, then `bash ../pebble-ui/tools/sizes.sh .`. Expected: build OK and archive ≤ 42,500 B.
- [ ] **Step 6:** Update `watch/app/dev/stub-hub.mjs` to serve the new `WatchPending` (3 sessions, one waiting with a pi query). Run `pebble install --emulator emery` with the stub hub, then screenshot Home in Light and Dark. Compare by eye against the prototype's Home and show Michael.
- [ ] **Step 7: Commit** `feat(watch): pebble-ui app scaffold and session list`.

---

### Task 9: Session and query screens, the drawer, and launch

**Files:**
- Create: `watch/app/src/embeddedjs/windows/text.js` (one `View` for both modes)
- Modify: `watch/app/src/embeddedjs/main.js` (launch handling)
- Test: `watch/app/test/model.test.mjs` (scroll and drawer item helpers)

**Interfaces:**
- `windows/text.js`: `push("windows/text", { mode: "session" | "query", id })`.
  - Layout:
    1. StatusBar as on Home.
    2. Header line at y 20, 22 px tall: label (Gothic 18 Bold) left and AT (LECO 20) right, both in the source colour (`pi` blue, `ring` green, session in `e` status `err`). A 1 px `fg` line at its bottom.
    3. Body: `Text` in Gothic 18 Bold (session) or Gothic 24 Bold (query), left-aligned, inset 8 px, from y 44.
  - Up/Down scroll by 40 px, clamped by the pure helper `scrollClamp(offset, contentHeight, viewHeight)` in `model.js` (Review Focus 3).
  - Select pushes `"pebble-ui/ActionMenu"` with `{ background: bg, crumb: fg, border: fg, sheet: "#000000", foreground: "#FFAA00" }`:
    - query mode: items are `options` + `"Skip"`; Select sends `answer` (index) or `skip`;
    - session mode: `Continue`, `Stop`, `Model`, `Archive`. Model sends `models`, then pushes a second ActionMenu with the names and sends `model`. Archive pops to Home.
  - On `notice`, show the text for 2 s in a black rounded box at the bottom (Gothic 18 Bold, white), as in the prototype.
  - Replies update in place on `reply`.
- `main.js`: on start, read `watch.launch.reason` / `watch.launch.arguments` using the strings recorded in Task 1. If a launch code is present, send `launched {CODE}`; the phone answers with `query` or `reply`, and the app pushes the right window above Home.

- [ ] **Step 1: Write failing tests:**
  - `scrollClamp stops at content end`;
  - `scrollClamp never negative`;
  - `drawerItems(query) appends Skip`;
  - `drawerItems(session) is Continue/Stop/Model/Archive`.
- [ ] **Step 2:** Run `node --test watch/app/test/model.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `text.js`, the helpers, and launch handling.
- [ ] **Step 4:** Run `npm run test:watch`, `pebble build`, `sizes.sh`. Expected: PASS and ≤ 42,500 B. If over, stop and report per Global Constraints.
- [ ] **Step 5:** On the emulator with the stub hub, screenshot in Light and Dark:
  - a session;
  - a long query scrolled to the end;
  - the query drawer;
  - the session drawer;
  - the "Didn't catch that" notice. The stub hub sends a `notice` frame on `POST /stub/notice`.

  Compare against the prototype and show Michael.
- [ ] **Step 6: Commit** `feat(watch): session and query screens with the action drawer`.

---

### Task 10: On-watch check, docs, cleanup

**Files:**
- Modify: `watch/README.md`, `watch/app/CLAUDE.md` (emery only, pebble-ui submodule, new protocol, sizes, stub-hub usage, internal API on 127.0.0.1:7879)
- Modify: `docs/superpowers/specs/2026-10-27-watch-ui-design.md` (status line: "implemented on feat/watch-ui-rewrite")

- [ ] **Step 1:** Run `npm test && npm run typecheck` from the repo root. Expected: PASS.
- [ ] **Step 2:** Ask Michael before installing on his Time 2 (`pebble install --phone <ip>`) and restarting the hub. Then walk through it with him:
  - open the app and check Home;
  - with `curl` on the spark, raise an external query: `curl -s -XPOST 127.0.0.1:7879/queries -d '{"label":"ring · follow-up","text":"test?","options":["A","B"],"callbackUrl":"http://127.0.0.1:9/x"}'`;
  - answer it with buttons;
  - trigger a pi approval and answer it by ring, then send an unmatched ring note;
  - close the app and raise a query, which should produce a notification or launch;
  - switch the theme in Clay.

  Record anything off as follow-ups.
- [ ] **Step 3:** Update the docs, then commit `docs(watch): new app, protocol and setup`.
