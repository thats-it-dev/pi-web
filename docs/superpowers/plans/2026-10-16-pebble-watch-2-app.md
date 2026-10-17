# Pebble Watch, Plan 2 of 3: Stream + Watchapp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the hub's watch state on a WebSocket and build the Alloy watchapp: see the pending request with its options, answer by button, touch or dictation, watch the current session's reply stream in with live context and speed, and switch session, read history and change model from a menu.

**Architecture:** The hub's `WatchService` fans out `pending` frames and paced `text` tails to subscribers; `hub/src/watch-stream.ts` serves them over `GET /api/watch/stream` (the `ws` package) with the same tailnet identity check as every watch route, and the long-poll stays as the fallback. On the phone, PebbleKit JS is the model: `hub.js` holds the socket (or long-polls), `bridge.js` picks the request to show, pages lists, paces one AppMessage at a time and answers the watch's commands. On the watch, Alloy (Piu) draws the screens from a small reducer (`modules/model.js`) fed by `pebble/message`; screens are Piu views behind the `words` example's controller.

**Tech Stack:** Hub: Node 26 TypeScript run directly, `node:test`, `ws@^8.18`. Phone: PebbleKit JS (plain ES5, CommonJS `require`), Clay for the settings page, `node:test` with stubbed globals. Watch: Alloy (Moddable SDK 8.3 on PebbleOS, ES modules, Piu), `pebble-tool` via `uv`, emery + gabbro emulators. A stub hub (`watch/app/dev/stub-hub.mjs`) drives the emulator deterministically.

**Spec:** `docs/superpowers/specs/2026-10-16-pebble-watch-design.md` (§5 API and §5.1 stream, §6.4 phone-side code, §7 the app, §12 layout and tooling, §13 testing). Plan 1 (hub, merged) is `2026-10-16-pebble-watch-1-hub.md`; plan 3 (face + hardware spike) follows this one.

## Global Constraints

