# Pebble Watch, Plan 3 of 3: Watchface + Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Alloy watchface: a fit-face style idle screen with four configurable corners, a sheet that rises over the bottom third when a request is pending, and a wrist flick that launches the pi-web watchapp; plus the hub's `POST /api/watch/launch` fallback and the hardware checklist Michael runs on his Time 2.

**Architecture:** The face is a second Alloy project, `watch/face/`, that shares the app's phone-side hub client and two watch-side modules through `watch/shared/`. Its phone side (`face.js`) is the model: it holds the stream open, picks the oldest pending request for the sheet, reports `showing`, derives the `pi` corner from the `pending` frame, fetches weather, and idles the socket after ten quiet minutes. The watch side draws with Piu: an idle group (time, corners) whose height shrinks as the sheet's container rises, both tweened by one Piu `Timeline`. A flick opens the accelerometer only while a sheet shows; the phone then tries the Pebble app's local Developer Connection first and the hub's `/api/watch/launch` second. The hub remembers the phone's tailnet address from `X-Forwarded-For` and relays the same 22-byte launch frame with Node's built-in `WebSocket` client.

**Tech Stack:** Hub: Node 26 TypeScript run directly, `node:test`, `ws` (already a dependency; tests use its server as a fake phone). Phone: PebbleKit JS (plain ES5, CommonJS, bundled by the SDK's webpack), `@rebble/clay` 1.1.0, `node:test` with the app's stubbed globals. Watch: Alloy (Moddable XS on PebbleOS, ES modules, Piu, `pebble/health`, `embedded:sensor/Battery`, `embedded:sensor/Accelerometer`, `pebble/vibes`, `piu/Timeline`), `pebble-tool` 5.0.40 + SDK 4.33.1 via `uv`, emery + gabbro emulators (`pebble emu-tap`, `emu-battery`, `emu-heart-rate`, `emu-steps`). The app's stub hub (`watch/app/dev/stub-hub.mjs`) gains face scenes.

**Spec:** `docs/superpowers/specs/2026-10-16-pebble-watch-design.md` (§6 the watchface, §6.4 phone-side code, §8 launching the app, §9 security, §11 weather, §12 layout, §13 testing, §14 milestones 1, 4 and 6, §15 risks). Plan 1 (hub) and plan 2 (stream + app) are merged or on `feat/pebble-watch-app`; this plan builds on plan 2's `watch/app/`.

## Global Constraints

- `/api/watch/launch` has the same auth as every watch route: Host and `Tailscale-User-Login`, no Origin (spec §9). The Developer Connection on the phone has no auth of its own; path 1 never leaves the phone, path 2 relies on the tailnet (spec §9).
- Launch frame, verified 2026-10-17 against `coredevices/mobileapp` (`ClientMessageType.RelayToWatch = 0x01`, `AppRunStateMessage.Message.AppRunStateStart = 0x01`, `PebblePacket.serialize`: big-endian u16 length then u16 endpoint) and `coredevices/PebbleOS` (`protocol_endpoints_table.json`: `app_run_state` = 52 = `0x0034`): `01 | 00 11 | 00 34 | 01 | <16 UUID bytes>`, 22 bytes. The Developer Connection listens on `ws://<phone>:9000/` (path `/`), binary frames only. The emulator's phone simulator (pypkjs) speaks the same protocol on `ws://127.0.0.1:<port>/`, port from `/tmp/pb-emulator.json`.
- The watchapp's UUID is `6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b` (`watch/app/package.json`); the face's is `4adac39e-f1b8-4fc6-9390-321d694dfe15`.
- Sheet: bottom 84 px on emery (228 px); the bottom segment of the same height on gabbro; 2 px rule on top; rise and shift in one Piu `Timeline`, 350 ms, `Math.quadEaseOut`; one short vibe when the pending list goes from empty to non-empty or a new request arrives while others are pending; the sheet shows the oldest pending request and never rotates (spec §6.2).
- The accelerometer is open only while a sheet shows; `onTap` only, no `onSample`. Flick means launch and nothing else. The footer reads `opening…` for at most 3 s after a flick, then `FLICK TO OPEN` again (spec §6.3, §8).
- Phone-side idle policy (face only): nothing pending and no session `running` for 10 minutes → close the socket and `GET /api/watch/pending` once a minute; the first poll that sees a request or a running session reopens the socket (spec §6.4). Reconnect back-off 1 s doubling to 30 s stays as `hub.js` has it.
- Weather at most every 20 minutes while the face runs, via `GET /api/watch/weather?lat=&lon=` with coordinates from `navigator.geolocation` on the phone (spec §6.4, §11). No API key on the watch or phone.
- Phone-side JS is plain ES5 (`var`, `function`, no template strings, arrow functions, `let`/`const` or `class`), CommonJS, `XMLHttpRequest` and `WebSocket` only; no `fetch`, no `EventSource`, no `@moddable/pebbleproxy` (spec §2, §12). Watch-side: ES modules, strict mode, every module listed in `manifest.json`, logic modules import nothing from Piu (spec §13).
- Nothing on the face is set below 14 px (spec §6.1). Type follows plan 2's ruling until a licensed LECO 1976 TTF lands: time in the system `42px Leco` (digits and colon), corners in `18px Gothic Bold`, sheet eyebrow and footer in `14px Gothic`, sheet message in `18px Gothic` (the spec's 16 px size has no system Gothic face). The font strings live in one place (`watch/face/src/embeddedjs/assets.js`) so the swap is one line plus a manifest `resources` entry.
- Dark is the default: paper black, ink white; light inverts everything (spec §6.1). Settings persist on the watch in `localStorage`.
- No cost figures anywhere on the watch (spec §1). No status line, no cursors, chevrons, scrollbars or fades (Michael's feedback 2026-10-16); the only moving things are the sheet's rise and its line scroll.
- Health is read through `pebble/health` (`Health.metric.get("heart rate")`, `Health.metric.get("step count")`) and the `watch` `health` event; no per-second polling (spec §6.5). Battery through `embedded:sensor/Battery`; time through `minutechange`.
- Code style: hub as the hub has it (tabs, double quotes, `.ts` import extensions, `node:test` + `node:assert/strict`); watch and phone JS: tabs, double quotes, semicolons. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Code size is memory in the emulator (plan 2): measure `build/mods/emery/mc.xsa` after every watch-side task and keep the face well under 42.5 KB; the app's `watch/app/src/embeddedjs/manifest.json` must not grow (Task 1 only moves modules).

## Review Focus

Inputs the spec implies but no requirement names; each has a test in the owning task.

1. The shown request is answered or dismissed elsewhere while the sheet shows it and another is pending: the next `pending` frame lacks it, the phone sends a `sheet` for the next oldest with the counter updated, and no vibe (Task 3, Task 5).
2. A flick when the phone cannot be reached (loopback refused, hub offline): both paths fail, the phone logs which, the footer reverts to `FLICK TO OPEN` after 3 s, nothing is retried on its own (Task 6).
3. `X-Forwarded-For` holds a list, is missing (direct connection), or changes between the face's requests: the hub takes the first entry, falls back to the socket's address, and launches on the most recent one (Task 2).
4. A health reading of zero or an inaccessible metric (no heart-rate sensor data yet, the emulator): the corner shows `--`, never `0 BPM`; a corner assigned `none` draws nothing (Task 4).
5. The socket goes idle, then a request arrives: the minute poll sees it, the socket reopens, and the sheet appears with the vibe, at most 60 s late; a `pending` frame received over the reopened socket that is identical to the poll's result sends no second `sheet` (Task 3).

---

## File Structure

| File | Responsibility |
|---|---|
| `watch/shared/js/format.js` | Moved from `watch/app/src/embeddedjs/modules/`: `clock`, `clipTo`, `wrapLines`, `tailLines`, toolbar strings. |
| `watch/shared/js/link.js` | Moved from the app: the watch's end of AppMessage (`createLink`). |
| `watch/shared/pkjs/hub.js` | Moved from `watch/app/src/pkjs/`: the hub client. |
| `watch/app/src/embeddedjs/manifest.json`, `watch/app/src/pkjs/index.js`, `watch/app/test/*` | Point at the shared paths. |
| `hub/src/watch-launch.ts` | `launchFrame(uuid)`, `launchOnPhone(host, uuid, opts)`. |
| `hub/src/watch.ts` | `notePhone(headers, remote)`, `phone` (the last tailnet address seen). |
| `hub/src/watch-routes.ts`, `hub/src/server.ts`, `hub/src/watch-stream.ts` | `POST /api/watch/launch`; note the phone's address on every watch request and upgrade. |
| `hub/test/watch-launch.test.ts`, `hub/test/watch-routes.test.ts` | Frame bytes, relay to a fake phone, the route. |
| `docs/watch-api.md` | Launch section. |
| `watch/face/package.json` | Alloy project: uuid, `watchface: true`, `messageKeys`, capabilities `configurable`, `health`, `location`, Clay. |
| `watch/face/CLAUDE.md` | Project notes for agents, as the app's. |
| `watch/face/src/c/mdbl.c` | Machine creation with memory sizes (no FFI). |
| `watch/face/src/embeddedjs/manifest.json` | Modules (incl. the shared ones), `config.watchface`, creation sizes. |
| `watch/face/src/embeddedjs/main.js` | Application (`touchCount: 0`), `FaceBehavior`: clock, health, battery, link, sheet state, flick. |
| `watch/face/src/embeddedjs/assets.js` | `makeTheme(dark)`: skins, styles, the font strings. |
| `watch/face/src/embeddedjs/modules/face.js` | Logic, no Piu: corner strings, date label, layout numbers, sheet text, footer, reducer over incoming dicts. |
| `watch/face/src/embeddedjs/idle.js` | Piu template: time + four corners. |
| `watch/face/src/embeddedjs/sheet.js` | Piu template: rule, eyebrow, message lines, footer; the line scroll. |
| `watch/face/src/pkjs/index.js` | Wiring: `ready`, `appmessage`, Clay, `/dev/settings` in the emulator. |
| `watch/face/src/pkjs/face.js` | Phone model: sheet selection, `showing`, `pi`, outbox, idle policy, cfg. |
| `watch/face/src/pkjs/launch.js` | `launchFrame`, loopback path, hub path, `launch()` trying both. |
| `watch/face/src/pkjs/weather.js` | Geolocation + hub weather on a 20-minute cadence, `formatTemp`. |
| `watch/face/src/pkjs/config.js` | Clay page: four corners, dark, hub URL, unit. |
| `watch/face/test/*.test.js`, `*.test.mjs` | Phone-side (CJS) and watch-side (ESM) tests. |
| `watch/app/dev/stub-hub.mjs` | Face scenes, `/api/watch/weather`, `/api/watch/launch`, `LAUNCH_PORT` in `/dev/settings`. |
| `watch/screenshots/face-*.png` | Idle and sheet, emery + gabbro, dark + light. |
| `watch/README.md`, `README.md`, `package.json` | Face sections, hardware checklist, `test:watch` covers both projects. |

## AppMessage dictionary (face)

Declared in `watch/face/package.json` `messageKeys` and in the watch's `createLink({ keys })`, in this order. Strings are UTF-8, numbers int32, booleans `0`/`1`, unknown numbers `-1`.

| Key | Type | Phone → watch | Watch → phone |
|---|---|---|---|
| `MSG` | string | `sheet` `pi` `weather` `cfg` `net` `result` | |
| `CMD` | string | | `hello` `launch` |
| `CMD_ID` | int | echoed on `result` | the watch's counter, from 1 |
| `REQ_ID` | string | `sheet`: the request id, `""` when the sheet should go away | |
| `REQ_KIND` | string | `sheet`: `dialog` `finished` `error` | |
| `REQ_TOOL` | string | `sheet`: the tool name (`bash`), or `""` | |
| `REQ_TEXT` | string | `sheet`: the message, clipped to 240 chars | |
| `REQ_INDEX` | int | `sheet`: 1-based position among pending | |
| `REQ_COUNT` | int | `sheet`: pending count | |
| `VIBE` | int | `sheet`: 1 when the watch should buzz (Task 5) | |
| `PI_RUNNING` | int | `pi`: sessions whose `state` is `running` | |
| `PI_PENDING` | int | `pi`: pending request count | |
| `TEMP` | string | `weather`: `12°` (already in the chosen unit), `""` unknown | |
| `NET` | string | `net`: `connecting` `online` `offline` `unconfigured` `idle` | |
| `OK` | int | `result`: 1 launched, 0 failed | |
| `DARK` | int | `cfg` | |
| `CORNER_TL` `CORNER_TR` `CORNER_BL` `CORNER_BR` | string | `cfg`: a widget id | |
| `UNIT` | string | `cfg`: `C` or `F` | |
| `HUB_URL` | string | Clay only (never sent to the watch) | |

Widget ids: `date` `pi` `hr` `steps` `battery` `weather` `none`. Defaults: TL `date`, TR `pi`, BL `hr`, BR `steps`. Corner strings: `date` → `THU 16`; `pi` → `2/1` (running/pending), `--` before the first frame; `hr` → `72`, `--` when the reading is 0; `steps` → `4210`; `battery` → `80%`; `weather` → `12°`, `--` unknown; `none` → `""`.

---

### Task 1: Shared modules between the two watch projects

**Files:**
- Create: `watch/shared/js/format.js` (moved), `watch/shared/js/link.js` (moved), `watch/shared/pkjs/hub.js` (moved)
- Modify: `watch/app/src/embeddedjs/manifest.json`, `watch/app/src/pkjs/index.js`, `watch/app/test/hub.test.js`, `watch/app/test/format.test.mjs`, `watch/app/CLAUDE.md`, `watch/README.md`
- Test: the moved tests, plus a build check

**Interfaces:**
- Produces: `watch/shared/js/format.js` exporting what the app's `format.js` exports today (`clipTo`, `clock(date, h24)`, `wrapLines(text, width, measure)`, `tailLines`, …); `watch/shared/js/link.js` exporting `createLink({ keys, onMessage })`; `watch/shared/pkjs/hub.js` exporting `createHubClient`, `socketUrl`, `normalizeHubUrl`.

- [ ] **Step 1: Move the three files with `git mv`** to the paths above. Leave every export unchanged.

- [ ] **Step 2: Point the app at them.** In `watch/app/src/embeddedjs/manifest.json` replace `./modules/format` and `./modules/link` with `"format": "../../../shared/js/format"` and `"link": "../../../shared/js/link"` (explicit names, since the shared files are outside the `*` glob). In `watch/app/src/pkjs/index.js` change `require("./hub")` to `require("../../../shared/pkjs/hub")`. Update the two test files' `require`/`import` paths.

- [ ] **Step 3: Verify the phone bundle includes the shared file.** Run `cd watch/app && pebble build`, then:

```bash
unzip -p build/pi-web-watch.pbw pebble-js-app.js | grep -c createHubClient
```

Expected: a count of at least 1. If the build refuses the path (the SDK's webpack carries `restrict-resource-webpack-plugin`): try a symlink instead (`ln -s ../../../shared/pkjs/hub.js watch/app/src/pkjs/hub.js`, `require("./hub")` as before) and repeat. If that fails too, ruling: keep a real `hub.js` in each project and add `watch/face/test/shared-identity.test.js` (Task 3) asserting byte equality with `watch/shared/pkjs/hub.js`; record which variant worked in `watch/README.md`.

- [ ] **Step 4: Verify the watch archive is unchanged.** `stat -c %s watch/app/build/mods/emery/mc.xsa` — expected `42455` (plan 2's final size; a move of two modules changes no bytecode). Install on emery against the stub hub (`node watch/app/dev/stub-hub.mjs --port 5173`) and confirm Home shows `PI-WEB 1/2`.

- [ ] **Step 5: Run the watch tests.** `npm run test:watch` from the repo root. Expected: 79 pass, 0 fail.

- [ ] **Step 6: Update `watch/app/CLAUDE.md` and `watch/README.md`** with one line each: shared modules live in `watch/shared/` (`js/` watch-side via manifest paths, `pkjs/` phone-side via relative `require`).

- [ ] **Step 7: Commit** `refactor(watch): move format, link and the hub client to watch/shared for the face`.

---

### Task 2: Hub: `POST /api/watch/launch` and the phone's address

**Files:**
- Create: `hub/src/watch-launch.ts`, `hub/test/watch-launch.test.ts`
- Modify: `hub/src/watch.ts`, `hub/src/watch-routes.ts`, `hub/src/server.ts`, `hub/src/watch-stream.ts`, `hub/test/watch-routes.test.ts`, `docs/watch-api.md`

**Interfaces:**
- Produces: `launchFrame(uuid: string): Uint8Array` (22 bytes); `launchOnPhone(host: string, uuid: string, opts?: { port?: number; timeoutMs?: number; WebSocketCtor?: typeof WebSocket }): Promise<{ ok: true } | { ok: false; reason: "unreachable" }>` (defaults port 9000, timeout 5000); `WatchService.notePhone(h: IncomingHttpHeaders, remote: string | undefined): void` and `WatchService.phone: string | null`; `POST /api/watch/launch` `{ uuid }` → `{ ok: true }` | `{ ok: false, reason: "no_phone" | "unreachable" }`; `WatchRouteDeps.launchFn?: typeof launchOnPhone`.

- [ ] **Step 1: Write the failing tests** in `hub/test/watch-launch.test.ts`:

```ts
test("launchFrame is RelayToWatch + a framed AppRunState start for the uuid", () => {
	const f = launchFrame("6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b");
	assert.equal(Buffer.from(f).toString("hex"), "01" + "0011" + "0034" + "01" + "6d55f4ea2ff6419ea2be1ebdfd4f8f0b");
});
test("launchFrame rejects a malformed uuid", () => {
	assert.throws(() => launchFrame("not-a-uuid"), /uuid/);
});
test("launchOnPhone sends exactly one binary frame to ws://host:port/ and resolves ok", async () => {
	// a ws WebSocketServer on 127.0.0.1:0 records messages; expect one message, 22 bytes, equal to launchFrame(uuid); the client closes after sending
});
test("launchOnPhone resolves unreachable when nothing listens, within the timeout", async () => {
	// port of a closed listener; timeoutMs 500; expect { ok: false, reason: "unreachable" } in under 1 s
});
```

- [ ] **Step 2: Run them** (`npm test -w hub -- --test-name-pattern launch`). Expected: FAIL, module not found.

- [ ] **Step 3: Implement `hub/src/watch-launch.ts`.** `launchFrame` validates `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, parses the hex, and lays out the bytes of the Global Constraints. `launchOnPhone` uses `opts.WebSocketCtor ?? globalThis.WebSocket` (Node 26's client), sets `binaryType = "arraybuffer"`, sends the frame on `open`, closes, resolves `ok`; `error`, `close` before `open`, or the timeout resolve `unreachable` (settle once; clear the timer).

- [ ] **Step 4: Remember the phone.** In `hub/src/watch.ts` add `phone: string | null = null` and `notePhone(h, remote)`: the first comma-separated entry of `h["x-forwarded-for"]` (trimmed), else `remote` with a leading `::ffff:` stripped, else unchanged. Call it in `server.ts`'s watch branch after the identity check (`deps.watch.notePhone(req.headers, req.socket.remoteAddress)`) and in `watch-stream.ts` after the upgrade's auth check.

- [ ] **Step 5: The route.** In `watch-routes.ts` add `launch` to `known`; body `{ uuid }` must be a string matching the regex above, else 400 `A uuid is required`. `watch.phone === null` → `{ ok: false, reason: "no_phone" }`; else `reply(await (deps.launchFn ?? launchOnPhone)(watch.phone, uuid))`. Log `watch: launch <uuid> on <phone>: <ok|reason>`.

- [ ] **Step 6: Route tests** in `hub/test/watch-routes.test.ts`, with `launchFn` injected and recording its arguments, on a fresh `WatchService` so no earlier request has set the phone: a launch before any other watch request → `{ ok: false, reason: "no_phone" }` and `launchFn` not called; after `GET /api/watch/health` with header `x-forwarded-for: 100.64.0.9, 10.0.0.1`, a launch calls `launchFn("100.64.0.9", uuid)` and answers its result; after a request without the header, the socket's address (`127.0.0.1`); a bad uuid → 400; `launchFn` answering `unreachable` is passed through as 200 `{ ok: false, reason: "unreachable" }`.

- [ ] **Step 7: Run the hub suite.** `npm test -w hub`. Expected: all pass (265 + the new ones).

- [ ] **Step 8: Document** in `docs/watch-api.md`: a `Launch` section with the body, the responses, the frame bytes, the Developer Connection toggle, and that the hub targets the last `X-Forwarded-For` it saw on any watch request.

- [ ] **Step 9: Commit** `feat(hub): POST /api/watch/launch relays an AppRunState start to the phone's Developer Connection`.

---

### Task 3: Face project scaffold, phone model and the idle screen

**Files:**
- Create: `watch/face/package.json`, `watch/face/CLAUDE.md`, `watch/face/src/c/mdbl.c`, `watch/face/src/embeddedjs/{manifest.json,main.js,assets.js,idle.js,modules/face.js}`, `watch/face/src/pkjs/{index.js,face.js,config.js}`, `watch/face/test/{face-model.test.js,face.test.mjs}`
- Modify: `watch/.gitignore` (already covers `build/`, `node_modules/`), root `package.json` (`test:watch` runs both `watch/app/test/` and `watch/face/test/`), `watch/app/dev/stub-hub.mjs`

**Interfaces:**
- Consumes: `createHubClient` from `watch/shared/pkjs/hub.js`; `createLink`, `clock` from `watch/shared/js/`.
- Produces (phone): `createFace(deps)` where `deps = { send(dict, onAck, onFail), storage, setTimeout, clearTimeout, now, log }`, returning `{ start(), setHub(client), onPending(frame), onStatus(s), onAppMessage(payload), onSettings(s), onWeather(temp), shown() }`. Face dicts as the dictionary table. `selectSheet(requests, currentId)` → the request with the smallest `createdAt` (ties by id), or `null`; exported for tests. `piCounts(frame)` → `{ running, pending }`.
- Produces (watch): `modules/face.js` exports `createFaceModel()` with `apply(map) → kind | null` and fields `sheet`, `pi`, `temp`, `cfg`, `net`; `cornerText(id, data)`; `dateLabel(date)`; `layout(w, h, round)`.

- [ ] **Step 1: Scaffold.** `cd watch && pebble new-project --alloy --ai face`, then rewrite `package.json`: name `pi-web-face`, displayName `pi-web face`, uuid `4adac39e-f1b8-4fc6-9390-321d694dfe15`, `projectType: "moddable"`, `enableMultiJS: true`, platforms `["emery", "gabbro"]`, `"watchapp": { "watchface": true }`, `capabilities: ["configurable", "health", "location"]`, `messageKeys` as the table (in that order), `dependencies: { "@rebble/clay": "1.1.0" }` (`pebble package install @rebble/clay`). Delete the generated `.cursor/` and rewrite the generated `CLAUDE.md` in the app's style (what the face is, where code lives, the commands, the size rule). `src/c/mdbl.c` as the app's minus the FFI line, sizes `stack 5120, slot 43008, chunk 23552` mirrored in `manifest.json` `creation`; `manifest.json` `config.watchface: true`, modules `"format": "../../../shared/js/format"`, `"link": "../../../shared/js/link"`, `"*": ["./assets", "./main", "./idle", "./modules/face"]`. Confirm the generated scaffold builds and installs on emery before changing anything else.

- [ ] **Step 2: Write the failing watch-side tests** in `watch/face/test/face.test.mjs`:

```js
test("cornerText formats each widget and shows -- without data", () => {
	assert.equal(cornerText("date", { date: new Date(2026, 9, 15, 9, 41) }), "THU 15");
	assert.equal(cornerText("pi", { pi: { running: 2, pending: 1 } }), "2/1");
	assert.equal(cornerText("pi", {}), "--");
	assert.equal(cornerText("hr", { hr: 72 }), "72");
	assert.equal(cornerText("hr", { hr: 0 }), "--");
	assert.equal(cornerText("steps", { steps: 4210 }), "4210");
	assert.equal(cornerText("battery", { battery: 80 }), "80%");
	assert.equal(cornerText("weather", { temp: "12°" }), "12°");
	assert.equal(cornerText("weather", {}), "--");
	assert.equal(cornerText("none", {}), "");
});
test("layout: emery idle and sheet heights; gabbro insets", () => {
	assert.deepEqual(layout(200, 228, false), { time: { top: 90, height: 48 }, corners: { inset: 8, top: 6, height: 22 } });
	assert.deepEqual(layout(200, 144, false), { time: { top: 48, height: 48 }, corners: { inset: 8, top: 6, height: 22 } });
	assert.deepEqual(layout(260, 260, true), { time: { top: 106, height: 48 }, corners: { inset: 65, top: 44, height: 22 } });
	assert.deepEqual(layout(260, 176, true), { time: { top: 64, height: 48 }, corners: { inset: 65, top: 30, height: 22 } });
});
test("the model applies sheet, pi, weather, cfg and net dicts and reports the kind", () => {
	// apply(new Map([["MSG","sheet"],["REQ_ID","d1"],["REQ_KIND","dialog"],["REQ_TOOL","bash"],["REQ_TEXT","Allow?"],["REQ_INDEX",1],["REQ_COUNT",2]])) → "sheet", m.sheet.id === "d1"
	// a sheet with REQ_ID "" → m.sheet === null; cfg sets m.cfg.dark and the four corners and unit; an unknown MSG → null
});
```

`layout` formula: `inset = round ? Math.round(w * 0.25) : 8`; `top = round ? Math.round(h * 0.17) : 6`; `time.top = Math.round(h / 2) - 24`; `time.height = 48`; `corners.height = 22`. (Gabbro's bottom corners at `h - top - 22` sit above the chord: at `y = 146` on a 260 px circle the half-width is 129 px.)

- [ ] **Step 3: Implement `modules/face.js`** to pass them: `DAYS = ["SUN","MON","TUE","WED","THU","FRI","SAT"]`; `cornerText` as the table; `createFaceModel` parsing a dict into plain fields (`-1`/`""` → unknown), no Piu imports.

- [ ] **Step 4: Write the failing phone-side tests** in `watch/face/test/face-model.test.js` (use `require("../../app/test/support/fakes.js")` for `FakeTimers`; `send` records dicts and acks on demand):

```js
test("selectSheet picks the oldest pending request, null when none", ...);
test("piCounts counts running sessions and pending requests", ...);
test("hello → cfg then net then pi then sheet, one dict at a time, each after the previous ack", ...);
test("a new request on an empty list sends a sheet with index/count and reports showing(requestId, null)", ...);
test("the shown request leaving the list sends the next oldest with the counter updated; the last one leaving sends REQ_ID \"\" and showing(null)", ...);
test("an identical pending frame (same ids, order and count) sends nothing", ...);
test("sheet, pi, net and cfg coalesce: the newest replaces a queued one of the same kind", ...);
test("idle policy: 10 minutes with nothing pending and nothing running closes the socket and polls once a minute; a poll with a request reopens it; net is 'idle' meanwhile", ...);
test("onSettings persists the corners, dark, unit and hub URL and sends cfg", ...);
```

- [ ] **Step 5: Implement `src/pkjs/face.js`.** A single-in-flight outbox with latest-wins per `MSG` (as plan 2's bridge, without the FIFO kinds: every face dict coalesces except `result`); `start()` sends nothing until the watch's `hello`; `onPending` stores the frame, computes `selectSheet` and `piCounts`, sends `sheet` only when the shown id, index or count changed, `pi` when its numbers changed, and calls `hub.showing(id, null)` on every change of the shown id (the face never asks for text tails). Idle: `deps.setTimeout` armed whenever a frame shows nothing pending and no `running` session; cleared by any frame that does; on firing, `hub.close()`, `net = "idle"`, then `hub.get("/api/watch/pending", cb)` every 60 s; a result with a request or a running session calls `hub.connect()` and feeds the frame through `onPending`. Settings keys in `localStorage`: `pi-web.face.corners` (JSON of four ids), `pi-web.dark`, `pi-web.hubUrl` (shared with the app on purpose: one hub URL entered once, spec §12's "twice" improved; note it in the README), `pi-web.unit`.

- [ ] **Step 6: Wiring and Clay.** `src/pkjs/index.js` as the app's: `ready` → emulator detection, stored URL or `http://127.0.0.1:5173`, `createHubClient` with `onPending: face.onPending`, `onText` ignored, `onStatus: face.onStatus`; `appmessage` → `face.onAppMessage`; `showConfiguration`/`webviewclosed` with `clay.getSettings(e.response, false)` in try/catch; in the emulator fetch `/dev/settings` and pass it to `face.onSettings`. `config.js`: heading `pi-web face`, four `select`s (`CORNER_TL` … `CORNER_BR`, options `date pi hr steps battery weather none`, defaults as the table), `toggle` `DARK` default true, `input` `HUB_URL`, `radiogroup` `UNIT` (`C`/`F`, default `C`), submit.

- [ ] **Step 7: The idle screen.** `assets.js`: `makeTheme(dark)` with `skins.paper`, `skins.ink`, styles `time: "42px Leco"` centred, `corner: "18px Gothic Bold"` left and right variants, `small: "14px Gothic"`, `body: "18px Gothic"`. `idle.js`: `Idle = Container.template($ => ...)` with a time `Label` and four corner `Label`s positioned from `layout(screen.width, height, screen.round)`; `onClockChanged(date)` updates the time via `clock(date, !watch.hour12)` and the `date` corner; `onCorners(data)` re-renders all four from `cornerText`. `main.js`: `Application` with `touchCount: 0, displayListLength: 2048, commandListLength: 2048, pixels: screen.width * 4`; `FaceBehavior.onCreate` builds the model, the link (`createLink({ keys: KEYS, onMessage })`, sends `hello`), subscribes `minutechange` (fires at once) and distributes `onClockChanged`; the model dispatch is the app's deferred-pass pattern (`onMessage` → `defer("onModelChanged")`). Dark from `localStorage` as the app, `cfg` rebuilds the theme.

- [ ] **Step 8: Stub hub.** Add to `watch/app/dev/stub-hub.mjs`: `GET /api/watch/weather` → `{ tempC: 11.5, code: 3 }`; `POST /api/watch/launch` → `{ ok: true }` (logged); `/dev/settings` also answers `CORNER_*` defaults, `UNIT: "C"` and `LAUNCH_PORT` (read from `/tmp/pb-emulator.json`: `content[<--platform, default emery>][<version key>].pypkjs.port`; `0` when unreadable or with `--no-launch-port`).

- [ ] **Step 9: Build, install, screenshot.** `cd watch/face && pebble build && pebble install --emulator emery --logs` with the stub on `--scene empty`; the face shows the time and `THU 16 | --` style corners (the emulator's health reads 0 → `--`); set `pebble emu-steps 4210`, `pebble emu-heart-rate 72`, `pebble emu-battery --pct 80` to see values when those corners are assigned. Note the archive size in the README. Screenshots `watch/screenshots/face-idle-emery-dark.png` and `-gabbro-dark.png`.

- [ ] **Step 10: Run all watch tests** (`npm run test:watch`) and **commit** `feat(face): Alloy watchface scaffold, phone model and the idle screen`.

---

### Task 4: Corner widgets: health, battery, weather, configuration, themes

**Files:**
- Create: `watch/face/src/pkjs/weather.js`, `watch/face/test/weather.test.js`
- Modify: `watch/face/src/embeddedjs/main.js`, `idle.js`, `modules/face.js`, `watch/face/src/pkjs/index.js`, `face.js`, `watch/face/test/face.test.mjs`

**Interfaces:**
- Produces: `createWeather({ hub, geolocation, setTimeout, clearTimeout, now, log, onTemp(text) })` with `start(unit)`, `setUnit(unit)`, `stop()`; `formatTemp(tempC, unit)` → `"12°"` (rounded, `F` converts). Watch-side: `Health` readings and `Battery` samples flow into the model's `data` and `onCorners`.

- [ ] **Step 1: Write the failing weather tests:** `formatTemp(11.5, "C") === "12°"`, `formatTemp(11.5, "F") === "53°"`, `formatTemp(null, "C") === ""`; `start` asks geolocation once, then `GET /api/watch/weather?lat=&lon=` with the coordinates rounded to 2 decimals, emits `onTemp("12°")`, and refetches after 20 minutes (`FakeTimers`), not before; a failed fetch keeps the last text and retries at the next 20-minute tick; `setUnit` re-emits from the cached `tempC` without a fetch; geolocation failure → `onTemp("")` and a retry at the next tick.

- [ ] **Step 2: Implement `weather.js`** to pass them (`navigator.geolocation.getCurrentPosition(ok, fail, { timeout: 15000, maximumAge: 600000 })`), wire it in `index.js` once the hub client exists; `face.js` sends `weather` with `TEMP` through the outbox (coalescing).

- [ ] **Step 3: Watch-side readings.** In `main.js`: `import Health from "pebble/health"`, `import Battery from "embedded:sensor/Battery"`. On `minutechange` read `Health.metric.get("step count")`; on the `watch` `health` event with subtype `"heart rate"` or `"significant"` read `Health.metric.get("heart rate")` and steps; a `new Battery({ onSample })` kept open, `sample().percent`. Wrap each read in try/catch (an inaccessible metric throws or returns 0 → `--`). All feed `model.data` and distribute `onCorners`.

- [ ] **Step 4: Corner assignment and theme.** `cfg` sets the four ids; `onCorners` renders by id; a `none` corner is an empty label. A `cfg` with a changed `dark` rebuilds the screen in the new theme (the app's pattern). Add the watch-side test: `cornerText` for every id from one `data` object; the model applies `cfg` corners and `unit` (unit is phone-side only, so the watch ignores it but the dict carries it).

- [ ] **Step 5: Emulator check and screenshots.** With `pebble emu-heart-rate 72`, `emu-steps 4210`, `emu-battery --pct 80`, and the stub's `/dev/settings` serving `--dark 0`: `face-idle-emery-light.png`, `face-idle-gabbro-light.png`. Reassign corners through `pebble emu-app-config --emulator emery` (opens the Clay page in a browser; on the headless spark, note in the README that the config page can be tested by POSTing the Clay response through `/dev/settings` instead) and confirm `weather` shows `12°` from the stub.

- [ ] **Step 6: Tests and commit** `feat(face): corner widgets from health, battery, weather and the pending frame`.

---

### Task 5: The sheet

**Files:**
- Create: `watch/face/src/embeddedjs/sheet.js`
- Modify: `watch/face/src/embeddedjs/main.js`, `modules/face.js`, `manifest.json` (add `"./sheet"`), `watch/face/test/face.test.mjs`, `watch/app/dev/stub-hub.mjs`, `watch/face/src/pkjs/face.js`, `watch/face/test/face-model.test.js`

**Interfaces:**
- Consumes: `wrapLines(text, width, measure)` from `format`; `Timeline` from `piu/Timeline` (as `pebble-examples/piu/apps/words` imports it); `Vibes` from `pebble/vibes`.
- Produces: `sheetText(sheet)` → `{ eyebrow, lines(width, measure), footer(opening) }`; `SHEET_HEIGHT = 84`, `RISE_MS = 350`, `SCROLL_PAUSE_MS = 2000`, `SCROLL_STEP_MS = 1500`; main's `showSheet(sheet)` / `hideSheet()` state machine; the phone's `vibe` decision carried as `REQ_INDEX` growth (see Step 1).

- [ ] **Step 1: Decide the vibe on the phone, carry it on the dict.** Add `VIBE` (int) to the dictionary and `messageKeys`: 1 when the pending list went from empty to non-empty or a request id appears that was not in the previous frame while others were pending (spec §6.2); 0 otherwise (a switch to the next oldest after the shown one left, a counter change only, a reconnect replaying the same list). Phone test: three frames (`[]` → `[a]` vibe, `[a]` → `[a, b]` vibe, `[a, b]` → `[b]` no vibe, reconnect `[b]` no vibe).

- [ ] **Step 2: Write the failing watch-side tests:** `sheetText({ kind: "dialog", tool: "bash", text: "Allow bash?\ngit push origin main", index: 1, count: 2 }).eyebrow === "PI-WEB · BASH"`; a `finished` request → `PI-WEB · DONE`, an `error` → `PI-WEB · ERROR`, a dialog without a tool → `PI-WEB · QUESTION`; `footer(false) === ["FLICK TO OPEN", "1 OF 2"]`, `footer(true) === ["opening…", "1 OF 2"]`; `lines(160, s => s.length * 8)` wraps the text (via `wrapLines`) and returns all lines, newlines honoured.

- [ ] **Step 3: Implement `sheetText` in `modules/face.js`** to pass them.

- [ ] **Step 4: `sheet.js`.** `Sheet = Container.template($ => ...)`: `left: 0, right: 0, height: SHEET_HEIGHT, top: screen.height` (off-screen), skin paper; contents: a 2 px ink rule at the top, eyebrow `Label` (14 px, 18 px line), a 44 px clip `Container` holding a `Column` of message `Label`s (18 px type, 22 px lines, inset 8 px on emery; centred on gabbro with inset 32), footer `Row` (14 px: left text and right text on emery; one centred line `FLICK TO OPEN · 1 OF 2` on gabbro, the chord at `y ≥ 240` being under 140 px wide). Line scroll: when there are more than two lines, after `SCROLL_PAUSE_MS` the column moves up one line every `SCROLL_STEP_MS` until the last line is at the bottom, pauses `SCROLL_PAUSE_MS`, then returns to the top and repeats (a `Timer.repeat`, cleared on hide and on a new request). Ruling: vertical line scroll instead of a horizontal marquee: a 240-char line on a 200 px panel is unreadable as a marquee, and the clip already wraps.

- [ ] **Step 5: The rise.** In `main.js`: `showSheet(sheet)` creates the `Sheet` if absent and runs a `Timeline`: `.to(idleGroup, { height: screen.height - SHEET_HEIGHT }, RISE_MS, Math.quadEaseOut, 0)` and `.to(sheetContainer, { top: screen.height - SHEET_HEIGHT }, RISE_MS, Math.quadEaseOut, -RISE_MS)` (parallel), driven by the application's `duration/time/start()` and `onTimeChanged` → `timeline.seekTo(time)`; the idle group re-lays its labels from `layout()` on each `onTimeChanged` (time `top` and corner positions follow the shrinking height). `hideSheet()` runs it backwards (`seekTo(duration - time)`) and removes the sheet on finish. A `sheet` dict arriving while the sheet is up only updates the texts (no animation). `VIBE === 1` → `Vibes.shortPulse()`.

- [ ] **Step 6: Stub scenes.** Add `--after <ms>` (on any scene, a second dialog `dialog:s3:d2` on `llmwiki cron` appears that long after the first socket open) and `--resolve <ms>` (the first dialog leaves that long after it appeared). Document both in the README's scene table.

- [ ] **Step 7: Emulator verification.** `--scene dialog`: the sheet is up at launch showing `PI-WEB · BASH`, `Allow bash?` / `git push origin main`, `FLICK TO OPEN` `1 OF 2`. `--scene empty --after 5000`: the face idles, then (logs show `pi-web: vibe`) the sheet rises and the time and corners move up. `--after 5000 --resolve 10000`: the counter goes to `1 OF 1` when the first leaves, and the sheet slides away when the last does. Screenshots: `face-sheet-emery-dark.png`, `face-sheet-emery-light.png`, `face-sheet-gabbro-dark.png`, `face-sheet-gabbro-light.png`, and `face-sheet-long-emery-dark.png` after the scroll has started (use the stub's 240-char `FINISHED` message on `--scene finished`).

- [ ] **Step 8: Archive size.** Note `mc.xsa` for emery in the README; if it is above 30 KB, say why (the Timeline is the only new runtime module).

- [ ] **Step 9: Tests and commit** `feat(face): the request sheet rises over the bottom third with a vibe and the pending counter`.

---

### Task 6: Flick launches the app

**Files:**
- Create: `watch/face/src/pkjs/launch.js`, `watch/face/test/launch.test.js`
- Modify: `watch/face/src/embeddedjs/main.js`, `sheet.js`, `watch/face/src/pkjs/face.js`, `index.js`, `watch/face/test/face-model.test.js`

**Interfaces:**
- Consumes: `Accelerometer` from `embedded:sensor/Accelerometer`; the hub client's `post(path, body, cb)`; the `CMD launch` / `MSG result` dicts.
- Produces: `launchFrame(uuid)` → `Uint8Array` (ES5: `new Uint8Array(22)` filled by hand); `launchViaLoopback({ WebSocket, port, timeoutMs }, uuid, cb)`; `launchViaHub(hub, uuid, cb)`; `launch(opts, uuid, cb)` trying loopback then hub, `cb(ok, path)` with `path` one of `"loopback" | "hub" | "none"`. `APP_UUID = "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b"`, `DEV_CONNECTION_PORT = 9000`, `LAUNCH_TIMEOUT_MS = 2500`.

- [ ] **Step 1: Write the failing phone-side tests** in `launch.test.js` (`FakeSocket` from the app's fakes records `send` calls; add a `binary` capture if it lacks one):

```js
test("launchFrame bytes match the hub's", () => {
	// hex of launchFrame(APP_UUID) === "0100110034016d55f4ea2ff6419ea2be1ebdfd4f8f0b"
});
test("loopback: opens ws://127.0.0.1:9000/, sends the frame once on open, closes, cb(true)", ...);
test("loopback: error before open → cb(false); no WebSocket in the runtime → cb(false) at once", ...);
test("loopback: no open within LAUNCH_TIMEOUT_MS → cb(false) and the socket is closed", ...);
test("launch tries loopback, then POST /api/watch/launch { uuid }, reports which path worked", ...);
test("launch with both failing → cb(false, 'none')", ...);
```

- [ ] **Step 2: Implement `launch.js`** to pass them. The loopback URL is `"ws://127.0.0.1:" + port + "/"`; the port is `opts.port` (`DEV_CONNECTION_PORT`, or in the emulator `LAUNCH_PORT` from `/dev/settings` when non-zero). Set `socket.binaryType = "arraybuffer"` when the property exists; send the `Uint8Array`'s `.buffer`.

- [ ] **Step 3: The watch side.** In `main.js`, while a sheet is showing hold `new Accelerometer({ onTap: () => this.flick() })`; close it in `hideSheet()` (and on `onUndisplaying`). `flick()`: if already opening, ignore; set the footer to `opening…`, `link.send("launch")`, arm a 3 s timer that restores `FLICK TO OPEN`. A `result` dict with `OK 1` leaves the footer until the timer (the app takes over the screen anyway); `OK 0` restores the footer at once.

- [ ] **Step 4: The phone side.** `face.js` `onAppMessage` on `CMD launch` → `launch(...)`, then `send({ MSG: "result", CMD_ID, OK })` (FIFO, not coalesced) and log `pi-web: launch via <path>` or `pi-web: launch failed`. Phone test: `launch` command → result 1 with path logged; both paths failing → result 0.

- [ ] **Step 5: Emulator verification, end to end.** Install the app (`cd watch/app && pebble install --emulator emery`) and the face (`cd watch/face && pebble install --emulator emery --logs`) with the stub on `--scene dialog`; `pebble emu-tap --emulator emery --direction x+`. Expected: pkjs logs `pi-web: launch via loopback` (pypkjs relays the AppRunState start to QEMU) and the screen shows the app's Home with `PI-WEB 1/2`; `pebble emu-button click back` returns to the face. Then stop the stub's `LAUNCH_PORT` (`--no-launch-port`) and tap again: `launch via hub` (the stub answers ok; nothing launches, the footer reverts after 3 s). Record both in the README.

- [ ] **Step 6: Tests and commit** `feat(face): a wrist flick launches the app through the phone's Developer Connection, or the hub`.

---

### Task 7: Round 2, net cue, size and screenshots

**Files:**
- Modify: `watch/face/src/embeddedjs/{idle.js,sheet.js,main.js,assets.js}`, `watch/face/test/face.test.mjs`, `watch/screenshots/`

- [ ] **Step 1: Round 2 pass.** On gabbro: the time centred; corners at the `layout` insets; the sheet's eyebrow and footer centred, the message centred with a 32 px inset; nothing touches the rim (check `face-sheet-gabbro-*.png`). Adjust `layout`'s constants only if the screenshots show clipping, and update the layout test's numbers with the change.

- [ ] **Step 2: Offline and idle cue.** Spec §6.1 gives the face no status line; the `pi` corner is the cue: `net` `offline` or `unconfigured` → the `pi` corner shows `OFF`; `idle` → the last counts stay. Watch-side test: `cornerText("pi", { pi: {...}, net: "offline" }) === "OFF"`.

- [ ] **Step 3: Memory.** With the sheet up and the accelerometer open, `pebble logs` must show no `memory full`/`Slot allocation` abort over ten minutes of `--after`/`--resolve` cycling (run the stub with `--after 5000 --resolve 15000` three times). Record the final `mc.xsa` size and `Heap Usage for App` in the README.

- [ ] **Step 4: Screenshot set.** Confirm these exist and are current: `face-idle-{emery,gabbro}-{dark,light}.png`, `face-sheet-{emery,gabbro}-{dark,light}.png`, `face-sheet-long-emery-dark.png`, `face-opening-emery-dark.png` (footer `opening…`, taken within 3 s of `emu-tap` with the app not installed).

- [ ] **Step 5: Tests and commit** `feat(face): Round 2 layout, offline cue, screenshots`.

---

### Task 8: README, hardware checklist, root wiring

**Files:**
- Modify: `watch/README.md`, `README.md` (root `## watch`), `package.json` (`test:watch`), `watch/face/CLAUDE.md`, `docs/watch-api.md` (cross-link)

- [ ] **Step 1: `watch/README.md`.** Retitle to "pi-web watch" with two project sections. Face: what it shows, the Clay settings, the shared hub URL key, the stub scenes and `/dev/settings` keys, the emulator commands (`emu-tap`, `emu-battery`, `emu-heart-rate`, `emu-steps`, `emu-app-config`), the launch paths with the frame bytes and the Developer Connection toggle (Pebble app → the watch → Developer Connection → on), the idle policy and its 60 s worst case, memory and archive numbers, and Known issues (fonts; emulator health values are what `emu-*` sets; geolocation in the emulator comes from pypkjs's navigator; path 1 on iOS unverified until hardware).

- [ ] **Step 2: Hardware checklist, face items** (append to the existing list; Michael records outcomes):
  - [ ] The face installs and runs on the Time 2; `Heap Usage for App` at exit.
  - [ ] Clay page saves corners, dark, hub URL, unit; corners change without a relaunch.
  - [ ] Heart rate and steps read live; battery and date correct; weather appears within a minute of launch (location permission for the Pebble app).
  - [ ] A dialog raised on the hub makes the face vibe and the sheet rise; the counter follows a second dialog; answering from the phone app drops it.
  - [ ] **Flick → which path**: `pi-web: launch via loopback` (Developer Connection toggle on), `via hub` (with the hub seeing the phone's tailnet IP in `X-Forwarded-For`), or neither → Quick Launch assignment as the manual path. Note whether the toggle survives a Pebble app restart.
  - [ ] Phone locked in a pocket for 30 minutes with a session running: does the sheet appear for a dialog raised meanwhile, and how late? Then the same with the face idle (nothing running for 10 minutes): how long from the dialog to the sheet?
  - [ ] `pi-web` muted in the Pebble app's notifications: no double delivery.
  - [ ] An Index 01 recording with the sheet up answers that request; one with nothing pending starts a session in `~/pebble/` and its finished turn reaches the sheet.

- [ ] **Step 3: Root.** `README.md` `## watch` mentions both projects; `package.json` `test:watch` runs both test directories. `docs/watch-api.md` links the face README's launch section.

- [ ] **Step 4: Run everything.** `npm test` and `npm run typecheck` from the repo root. Expected: all green, including the hub's new launch tests and both watch test directories.

- [ ] **Step 5: Commit** `docs(watch): face README, hardware checklist, root wiring`.

---

## Self-review

- Spec coverage: §6.1 idle, corners, settings, fonts → Tasks 3, 4; §6.2 sheet → 5; §6.3 flick → 6; §6.4 face transport, idle policy, weather cadence, phone-as-model → 3, 4; §6.5 battery → 3, 4; §8 paths 1–3 and `opening…` → 2, 6; §9 launch auth → 2; §11 weather → 4 (route exists since plan 1); §12 `watch/shared/`, face layout, Clay → 1, 3; §13 phone-side tests, watch-side logic tests, screenshots, hardware list → each task, 7, 8; §14 milestone 1 (the hardware spike) is the checklist's flick, suspension and Clay items, run by Michael, with the face built so that any outcome needs no rebuild (both paths and the manual fallback ship); milestone 4 → 3–7; milestone 6 → 8. Milestone 5's settings note already exists (`pi-settings.ts`, "watch").
- Type consistency: `createFace`/`face.js` names match between Tasks 3–6; `launchFrame` has the same test vector on the hub (Task 2) and the phone (Task 6); `layout` numbers in Task 3's test are the formula's outputs (emery 228: 114−24 = 90; 144: 72−24 = 48; gabbro 260: 130−24 = 106, 0.17·260 = 44.2 → 44; 176: 88−24 = 64, 0.17·176 = 29.9 → 30; 0.25·260 = 65).
- Review Focus → tests: 1 → Task 3 Step 4 and Task 5 Step 1; 2 → Task 6 Steps 1, 4; 3 → Task 2 Step 6; 4 → Task 3 Step 2 and Task 4 Step 4; 5 → Task 3 Step 4 (idle policy test, identical-frame test).
- Rulings carried from plan 2: system fonts (LECO 1976 unavailable); no `open on phone`; `@rebble/clay`. New rulings in this plan: vertical line scroll instead of a marquee (Task 5); the `pi` corner derived from the `pending` frame rather than polling `/api/watch/health` (spec §6.1 names the route; the frame already carries the counts, and the idle poll's response does too); one shared `pi-web.hubUrl` key so the URL is entered once; `VIBE` decided on the phone; corners in Gothic Bold 18 until the LECO file lands; the face's `pi` corner doubles as the offline cue.