- `/api/watch/stream` has the same auth as every watch route: Host and `Tailscale-User-Login` on the upgrade request, no Origin; a failed check answers `403` and closes (spec §5.1, §9).
- Text tails are the last 240 characters of the partial assistant message, at most every 250 ms, plus one final frame with `streaming: false`; only for the session the client last reported in `showing` (spec §5.1).
- `pending` frames keep the long-poll's coalescing: one per burst, speed ticks for the current session at most once a second (spec §5.1; `SPEED_TICK_MS` in `hub/src/watch.ts`).
- Phone-side: one AppMessage in flight; latest `home`/`stats`/`text`/`net`/`cfg` replaces a queued one of the same kind; results and list pages queue in order; stats at most once a second; list pages at most 1000 bytes (spec §6.4).
- Reconnect back-off 1 s doubling to 30 s, reset by a successful open (spec §6.4). No idle policy in the app (spec §6.4: "the app never idles").
- Phone-side JS is plain ES5 (`var`, `function`, no template strings, no arrow functions, no `let`/`const`, no `class`), CommonJS modules (`require`/`module.exports`), `XMLHttpRequest` and `WebSocket` only; no `fetch`, no `EventSource`, no `@moddable/pebbleproxy` (spec §2, §12).
- Watch-side: ES modules, strict mode, no `eval`/`Proxy`/`WeakMap`/`BigInt`; every module listed in `manifest.json`; logic modules import nothing from Piu so `node:test` can load them (spec §2, §12, §13).
- Nothing is set below 14 px; type is LECO 1976 subset to Basic Latin at 14 and 18 (spec §7.1; fallback rule in Task 6).
- Chat layout, not a terminal: user turns right-aligned, agent turns left, same ink and paper, no bubbles or fills behind turns, no cursors, `>` prompts, `▸` bullets, scrollbars or edge fades; the only position cue is the counter in the status line; an inverted *selection* bar in menus is fine (spec §7.8; Michael's feedback 2026-10-16).
- No cost figures anywhere on the watch (spec §1).
- Hub code style as the hub has it: tabs, double quotes, `.ts` import extensions, `node:test` + `node:assert/strict`, `FakeHandle` from `hub/test/support/fake-handle.ts`. Watch and phone JS: tabs, double quotes, semicolons.
- Dark is the default theme: paper black, ink white; light inverts (spec §7.1).

## Review Focus

Inputs the spec implies but no requirement names; each has a test in the owning task.

1. A request answered from the phone app while the watch shows it: the next `pending` frame lacks it, the phone reselects and sends a new `home`; a Select that races it gets `gone` and the row shows `already answered` (Task 5, Task 7).
2. The socket drops mid-reply and reconnects: the phone re-reports `showing` on every open so the hub resumes text for the current session, and the full `pending` frame replaces stale state (Task 4, Task 5).
3. Hub URL unset, wrong, or the hub down: the status line says `NO HUB URL` or `OFFLINE`, nothing crashes, an answer attempt ends in `failed` and the rows return (Task 5, Task 7).
4. Lists bigger than one AppMessage (26 sessions; 12 history turns of 240 chars): pages are chunked under 1000 bytes with no row split, and the watch merges chunks by offset without gaps or duplicates (Task 5, Task 6).
5. A `text` frame for a session that is no longer current (the watch switched sessions while the hub was still streaming the old one): dropped on the phone, never shown (Task 5).

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/src/protocol.ts` | `WatchStreamFrame`, `WatchClientFrame` wire types. |
| `hub/src/watch.ts` | `subscribe()` fan-out of `pending` frames; paced `text` tails for the shown session. |
| `hub/src/watch-stream.ts` | WebSocket endpoint: upgrade auth, frames in and out, pings, shutdown. |
| `hub/src/main.ts` | Attach the stream to the server; close it on shutdown. |
| `hub/package.json` | `ws`, `@types/ws`. |
| `app/vite.config.ts` | Dev proxy forwards WebSocket upgrades with the identity header. |
| `docs/watch-api.md` | Stream section. |
| `watch/README.md` | Toolchain, emulator, dev loop, Pebble-app setup, hardware checklist, known issues. |
| `watch/.gitignore` | `build/`, `node_modules/`. |
| `watch/app/package.json` | Alloy project manifest: uuid, platforms, `messageKeys`, Clay dependency. |
| `watch/app/src/pkjs/index.js` | Wiring only: `ready`, `appmessage`, Clay events, stub-hub dev settings. |
| `watch/app/src/pkjs/hub.js` | Hub client: socket or long-poll, reconnect, `showing`, GET/POST. |
| `watch/app/src/pkjs/bridge.js` | Phone-side model: request/session selection, outbox pacing, list paging, commands. |
| `watch/app/src/pkjs/config.js` | Clay page: hub URL, dark. |
| `watch/app/dev/stub-hub.mjs` | A fake hub for the emulator: canned requests, sessions, history, models, a scripted reply stream. |
| `watch/app/src/embeddedjs/manifest.json` | Modules, font resources, FFI, memory sizes. |
| `watch/app/src/embeddedjs/main.js` | Application, controller, link to the phone, model dispatch. |
| `watch/app/src/embeddedjs/assets.js` | `theme(dark)`: skins and styles, font strings, metrics. |
| `watch/app/src/embeddedjs/modules/model.js` | Reducer over incoming AppMessage maps; row parsing; `homeRows`; say-it state. |
| `watch/app/src/embeddedjs/modules/format.js` | Toolbar, status line, clock, query and meta strings. |
| `watch/app/src/embeddedjs/modules/link.js` | `pebble/message` wrapper: `send(cmd, fields)` with `CMD_ID`, queue until writable. |
| `watch/app/src/embeddedjs/modules/{piuController,piuView,Menu}.js` | From `pebble-examples/piu/apps/words`, adapted. |
| `watch/app/src/embeddedjs/views/{Home,MenuView,Sessions,History,ModelView}.js` | The five screens. |
| `watch/app/src/c/mdbl.c`, `watch/app/src/c/exit.c` | Machine creation with memory sizes and FFI; `pi_exit()`. |
| `watch/app/test/*.test.js`, `*.test.mjs` | Phone-side (CJS) and watch-side (ESM) unit tests. |
| `watch/screenshots/` | Emulator captures per screen, platform and theme. |
| `.claude/skills/pebble-watchface/` | The official Pebble agent skill (build/screenshot loop). |

## AppMessage dictionary

Both directions share one key set (declared in `package.json` `messageKeys` and in the watch's `new Message({ keys })`). Strings are UTF-8 strings, numbers are int32, booleans are `0`/`1`, "unknown" numbers are `-1`.

| Key | Type | Phone → watch | Watch → phone |
|---|---|---|---|
| `MSG` | string | `home` `stats` `text` `net` `result` `list` `cfg` | |
| `CMD` | string | | `hello` `answer` `dismiss` `prompt` `show` `page` `model` |
| `CMD_ID` | int | echoed on `result` | the watch's counter, from 1 |
| `REQ_ID` | string | `""` when nothing is pending | the request acted on |
| `REQ_KIND` | string | `dialog` `finished` `error` | |
| `REQ_TOOL` | string | tool name, `question`, or `""` | |
| `REQ_TEXT` | string | the hub's `message` (≤ 240) | |
| `REQ_OPTIONS` | string | the hub's options joined by `"\n"` (the watch appends `say it`/`dismiss` itself) | |
| `REQ_INDEX`, `REQ_COUNT` | int | position (1-based) and count of pending requests | |
| `SESSION_ID`, `SESSION_TITLE` | string | the request's session, or the current session | `show`, `prompt`, `page`, `model` |
| `STATE` | string | `idle` `running` `needs_you` `error` `closed` | |
| `MODEL` | string | short name or `""` | |
| `CTX_PERCENT`, `CTX_TOKENS`, `CTX_WINDOW`, `TPS` | int | `-1` when unknown | |
| `TEXT` | string | reply tail or last reply (≤ 240) | dictated text (`answer`, `prompt`) |
| `STREAMING` | int | 1 while the reply streams | |
| `NET` | string | `connecting` `online` `offline` `unconfigured` | |
| `OK`, `REASON`, `OPTIONS` | int, string, string | `result`: `REASON` ∈ `gone` `no_match` `error`; `OPTIONS` `"\n"`-joined | |
| `LIST` | string | `sessions` `history` `models` | which list to page |
| `ROWS`, `OFFSET`, `TOTAL`, `MORE` | string, int, int, int | rows `"\n"`-joined, fields `"\t"`-joined; `OFFSET` = index of the first row in this chunk (history: the turn's `i`); `MORE` = 1 while more chunks of this page follow | `page`: history `OFFSET` = earliest `i` the watch has, `-1` for the newest page |
| `OPTION` | string | | the chosen option |
| `PROVIDER`, `MODEL_ID` | string | | `model` |
| `DARK` | int | `cfg` | |
| `HUB_URL` | string | (Clay only; never sent to the watch) | |

Row formats: sessions `id\ttitle\tstate\tlive\tmodel\tctx\tage` (`ctx` is the percent or `-`; `age` is `5m`/`2h`/`3d` from `updatedAt`, `-` for live); history `i\trole\ttext`; models `provider\tid\tname\tcurrent`. Fields have tabs, newlines and carriage returns replaced by spaces.

---

### Task 1: Stream fan-out and text tails in `WatchService`

**Files:**
- Modify: `shared/src/protocol.ts` (after `WatchTurn`), `hub/src/watch.ts`
- Test: `hub/test/watch.test.ts`

**Interfaces:**
- Consumes: `WatchService` as it stands (`pending()`, `wait()`, `showing()`, `changed()`, `track()`), `contentText` from `shared/src/reducer.ts`.
- Produces:
  ```ts
  // protocol.ts
  export type WatchStreamFrame = ({ type: "pending" } & WatchPending) | { type: "text"; sessionId: string; text: string; streaming: boolean };
  export type WatchClientFrame = { type: "showing"; requestId: string | null; sessionId?: string | null };
  // watch.ts
  subscribe(fn: (f: WatchStreamFrame) => void): () => void  // nothing is sent on subscribe; the caller sends pending() itself
  subscriberCount(): number
  ```
  Constants in `watch.ts`: `TEXT_TICK_MS = 250`, `TEXT_TAIL = 240`.

- [ ] **Step 1: Write the failing tests** (append to `hub/test/watch.test.ts`, using its `setup()`, `session()`, `tick()`, `ev()` helpers)

```ts
test("subscribers get one pending frame per burst and text tails for the shown session only", async () => {
	const { registry, svc, clock } = setup();
	const h = await session(registry);
	const other = await session(registry);
	await tick();
	const frames: WatchStreamFrame[] = [];
	const off = svc.subscribe((f) => frames.push(f));
	assert.equal(svc.subscriberCount(), 1);
	svc.showing(null, "s-1");
	await tick();
	assert.equal(frames.filter((f) => f.type === "pending").length, 1);
	assert.equal((frames[0] as { showing: string | null }).showing, null);
	const stream = (fh: FakeHandle, text: string) => {
		fh.conv.partial = { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
		fh.conv.streaming = true;
		fh.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } }));
	};
	stream(h, "a".repeat(300));
	stream(other, "zzz");
	await tick();
	const texts = () => frames.filter((f) => f.type === "text");
	assert.deepEqual(texts(), [{ type: "text", sessionId: "s-1", text: "a".repeat(240), streaming: true }]);
	clock.t += 100;
	stream(h, "a".repeat(301)); // inside the 250 ms tick: no frame
	await tick();
	assert.equal(texts().length, 1);
	clock.t += 200;
	stream(h, "b".repeat(10));
	await tick();
	assert.equal(texts().length, 2);
	h.conv.partial = null;
	h.conv.streaming = false;
	h.push(ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
	await tick();
	assert.deepEqual(texts()[2], { type: "text", sessionId: "s-1", text: "done", streaming: false });
	off();
	assert.equal(svc.subscriberCount(), 0);
	clock.t += 1000;
	stream(h, "c");
	await tick();
	assert.equal(texts().length, 3);
	svc.close();
});

test("moving showing onto a session mid-reply sends its tail at once", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await tick();
	h.conv.partial = { role: "assistant", content: [{ type: "text", text: "half a reply" }] } as AgentMessage;
	h.conv.streaming = true;
	const frames: WatchStreamFrame[] = [];
	svc.subscribe((f) => frames.push(f));
	svc.showing(null, "s-1");
	await tick();
	assert.deepEqual(frames.filter((f) => f.type === "text"), [{ type: "text", sessionId: "s-1", text: "half a reply", streaming: true }]);
	svc.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hub && node --test test/watch.test.ts 2>&1 | tail -20`
Expected: FAIL, `svc.subscribe is not a function`.

- [ ] **Step 3: Add the wire types to `shared/src/protocol.ts` and implement `subscribe`/`subscriberCount` in `hub/src/watch.ts`**

Decisions the signature leaves open: keep a `private subscribers = new Set<(f: WatchStreamFrame) => void>()`; in `changed()`'s microtask, after the cursor bump, build `pending()` once when `waiters.size + subscribers.size > 0` and send `{ type: "pending", ...p }` to subscribers and `p` to waiters; add `textAt: number` to `Tracked` (initial `-Infinity`); in the `track()` observer for the shown handle, `message_update` emits `tail(contentText(h.snapshot().conv.partial?.content ?? ""))` when `now - t.textAt >= TEXT_TICK_MS` and sets `textAt`; `message_end` emits `tail(contentText(m.event.message?.content ?? ""))` with `streaming: false` and resets `textAt`; `showing()` emits a tail with `streaming: true` when the new `sessionId` differs from the old one and that handle's `conv.streaming` is true. `tail(s)` = `s.trim().slice(-TEXT_TAIL)`. `close()` clears the subscribers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hub && node --test test/watch.test.ts 2>&1 | tail -5 && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add shared/src/protocol.ts hub/src/watch.ts hub/test/watch.test.ts
git commit -m "feat(hub): WatchService fans out pending frames and paced text tails to stream subscribers"
```

---

### Task 2: `GET /api/watch/stream` over WebSocket

**Files:**
- Create: `hub/src/watch-stream.ts`, `hub/test/watch-stream.test.ts`
- Modify: `hub/package.json`, `hub/src/main.ts`, `app/vite.config.ts`, `docs/watch-api.md`, `docs/superpowers/specs/2026-10-16-pebble-watch-design.md` (one sentence, see Step 5)

**Interfaces:**
- Consumes: `WatchService.subscribe/pending/showing/subscriberCount` (Task 1), `checkHostAndLogin` from `hub/src/auth.ts`.
- Produces:
  ```ts
  export interface WatchStreamDeps { watch: WatchService; cfg: Pick<HubConfig, "hostname" | "allowedLogin">; log?: (m: string) => void; pingMs?: number } // pingMs default 30_000
  export interface WatchStream { clientCount(): number; close(): void } // close(): every socket gets 1001 "hub shutting down"
  export function attachWatchStream(server: Server, deps: WatchStreamDeps): WatchStream
  ```

- [ ] **Step 1: Add the dependency**

Run: `cd hub && npm install ws@^8.18.0 && npm install -D @types/ws@^8`
Expected: `hub/package.json` lists both; `package-lock.json` updated at the root.

- [ ] **Step 2: Write the failing tests** in `hub/test/watch-stream.test.ts`

Fixture: copy the `cfg`, `registry`, `index`, `watch`, `WATCH` headers, `raise()` and server setup from `hub/test/watch-routes.test.ts`; after `createHubServer(...)` call `const stream = attachWatchStream(server, { watch, cfg, log: () => {}, pingMs: 20 })`. The client is `import WebSocket from "ws"` (it takes `headers`; Node's global one cannot set Host). Helper `connect(headers) => Promise<{ ws, frames: WatchStreamFrame[], next(pred, ms=2000) }>`.

```ts
test("an upgrade without the tailnet identity is refused with 403, and an unknown path with 404", async () => {
	const status = (path: string, headers: Record<string, string>) => new Promise<number>((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers }); ws.on("unexpected-response", (_req, res) => r(res.statusCode ?? 0)); ws.on("error", () => {}); });
	assert.equal(await status("/api/watch/stream", { host: "hub.test:7878" }), 403);
	assert.equal(await status("/api/watch/stream", { ...WATCH, host: "evil.test" }), 403);
	assert.equal(await status("/api/elsewhere", WATCH), 404);
	assert.equal(stream.clientCount(), 0);
});
test("a client gets the current pending frame on connect, then one per change", async () => {
	const c = await connect(WATCH);
	const first = await c.next((f) => f.type === "pending");
	assert.deepEqual(first.requests, []);
	assert.equal(stream.clientCount(), 1);
	assert.equal(watch.subscriberCount(), 1);
	const { h, requestId } = await raise();
	const f = await c.next((x) => x.type === "pending" && x.requests.length === 1);
	assert.equal(f.requests[0].id, requestId);
	h.close(); c.ws.close();
});
test("a showing frame sets the hub's showing and selects the text session", async () => {
	const c = await connect(WATCH);
	const { h, requestId } = await raise();
	c.ws.send(JSON.stringify({ type: "showing", requestId, sessionId: h.sessionId }));
	await c.next((x) => x.type === "pending" && x.showing === requestId);
	assert.equal(watch.pending().showing, requestId);
	h.conv.partial = { role: "assistant", content: [{ type: "text", text: "streaming…" }] } as AgentMessage;
	h.conv.streaming = true;
	h.push({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } } });
	const t = await c.next((x) => x.type === "text");
	assert.deepEqual(t, { type: "text", sessionId: h.sessionId, text: "streaming…", streaming: true });
	h.close(); c.ws.close();
});
test("a bad frame is ignored and logged; the socket stays open", async () => { /* send "not json" and {type:"nope"}; then raise(); the pending frame still arrives */ });
test("a closed client is forgotten", async () => {
	const c = await connect(WATCH);
	await c.next((f) => f.type === "pending");
	c.ws.close();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(stream.clientCount(), 0);
	assert.equal(watch.subscriberCount(), 0);
});
test("the hub pings on the configured interval", async () => {
	const c = await connect(WATCH);
	const pinged = new Promise<void>((r) => c.ws.once("ping", () => r()));
	await Promise.race([pinged, new Promise((_, rej) => setTimeout(() => rej(new Error("no ping")), 500))]);
	c.ws.close();
});
test("stream.close() closes every client with 1001", async () => {
	const c = await connect(WATCH);
	const code = new Promise<number>((r) => c.ws.on("close", (code) => r(code)));
	stream.close();
	assert.equal(await code, 1001);
});
```
Put the `stream.close()` test last; `after()` then closes `watch` and `server`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd hub && node --test test/watch-stream.test.ts 2>&1 | tail -5`
Expected: FAIL, cannot find module `../src/watch-stream.ts`.

- [ ] **Step 4: Implement `hub/src/watch-stream.ts`**

`new WebSocketServer({ noServer: true })`. `server.on("upgrade", (req, socket, head) => …)`: parse the path; not `/api/watch/stream` → write `HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n` and `socket.destroy()`; `checkHostAndLogin(cfg, req.headers)` fails → the same with `403 Forbidden`, logged like the routes do (`rejected UPGRADE <url>: <reason>`); else `wss.handleUpgrade(...)` and `wss.emit("connection", ws)`. On connection: `ws.send(JSON.stringify({ type: "pending", ...watch.pending() }))`, `const off = watch.subscribe((f) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(f)))`; `message` → `JSON.parse`, accept only `{ type: "showing" }` with a string-or-null `requestId` and optional string-or-null `sessionId`, call `watch.showing(requestId, sessionId ?? null)`, anything else logged `watch stream: ignored frame`; `isAlive` flag per socket set by `pong`, a `setInterval(pingMs)` that `terminate()`s a socket whose flag is still false from the previous round, then clears the flag and `ping()`s; `close` → `off()`, remove from the set. `close()` clears the interval and calls `ws.close(1001, "hub shutting down")` on each.

- [ ] **Step 5: Wire `main.ts`, the dev proxy, and the docs**

`hub/src/main.ts`: after `createHubServer(...)`, `const stream = attachWatchStream(server, { cfg, watch, log })`; in the shutdown path call `stream.close()` before `watch.close()`.

`app/vite.config.ts`: the `/api` proxy entry gets `ws: true`, and the header stamping moves into a function registered for both `proxy.on("proxyReq", stamp)` and `proxy.on("proxyReqWs", stamp)`.

`docs/watch-api.md`: add a `## Stream` section before `## Long-poll` with the frame tables from spec §5.1 and a `wscat`-free example using Node: `node -e 'const ws = new (require("ws"))(process.argv[1], { headers: { host: "<hostname>", "tailscale-user-login": "<login>" } }); ws.on("message", (m) => console.log(String(m)))' wss://<hostname>/api/watch/stream` (from the hub's workspace, where `ws` is installed). Say that from a tailnet device the headers are added by tailscale serve and a browser's `new WebSocket(...)` is enough. Rename the `## Long-poll` intro to say it is the fallback.

Spec §5.1: change "`WatchService.close()` closes every socket with code 1001" to "hub shutdown closes every socket with code 1001".

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd hub && node --test test/watch-stream.test.ts test/watch-routes.test.ts 2>&1 | tail -5 && npm run typecheck && cd ../app && npm run typecheck`
Expected: all pass; both typechecks clean.

- [ ] **Step 7: Commit**

```bash
git add hub/package.json package-lock.json hub/src/watch-stream.ts hub/src/main.ts hub/test/watch-stream.test.ts app/vite.config.ts docs/watch-api.md docs/superpowers/specs/2026-10-16-pebble-watch-design.md
git commit -m "feat(hub): GET /api/watch/stream serves pending frames and text tails over WebSocket"
```

---

### Task 3: Toolchain, emulator smoke test, and the `watch/app` scaffold

**Files:**
- Create: `watch/README.md`, `watch/.gitignore`, `watch/app/` (scaffold), `.claude/skills/pebble-watchface/` (copied skill)
- Modify: root `package.json` (`test:watch` script, included in `test`)

**Interfaces:**
- Produces: a building Alloy project at `watch/app` with `package.json` → `pebble.displayName` `"pi-web"`, a fixed `uuid` (generate once with `uuidgen`, commit it), `targetPlatforms: ["emery", "gabbro"]`, `watchapp.watchface: false`, `capabilities: ["configurable"]`, and `messageKeys` = every key in the dictionary table above (including `HUB_URL`). Everything later builds here.

- [ ] **Step 1: Install the toolchain**

Run, in order (record exact versions in `watch/README.md`):
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh    # if `uv` is missing; then open a new shell or source ~/.local/bin/env
uv tool install pebble-tool
pebble --version
pebble sdk install latest
pebble sdk list
```
Expected: `pebble --version` prints a version; `pebble sdk list` shows the installed SDK as active.

- [ ] **Step 2: Emulator smoke test on an example**

Run from a scratch clone of `https://github.com/Moddable-OpenSource/pebble-examples` (outside the repo):
```bash
cd hellopebble && pebble build && pebble install --emulator emery && pebble logs --emulator emery
```
Expected: the build produces `build/hellopebble.pbw`; the emulator starts; logs show the example's `hello` line. The spark is headless: if qemu refuses for want of a display, try the tool's VNC option (`pebble install --emulator emery --vnc` if present, else run under `xvfb-run`) and write the invocation that worked into `watch/README.md`. Then `pebble screenshot --no-open /tmp/hello.png` and confirm the PNG is 200×228.

- [ ] **Step 3: Scaffold the app and install the skill**

```bash
mkdir -p watch && cd watch && pebble new-project --alloy --ai app   # drop --ai if the tool rejects it
cd app && pebble package install pebble-clay
```
Then edit `watch/app/package.json`'s `pebble` section as the Interfaces block says; keep the generated `CLAUDE.md` if `--ai` produced one. Write `watch/.gitignore` with `build/` and `node_modules/`. Copy `skills/pebble-watchface` from a scratch clone of `https://github.com/coredevices/pebble-watchface-agent-skill` to `.claude/skills/pebble-watchface` in the repo. Root `package.json`: add `"test:watch": "node --test watch/app/test/"` and append `&& npm run test:watch` to `test`; create `watch/app/test/.gitkeep` so the script finds the directory.

- [ ] **Step 4: Build and install the scaffold**

Run: `cd watch/app && pebble build && pebble install --emulator emery && pebble install --emulator gabbro`
Expected: both builds succeed and the scaffold's default screen shows on both emulators (`pebble screenshot --no-open`).

- [ ] **Step 5: Write `watch/README.md`**

Sections: Toolchain (the commands and versions from Step 1), Emulator (build/install/screenshot/logs/`emu-button`, the headless invocation from Step 2), Dev loop (placeholder for the stub hub, filled in Task 5), Pebble app setup (one line for now: mute pi-web notifications; the rest comes in Task 11), Hardware checklist (empty list, filled in Task 11).

- [ ] **Step 6: Commit**

```bash
git add watch .claude/skills/pebble-watchface package.json
git commit -m "chore(watch): Alloy app scaffold, toolchain notes, and the Pebble agent skill"
```

---

### Task 4: The phone-side hub client

**Files:**
- Create: `watch/app/src/pkjs/hub.js`, `watch/app/test/hub.test.js`

**Interfaces:**
- Produces (CommonJS, ES5):
  ```js
  // module.exports = { createHubClient: createHubClient, socketUrl: socketUrl }
  // createHubClient(opts) with opts:
  //   url            hub base URL without trailing slash, e.g. "https://spark.tail.ts.net:7878"
  //   WebSocket      constructor, or null/undefined → long-poll fallback
  //   XMLHttpRequest constructor
  //   setTimeout, clearTimeout
  //   onPending(frame)  frame is the WatchPending object (type field removed)
  //   onText(frame)     { sessionId, text, streaming }
  //   onStatus(status)  "connecting" | "online" | "offline"
  // returns { connect(), close(), showing(requestId, sessionId), get(path, cb), post(path, body, cb), transport() }
  //   transport() → "ws" | "poll" | null (null before connect)
  //   cb(err, json): err is an Error with .status when the hub answered non-2xx
  // socketUrl(base) → base with http→ws / https→wss + "/api/watch/stream"
  ```

- [ ] **Step 1: Write the failing tests** in `watch/app/test/hub.test.js` (CommonJS, `node:test`)

Fakes: `FakeSocket` (records `url`; `send(s)` pushes to `sent`; `close()` sets `closed`; the test fires `onopen()`, `onmessage({ data })`, `onclose()`, `onerror()`), `FakeXhr` (records `method`, `url`, `headers`, `body`, `timeout`; the test calls `respond(status, text)` → sets `status`, `responseText`, calls `onload()`; `fail()` → `onerror()`; `expire()` → `ontimeout()`), `FakeTimers` (`setTimeout` returns an id and records `{ fn, ms }`; `fire(n)` runs the n-th pending; `pending()` lists delays).

```js
test("socketUrl maps http(s) to ws(s) and appends the stream path", ...);  // https://h:7878 → wss://h:7878/api/watch/stream ; http://127.0.0.1:5173 → ws://127.0.0.1:5173/api/watch/stream
test("with a WebSocket: connecting, open → online, pending and text frames are dispatched", ...); // statuses ["connecting","online"]; onmessage with {"type":"pending",...} → onPending receives the object without `type`; text → onText
test("showing goes over the open socket as a frame, and over POST when the socket is not open", ...); // sent[0] === '{"type":"showing","requestId":"r1","sessionId":"s1"}' ; before open → an XHR POST /api/watch/showing with the same body
test("close → offline and a reconnect after 1 s, then 2, 4 … capped at 30 s; an open resets to 1 s", ...); // pending delays [1000], [2000], [4000], ..., 30000, 30000
test("without a WebSocket it long-polls: GET pending?since=0&wait=1 with timeout 35000, then since=<cursor>", ...); // transport() === "poll"; respond(200, '{"cursor":7,...}') → onPending, status online, next GET has since=7
test("a failed poll → offline and the same back-off", ...);
test("post sends JSON with content-type and 15 s timeout; non-2xx → err.status; parse failure → err", ...);
test("close() stops reconnects and polling and closes the socket", ...);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test watch/app/test/hub.test.js 2>&1 | tail -5`
Expected: FAIL, cannot find module `../src/pkjs/hub.js`.

- [ ] **Step 3: Implement `watch/app/src/pkjs/hub.js`**

ES5 only. Back-off state: `delay` starts at 1000, doubles to a cap of 30000, resets to 1000 on socket `open` or a 2xx poll. The poll loop: `GET /api/watch/pending?since=<cursor>&wait=1`, `xhr.timeout = 35000`, on 2xx parse and `onPending`, status `online`, loop at once; on error/timeout/non-2xx status `offline` and schedule the next poll after `delay`. `showing()` in poll mode and before the socket is open POSTs `/api/watch/showing`. `connect()` is idempotent; `close()` sets a `closed` flag every callback checks.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test watch/app/test/hub.test.js 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add watch/app/src/pkjs/hub.js watch/app/test/hub.test.js
git commit -m "feat(watch): phone-side hub client with WebSocket stream and long-poll fallback"
```

---

### Task 5: The phone-side model: `bridge.js`, `index.js`, Clay, and the stub hub

**Files:**
- Create: `watch/app/src/pkjs/bridge.js`, `watch/app/src/pkjs/config.js`, `watch/app/dev/stub-hub.mjs`, `watch/app/test/bridge.test.js`
- Modify: `watch/app/src/pkjs/index.js`, `watch/README.md` (Dev loop)

**Interfaces:**
- Consumes: `createHubClient` (Task 4). The dictionary table above.
- Produces (CommonJS, ES5):
  ```js
  // module.exports = { createBridge, selectRequest, selectSession, packRows, packHome, packStats, clean, ageLabel }
  // createBridge(deps):
  //   deps.hub       { showing, get, post } (createHubClient result); replaceable with bridge.setHub(hub)
  //   deps.send(dict, onAck, onFail)   wraps Pebble.sendAppMessage
  //   deps.storage   { getItem(k), setItem(k, v) }   keys "pi-web.lastSession"
  //   deps.setTimeout, deps.clearTimeout, deps.now, deps.log
  // bridge: start(), setHub(hub), onPending(frame), onText(frame), onStatus(status), onAppMessage(payload), onSettings({ HUB_URL, DARK }), current() → { requestId, sessionId }
  // selectRequest(requests, currentId, hubShowing) → request | null   // current if still present, else hub's showing if present, else oldest by createdAt
  // selectSession(sessions, lastSessionId) → session | null           // lastSessionId if listed, else most recently updated live, else most recently updated closed
  // packRows(rows, maxBytes) → [string]  // rows joined by "\n" per chunk, UTF-8 byte length ≤ maxBytes, a row never split, an oversize row alone
  // packHome(req, index, count, session, lastText) → dict ; packStats(session) → dict ; clean(s) → s without \t \n \r, trimmed ; ageLabel(ms) → "5m" | "2h" | "3d"
  ```

- [ ] **Step 1: Write the failing tests** in `watch/app/test/bridge.test.js`

Fakes: `hub` records `calls` (`{ kind: "post"|"get"|"showing", path, body }`) and lets the test answer the last call with `reply(err, json)`; `send` records `dicts` and lets the test `ack()` or `fail()` the one in flight; `FakeTimers` from Task 4's test (move it to `watch/app/test/support/fakes.js` and require it from both). Fixtures: `pending(requests, sessions, showing)` builder; two requests `r1` (dialog, session `s1`, options `["allow","deny"]`, createdAt 1) and `r2` (finished, `s2`, createdAt 2); sessions `s1` running (ctx 41, tps 62, model `qwen3`), `s2` idle live, `s3` closed `updatedAt` 2 h ago.

```js
test("hello → cfg, net, home in that order, one at a time until acked", ...);  // after onAppMessage({CMD:"hello",CMD_ID:1}): dicts.length === 1 and dicts[0].MSG === "cfg"; ack() → net; ack() → home with REQ_ID ""
test("a pending frame selects the oldest request, reports showing, and sends home + stats", ...); // home: REQ_ID "r1", REQ_INDEX 1, REQ_COUNT 2, REQ_OPTIONS "allow\ndeny", SESSION_TITLE; hub.calls has showing r1/s1; stats CTX_PERCENT 41, TPS 62, MODEL "qwen3", STATE "running"
test("the current request stays current when an older one appears; index and count follow", ...); // current r1; new frame adds r0 (createdAt 0): home REQ_ID still "r1", REQ_INDEX 2, REQ_COUNT 3
test("with nothing current the hub's showing wins over the oldest", ...);
test("answer ok: POST body, result OK 1, the next request becomes home without waiting for the hub", ...); // onAppMessage({CMD:"answer",CMD_ID:5,REQ_ID:"r1",OPTION:"allow"}) → post /api/watch/answer {requestId:"r1",option:"allow"}; reply(null,{ok:true}) → result {CMD_ID:5,OK:1}; then home REQ_ID "r2"
test("answer no_match and gone carry REASON and OPTIONS; a network error is REASON error", ...);
test("a request answered elsewhere disappears from the next frame: home moves on (Review Focus 1)", ...);
test("nothing pending: home carries the current session by the lastSession rule and TEXT from history", ...); // storage lastSession "s2" → home SESSION_ID "s2", STATE "idle"; a GET /api/watch/history?session=s2&limit=4 is made; reply with turns [{role:"you",...},{role:"agent",text:"the last reply"}] → home TEXT "the last reply"
test("text frames for the current session → text dicts; for another session → dropped (Review Focus 5)", ...);
test("coalescing: three text frames before an ack leave one queued text dict, the latest", ...);
test("stats go at most once a second", ...); // two frames with different tps inside 1000 ms → one stats dict (first) then after timers fire the second with the latest value
test("packRows: chunks under 1000 bytes, rows never split, oversize row alone, MORE on all but the last", ...);
test("page history → GET history?session=&before=&limit=12, list dicts with OFFSET = first row's i", ...); // OFFSET -1 → no before param; OFFSET 30 → before=30
test("page sessions comes from the stored frame with no fetch; rows are id\\ttitle\\tstate\\tlive\\tmodel\\tctx\\tage", ...); // s3 → "...\tclosed\t0\tqwen3\t-\t2h"
test("show by SESSION_ID switches current, reports showing(null, s), sends home + stats; show by REQ_ID selects that request", ...);
test("status → net dict; going online after offline re-reports showing (Review Focus 2)", ...);
test("selectSession: last if listed, else newest live, else newest closed; clean() strips tabs and newlines", ...);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test watch/app/test/bridge.test.js 2>&1 | tail -5`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `watch/app/src/pkjs/bridge.js`**

Outbox: `queue` array; `enqueue(dict)` replaces a queued dict with the same `MSG` when `MSG` is one of `home stats text net cfg`, else pushes; `pump()` sends when nothing is in flight; `onFail` retries once after 500 ms then drops and logs. Stats limiter: remember `statsAt`; if less than 1000 ms since, schedule a trailing send of the latest. Last-reply cache: `lastText[sessionId]` set from a `text` frame with `streaming: 0`, else fetched from history (last `agent` turn of `limit=4`) when a session becomes current without one. `TEXT` in `home` is the cached last reply (or `""`). `REQ_TEXT` and `TEXT` are clipped to 240 characters after `clean()` is applied to list fields only (request text keeps its newlines). State field: a closed session (`live: false`) is `"closed"`.

- [ ] **Step 4: Write `index.js` and `config.js`**

`index.js`: on `ready`, `var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo(); var qemu = info && /^qemu/.test(info.model || "")`; `url = localStorage.getItem("pi-web.hubUrl") || (qemu ? "http://127.0.0.1:5173" : null)`; with no URL → `bridge.onStatus("unconfigured")` (the bridge maps it to `NET: "unconfigured"`); else build the client with `WebSocket: typeof WebSocket === "function" ? WebSocket : null`, `XMLHttpRequest`, the globals' timers, and the bridge's callbacks, then `connect()`. `appmessage` → `bridge.onAppMessage(e.payload)`. Clay: `var Clay = require("pebble-clay"); var clay = new Clay(require("./config"), null, { autoHandleEvents: false })`; `showConfiguration` → `Pebble.openURL(clay.generateUrl())`; `webviewclosed` → `var s = clay.getSettings(e.response)` → `localStorage.setItem("pi-web.hubUrl", s.HUB_URL)`, `localStorage.setItem("pi-web.dark", s.DARK ? "1" : "0")`, `bridge.onSettings(s)` (which sends `cfg`), and if the URL changed, close the old client, create a new one, `bridge.setHub(newClient)`, `connect()`. When `qemu`, also `GET /dev/settings` on the hub URL at ready and feed the JSON to `bridge.onSettings` so the stub hub can switch themes. `config.js`: Clay JSON with a heading `pi-web`, an `input` `HUB_URL` (label `Hub URL`, placeholder `https://host:7878`), a `toggle` `DARK` (label `Dark`, default `true`), and a submit button.

- [ ] **Step 5: Write the stub hub** `watch/app/dev/stub-hub.mjs`

Node ESM, `import { WebSocketServer } from "ws"` (resolved from the root `node_modules`), `node watch/app/dev/stub-hub.mjs --port 5173 [--scene dialog|finished|empty|stream] [--dark 0|1]`. No auth. Serves: `/api/watch/stream` (sends a `pending` frame for the scene on connect; `stream` scene also streams a `text` tail growing by a sentence every 250 ms for 6 s then `streaming: false`), `/api/watch/pending`, `/api/watch/sessions` (three live, twenty-three closed so paging shows), `/api/watch/history` (40 turns of mixed roles, some 240 chars), `/api/watch/models` (4 rows), POSTs that answer `{ ok: true }` (answer `deny` on the dialog scene answers `{ ok: false, reason: "no_match", options: [...] }` when `text` is sent), and `/dev/settings` → `{ "DARK": <--dark> }`. Fixtures live at the top of the file as plain objects. Document it in `watch/README.md` under Dev loop: start the stub, `pebble install --emulator emery`, screenshots; and the real-hub variant (`npm run dev -w hub` + `npm run dev -w app`, hub URL `http://127.0.0.1:5173`).

- [ ] **Step 6: Run the tests, build, and smoke the phone side on the emulator**

Run: `node --test watch/app/test/ 2>&1 | tail -5 && cd watch/app && pebble build`
Expected: all pass; build clean. Then `node watch/app/dev/stub-hub.mjs --port 5173` (from the repo root, in the background), `pebble install --emulator emery && pebble logs --emulator emery`: the logs show the pkjs connecting (log the transport once: `pi-web: ws online` or `pi-web: poll online`) and `home` being sent. Record which transport the emulator's phone simulator gave in `watch/README.md` (this settles spec §15's open question for the emulator).

- [ ] **Step 7: Commit**

```bash
git add watch/app/src/pkjs watch/app/dev watch/app/test watch/README.md
git commit -m "feat(watch): phone-side model, Clay settings, and a stub hub for the emulator"
```

---

### Task 6: Watch-side logic modules, theme, manifest and fonts

**Files:**
- Create: `watch/app/src/embeddedjs/modules/model.js`, `modules/format.js`, `watch/app/src/embeddedjs/assets.js`, `watch/app/resources/fonts/LECO1976-Regular.ttf` + its licence file, `watch/app/test/model.test.mjs`, `watch/app/test/format.test.mjs`
- Modify: `watch/app/src/embeddedjs/manifest.json`, `watch/app/src/c/mdbl.c`

**Interfaces:**
- Produces (ES modules; `model.js` and `format.js` import nothing):
  ```js
  // model.js
  export function createModel() → m
  //   m.apply(map) → "home"|"stats"|"text"|"net"|"result"|"list"|"cfg"|null   (map: Map<string, string|number> from pebble/message read())
  //   m.home   { requestId, kind, tool, text, options: string[], index, count, sessionId, sessionTitle, lastText } | null
  //   m.stats  { sessionId, state, model, ctxPercent, ctxTokens, ctxWindow, tps } | null      (numbers null when -1)
  //   m.text   { sessionId, text, streaming } | null
  //   m.net    "connecting"|"online"|"offline"|"unconfigured"   (initial "connecting")
  //   m.cfg    { dark: boolean }
  //   m.lists  { sessions: List, history: List, models: List }  List = { rows: object[], total, complete }  merged by OFFSET, no duplicates; a new page request calls m.resetList(kind)
  //   m.takeResult(cmdId) → { ok, reason, options } | null
  //   m.sayIt  { text, status: "idle"|"listening"|"sending"|"sent"|"no_match"|"failed" }  via m.setSayIt(patch)
  export function parseRows(kind, rows) → objects per the row formats (sessions: {id,title,state,live,model,ctx,age}; history: {i,role,text}; models: {provider,id,name,current})
  export function homeRows(home) → string[]   // dialog: options…, "say it"; finished/error: "say it", "dismiss"; nothing pending: "say it", "menu"
  // format.js
  export function toolbar(stats) → { ctx: "42%"|"--", percent: number|null, speed: "62 T/S"|"--", model: "QWEN3"|"" }
  export function statusLeft(home, net) → "CONNECTING" | "OFFLINE" | "NO HUB URL" | "PI-WEB n/m"
  export function clock(date, h24) → "9:05" (12-hour, no leading zero, no AM/PM) or "21:05" (24-hour, two digits)
  export function queryText(home) → dialog with tool: "<tool>: <text>"; else text
  export function hint(home, stats) → "<TITLE> · <STATE>" upper-cased, title clipped to 20
  export function sessionMeta(row) → live: "RUNNING · QWEN3 · 42%"; closed: "CLOSED · 2h"
  export function menuMeta(stats) → "<model> · <state>" and "<used>k of <window>k" as [line1, line2]
  export function clipTo(s, n) → s or s.slice(0, n - 1) + "…"
  ```

- [ ] **Step 1: Write the failing tests** (`.mjs`, `node:test`, `import`)

`model.test.mjs`: build Maps with `new Map(Object.entries({...}))`.
```js
test("apply(home) → home with options split and lastText; REQ_ID '' → requestId null", ...);
test("apply(stats) maps -1 to null; apply(text), apply(net), apply(cfg)", ...);
test("list chunks merge by OFFSET without duplicates; complete when MORE is 0; resetList clears", ...); // history chunks OFFSET 28 (rows 28..33, MORE 1) and OFFSET 34 (rows 34..39, MORE 0) → rows sorted by i, length 12; applying OFFSET 28 again → still 12
test("takeResult returns a result once", ...);
test("parseRows per kind; homeRows per kind", ...); // dialog ["allow","deny","say it"]; finished ["say it","dismiss"]; null home ["say it","menu"]
```
`format.test.mjs`: exact strings: `toolbar({ctxPercent:41,tps:62,model:"qwen3"})` → `{ ctx: "41%", percent: 41, speed: "62 T/S", model: "QWEN3" }`; null fields → `"--"`, `""`; `statusLeft(null, "connecting")` → `CONNECTING`; `statusLeft({index:1,count:2}, "online")` → `PI-WEB 1/2`; `statusLeft(null, "online")` → `PI-WEB 0/0`; `statusLeft(null, "unconfigured")` → `NO HUB URL`; `clock(new Date(2026,9,16,21,5), false)` → `9:05`; `clock(..., true)` → `21:05`; `queryText({tool:"bash", text:"Allow git push?\norigin"})` → `bash: Allow git push?\norigin`; `sessionMeta` both forms; `menuMeta({model:"qwen3",state:"idle",ctxTokens:52000,ctxWindow:128000})` → `["QWEN3 · IDLE", "52k of 128k"]`; `clipTo("abcdef", 4)` → `abc…`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test watch/app/test/ 2>&1 | tail -5`
Expected: the two new files fail to import.

- [ ] **Step 3: Implement `model.js` and `format.js`**

Pure functions and one closure; no Piu imports. `homeRows` follows spec §7.2/§7.5 (ruling: §4's `open on phone` row is dropped; §7.2, the screen spec, lists options, `say it`, and `dismiss` for finished/error, and the rows are never empty without it).

- [ ] **Step 4: Fonts, theme, manifest, memory**

Font: download LECO 1976 (`LECO1976-Regular.ttf`) from Font Library (`https://fontlibrary.org/en/font/leco-1976`) with its licence text into `watch/app/resources/fonts/`. If the licence does not permit redistribution, do not commit the TTF: set `FONT_FAMILY = "Gothic"` in `assets.js` (system `14px Gothic` / `18px Gothic`) and record the swap in `watch/README.md` known issues. `assets.js`: `export const FONT = "LECO1976"`, `export const SIZES = { small: 14, body: 18 }`, `export const METRICS = { status: 18, toolbar: 16, rule: 2, row: 32, row2: 44, bar: 60 }`, `export function theme(dark) → { paper, ink, dim, skins: { paper, ink, dim, rule }, styles: { small, smallRight, body, bodyRight, meta } }` with `dim` `"#AAAAAA"` on colour screens; styles use `font: "14px LECO1976"` / `"18px LECO1976"` and `leading` 1.2× for `body`. `manifest.json`: `config.creation` `{ stack: 5120, slot: 31744, chunk: 19456 }` (from `words`), `modules`: `"piu/Controller": "./modules/piuController"`, `"piu/View": "./modules/piuView"`, `"Menu": "./modules/Menu"`, `"*": ["./assets", "./main", "./modules/model", "./modules/format", "./modules/link", "./views/*"]`; `resources."*-alpha"`: the font at sizes 14 and 18 with `"monochrome": true, "blocks": ["Basic Latin"]`. `mdbl.c`: the same three sizes in `ModdableCreationRecord`.

- [ ] **Step 5: Run the tests and build**

Run: `node --test watch/app/test/ 2>&1 | tail -5 && cd watch/app && pebble build`
Expected: all pass; build clean (the font resources compile; an unknown module name fails here, not at runtime).

- [ ] **Step 6: Commit**

```bash
git add watch/app/src/embeddedjs watch/app/src/c watch/app/resources watch/app/test watch/README.md
git commit -m "feat(watch): watch-side model and format modules, theme, LECO font, manifest"
```

---

### Task 7: Controller, link, and the Home screen

**Files:**
- Create: `watch/app/src/embeddedjs/modules/link.js`, `modules/piuController.js`, `modules/piuView.js`, `modules/Menu.js`, `watch/app/src/embeddedjs/views/Home.js`, `watch/app/src/c/exit.c`, `watch/screenshots/`
- Modify: `watch/app/src/embeddedjs/main.js`, `manifest.json` (ffi block), `src/c/mdbl.c` (`fxBuildFFI`)

**Interfaces:**
- Consumes: `createModel`, `homeRows`, `format.*`, `theme` (Task 6); the phone's `home`/`stats`/`net`/`result` dicts (Task 5).
- Produces:
  ```js
  // link.js
  export function createLink({ keys, onMessage }) → { send(cmd, fields) → cmdId, writable }  // wraps pebble/message; queues until onWritable; CMD_ID counter from 1; onReadable → onMessage(map)
  // main.js
  globalThis.controller: PiController extends Controller with .model (createModel()), .link, .dark, .theme, .clock, .exit()
  //   incoming map → kind = model.apply(map) → container.distribute("onModel", kind); "cfg" also persists dark and calls redisplay()
  //   exit(): Natives.pi_exit() in a try/catch
  // Views receive onModel(container, kind) and the controller's onClockChanged.
  // Menu.js: default export View with rows from $.items ({ title, meta? }); events onSelect(container, index, item); row height 32, 44 with meta; Inverter selection bar on every screen (no colour variant); onPressSelect/onReleaseSelect are left to the containing view (hold detection)
  // Home.js: default export View; the request screen and the nothing-pending screen (spec §7.2, §7.5)
  ```

- [ ] **Step 1: Copy and adapt the `words` modules**

From `pebble-examples/piu/apps/words/src/embeddedjs/modules/`: `piuController.js` and `piuView.js` verbatim minus the `trace(...)` lines; `Menu.js` adapted as the Interfaces block says (`MenuContainer` always uses `Column` + `Inverter`; the row template takes `$.title` in `styles.body` and, when `$.meta`, a second `Label` in `styles.meta`, row height from `METRICS`). Remove `onPressSelect` from `MenuBehavior`; keep Up/Down with repeat.

- [ ] **Step 2: Write `link.js`, `exit.c`, and `main.js`**

`exit.c`: `#include <pebble.h>` and `void pi_exit(void) { window_stack_pop_all(true); }`; `manifest.json` gains `"ffi": { "sources": ["./exit.c"], "functions": { "pi_exit": { "arguments": [], "returns": "void" } } }` (path relative to the manifest as the FFI guide shows; adjust to `../c/exit.c` if the build says so) and `mdbl.c` passes `.fxBuildFFI = fxBuildFFI`. `main.js`: `Application` with `{ commandListLength: 2048, displayListLength: 2048, touchCount: 1, pixels: screen.width * 4 }`, skin from `theme(dark)`; `dark` from `localStorage.getItem("pi-web.dark") !== "0"`; model `home: { View: "Home" }`; `link = createLink({ keys: KEYS, onMessage })` where `KEYS` is the dictionary's key list; `link.send("hello")` once writable.

- [ ] **Step 3: Write `views/Home.js`**

Layout (emery 200×228, spec §7.1): status line 18 px (`statusLeft` left, `clock` right, `styles.small`), toolbar 16 px (`CTX` label, a 60 px track `Content` with `skins.dim` and a filled `Content` of width `round(percent * 60 / 100)` with `skins.ink`, the percent, the speed, the model; `--` when unknown; ruling: no compaction tick, the hub does not expose the threshold), query block (`Text`, `styles.body`, `queryText(home)` or, with nothing pending, `home.lastText`, plus a 14 px `hint(home, stats)` line), 2 px rule (`skins.rule`), then `Menu` with `homeRows(home)`. Behaviour: `onModel(container, kind)` re-renders the affected piece (`home` → rows and query, `stats` → toolbar, `net` → status line, `result` → row feedback). Buttons: `onPressSelect` starts a 500 ms `Timer`; `onReleaseSelect` clears it and picks the selected row if the timer had not fired; the fired timer calls `controller.goTo("MenuView")` (a log line until Task 9). Picking: an option row → `link.send("answer", { REQ_ID, OPTION })` and the row label becomes `…`; `result` ok → `sent` for 1 s (the phone's next `home` moves on); `gone` → `already answered` for 1 s; `error` → `failed` for 1 s and the label returns. `dismiss` row → `link.send("dismiss", { REQ_ID })`. `say it` and `menu` rows → log lines until Tasks 8 and 9. `onPressBack`: with a request showing, `link.send("dismiss", ...)` then `controller.exit()` after `onWritable` fires again or 400 ms, whichever first; with nothing pending, `controller.exit()` at once. Touch: each row `active: true` with `onTouchEnded` → pick it. Dark/light from `controller.theme`.

- [ ] **Step 4: Build, run against the stub hub, screenshot**

Run: `node watch/app/dev/stub-hub.mjs --port 5173 --scene dialog &` then `cd watch/app && pebble build && pebble install --emulator emery && pebble screenshot --no-open ../screenshots/home-dialog-emery-dark.png`.
Expected: status `PI-WEB 1/2`, toolbar `CTX ▮▮▮ 41% 62 T/S QWEN3`, the query `bash: Allow git push?…`, rows `allow` `deny` `say it` with `allow` inverted. Then `pebble emu-button --emulator emery down` and `select` → the row shows `…` then `sent`, and the second request (`finished`) appears with rows `say it` `dismiss`; `pebble emu-button back` → the app exits to the launcher (check `pebble logs` for the dismiss and no FFI error). Repeat with `--scene empty` → `PI-WEB 0/0`, the last reply as the query, hint `PROJ · IDLE`, rows `say it` `menu`. Repeat with `--dark 0` for `home-dialog-emery-light.png`. Commit the screenshots. If `window_stack_pop_all` through FFI does not exit cleanly (log the error), fall back to returning `false` from `onPressBack` so the firmware exits, and note in `watch/README.md` that the dismiss may be lost on Back; record the ruling in the ledger.

- [ ] **Step 5: Commit**

```bash
git add watch/app/src watch/screenshots
git commit -m "feat(watch): controller, phone link, and the Home screen with answer by button and touch"
```

---

### Task 8: Say it (dictation), prompts, and `no_match`

**Files:**
- Modify: `watch/app/src/embeddedjs/views/Home.js`, `modules/model.js` (say-it state), `watch/app/test/model.test.mjs`

**Interfaces:**
- Consumes: `pebble/dictation`, `link.send("answer", { REQ_ID, TEXT })`, `link.send("prompt", { SESSION_ID, TEXT })`, `m.setSayIt` / `m.sayIt` (Task 6).

- [ ] **Step 1: Write the failing tests** for the state machine in `model.test.mjs`

```js
test("say-it state: idle → listening → sending(text) → sent; no_match keeps text and options; failed returns to idle rows", ...);
// m.setSayIt({ status: "listening" }); m.setSayIt({ status: "sending", text: "yes please" }); applying a result {ok:1} for the say-it cmdId → status "sent"; {ok:0, reason:"no_match", options:["allow","deny"]} → status "no_match", m.sayIt.options deepEqual; homeRows(home, m.sayIt) during "sending" → ["sending…", "say it again"]; during "no_match" → the request's options again
```
`homeRows` gains an optional second argument `sayIt`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test watch/app/test/model.test.mjs 2>&1 | tail -5`
Expected: FAIL on `setSayIt`.

- [ ] **Step 3: Implement**

`model.js`: `sayIt` state and `setSayIt(patch)`; `apply("result")` for the remembered say-it `cmdId` moves the state. `Home.js`: the `say it` row creates `new Dictation({ onReadable, onError })`, `configure({ confirm: true, errorDialogs: true })`, `start()`, `setSayIt({ status: "listening" })`. `onReadable`: `text = this.read()`; `setSayIt({ status: "sending", text })`; render the transcript under the query as a right-aligned `Text` (`styles.bodyRight`, `left: 32`), rows `sending…` (dim) and `say it again`; send `answer` with `TEXT` when a request shows, else `prompt` to `home.sessionId`. `sent` → `sent` row for 1 s then idle. `no_match` → query block shows `didn't match: allow, deny` (14 px) under the request text and the option rows return. `onError` → firmware dialog shows; then `setSayIt({ status: "idle" })`. `say it again` restarts dictation. `close()` the Dictation when leaving the screen.

- [ ] **Step 4: Run tests, build, verify on the emulator**

Run: `node --test watch/app/test/ 2>&1 | tail -5 && cd watch/app && pebble build && pebble install --emulator emery`
Expected: tests pass; build clean. In the emulator with `--scene dialog`, pick `say it`: if the emulator offers a dictation stub, finish it and see `sending…` then `sent`; if the emulator cannot dictate (log says so), verify the rendering by temporarily feeding `setSayIt({ status: "sending", text: "yes please" })` from a `pebble emu-button up` long-press debug hook, screenshot `home-sayit-emery-dark.png`, remove the hook, and add "dictation: hardware only" to the hardware checklist in `watch/README.md`.

- [ ] **Step 5: Commit**

```bash
git add watch/app/src watch/app/test watch/screenshots watch/README.md
git commit -m "feat(watch): say it by dictation, prompts to the current session, no_match recovery"
```

---

### Task 9: Menu, Sessions, and Model screens

**Files:**
- Create: `watch/app/src/embeddedjs/views/MenuView.js`, `views/Sessions.js`, `views/ModelView.js`
- Modify: `views/Home.js` (hold Select and `menu` row → `controller.goTo("MenuView")`)

**Interfaces:**
- Consumes: `Menu` view module, `m.lists.sessions/models`, `parseRows`, `sessionMeta`, `menuMeta`, `link.send("page", …)`, `link.send("show", …)`, `link.send("model", …)`.

- [ ] **Step 1: `MenuView.js`** (spec §7.6)

Status `MENU` + clock. Query block: session title (14) and `menuMeta(stats)` two lines. Rows: `sessions` with the count on the right once `lists.sessions.total` is known, `history` (count once known, ruling: no count until a history page has been loaded), `model` with `stats.model` on the right. Select → `controller.goTo("Sessions" | "History" | "ModelView")`. Back → `goBack()` (the `piuView` default). On display, `link.send("page", { LIST: "sessions", OFFSET: 0 })` so the count fills.

- [ ] **Step 2: `Sessions.js`** (spec §7.7)

Status `SESSIONS n`. No query block. Two-line rows 44 px: title; `sessionMeta(row)`; closed rows dim. `resetList("sessions")` then `page` on display; rows re-render on `onModel("list")`. Select → `link.send("show", { SESSION_ID })` and `controller.goHome()`. Up/Down stop at the ends.

- [ ] **Step 3: `ModelView.js`** (spec §7.9)

Status `MODEL`. Query block: title (14) and `model for this session`. `page models` on display; rows: `name` with meta `CURRENT` on the current one (ruling: a word, not a glyph, since the font subset is Basic Latin). Select → `link.send("model", { SESSION_ID, PROVIDER, MODEL_ID })`; on `result` ok the row shows `set` for 1 s then `goBack()`.

- [ ] **Step 4: Build, verify, screenshot**

Run: stub hub `--scene empty`; `pebble build && pebble install --emulator emery`; hold Select (`pebble emu-button --emulator emery select --hold 700` if the tool supports a hold, else press `menu` on the empty scene) → `MENU` screen → screenshot `menu-emery-dark.png`; `sessions` → 26 rows arrive in chunks, count `SESSIONS 26`, screenshot `sessions-emery-dark.png`; Select a row → Home for that session; `model` → `model-emery-dark.png`.

- [ ] **Step 5: Commit**

```bash
git add watch/app/src watch/screenshots
git commit -m "feat(watch): menu, sessions, and model screens"
```

---

### Task 10: History screen

**Files:**
- Create: `watch/app/src/embeddedjs/views/History.js`
- Modify: `modules/model.js` (history list keeps at most 24 rows), `watch/app/test/model.test.mjs`

**Interfaces:**
- Consumes: `m.lists.history`, `parseRows("history", …)`, `link.send("page", { LIST: "history", SESSION_ID, OFFSET })`.

- [ ] **Step 1: Write the failing test**

```js
test("history keeps at most 24 turns: prepending an older page drops the newest beyond 24", ...); // load i 28..39 (12), then 16..27 (12) → 24 rows; then 4..15 → rows are i 4..27, the 28..39 gone; lists.history.earliest === 4
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test watch/app/test/model.test.mjs 2>&1 | tail -5`
Expected: FAIL (25+ rows kept).

- [ ] **Step 3: Implement the cap and `History.js`** (spec §7.8)

Status `HISTORY · i/n` where `i` is the `i` of the turn at the top of the viewport and `n` is `lists.history.total`. A Piu `Scroller` (`active: true` for touch drag) over a `Column` of turns: `you` → `Text` in `styles.bodyRight` with `left: 32`; `agent` → `styles.body` with `right: 24`; `tool` → one `Label` in `styles.meta` dimmed. No fills, bubbles, scrollbars or fades. Open at the bottom (`scroller.scrollTo(0, scroller.first.height)` after layout). Up/Down scroll by half the viewport; reaching the top with `earliest > 0` sends `page` with `OFFSET: earliest` and prepends the rows, keeping the viewport on the same turn. `resetList("history")` and `page` with `OFFSET: -1` on display. Back → `goBack()`.

- [ ] **Step 4: Build, verify, screenshot**

Run: stub hub `--scene empty` (40 turns); from the menu pick `history` → status `HISTORY · 29/40`-ish at the bottom; `pebble emu-button up` × 6 reaches the top and loads 12 more; screenshot `history-emery-dark.png` showing right-aligned user turns and left-aligned agent turns with no decoration.

- [ ] **Step 5: Commit**

```bash
git add watch/app/src watch/app/test watch/screenshots
git commit -m "feat(watch): history screen as a chat scroller with backward paging"
```

---

### Task 11: Live reply text, connection cue, Round 2 pass, docs

**Files:**
- Modify: `views/Home.js`, `views/*.js` (gabbro centring), `watch/README.md`, root `README.md`, `watch/screenshots/`

- [ ] **Step 1: Live text and blink in `Home.js`** (spec §7.5, §7.1)

`onModel("text")`: when `home.requestId === null` and `text.sessionId === home.sessionId`, the query block shows `text.text` (replacing `lastText`); when `streaming` goes to 0 it stays as the last reply. The speed label blinks while `stats.state === "running"`: a 500 ms `interval` toggling `visible`; stop and show when the state leaves `running`. `onModel("net")` re-renders the status line (`CONNECTING`, `OFFLINE`, `NO HUB URL`).

- [ ] **Step 2: Verify the stream on the emulator**

Run: stub hub `--scene stream`; install; watch the query block grow sentence by sentence for 6 s with the speed blinking, then settle; `pebble logs` show no dropped AppMessages (if the emulator drops 240-character `TEXT` payloads, halve `TEXT_MAX` in `bridge.js` to 120 and note it in README known issues). Screenshot mid-stream: `home-streaming-emery-dark.png`.

- [ ] **Step 3: Round 2 (gabbro) pass** (spec §7.10)

Install every scene on `--emulator gabbro`. With `screen.round`: centre the status line and the query text (`horizontal: "center"`), keep the `Menu`'s selected row vertically centred (the `words` `computeTweens` already does this), and inset rows so text clears the circle; adjust paddings by screenshot. Screenshots for gabbro: `home-dialog`, `home-streaming`, `menu`, `sessions`, `history`, `model`, dark and light.

- [ ] **Step 4: Docs**

`watch/README.md`: Pebble app setup (Notifications → pi-web → off; the app's settings page: hub URL = the hub's tailnet URL, dark; the Developer Connection toggle is not needed for the app); Dev loop (stub hub scenes, real hub via Vite); Hardware checklist for Michael's Time 2 + iPhone (settings page opens and saves; the socket connects, and which transport the phone reports; lock the phone 30 min with a session running, note how long the reconnect takes; dictation round trip; answer a real dialog; Back dismisses and exits); Known issues (anything recorded by Tasks 3, 6, 7, 8, 11). Root `README.md`: a `## watch` section pointing at `watch/README.md` and `docs/watch-api.md`.

- [ ] **Step 5: Full test run and commit**

Run: `npm test 2>&1 | tail -15 && npm run typecheck`
Expected: shared, hub, bridge, app and watch suites pass; typecheck clean.

```bash
git add watch README.md
git commit -m "feat(watch): live reply text, connection cue, Round 2 layout, README"
```

---

## Self-review notes

- Spec coverage: §5.1 → Tasks 1–2; §6.4 (app half) → Tasks 4–5; §7.1 → 6, 7, 11; §7.2–7.3 → 7; §7.4 → 8; §7.5 → 7, 11; §7.6–7.7, 7.9 → 9; §7.8 → 10; §7.10 → 11; §12 → 3, 5, 6; §13 (hub stream tests, phone tests, watch-side module tests, screenshots) → 2, 4–6, 7–11; §13 hardware → README checklist (Task 11), executed by Michael. Spec §8 (launch from the face), §6 (face) and §14 milestone 1 are plan 3.
- Rulings recorded here for the ledger: `open on phone` row dropped (§4 vs §7.2); no compaction tick on the context bar; `CURRENT` word instead of a glyph on the model row; no history count until a page is loaded; `NET: "unconfigured"` → `NO HUB URL` added to the status cue; the long-poll `since` cursor and `POST /api/watch/showing` stay as they are.
- Type consistency: the dictionary table is the single source for key names; `WatchStreamFrame` is used by Tasks 1, 2 and (as JSON) 4; `createHubClient` callbacks are the bridge's `onPending/onText/onStatus`; `m.apply` kinds match the `MSG` values plus `null`.
