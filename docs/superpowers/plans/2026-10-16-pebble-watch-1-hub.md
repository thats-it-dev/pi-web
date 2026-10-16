# Pebble Watch, Plan 1 of 3: Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hub everything the Pebble face, the Pebble app and the Index 01 ring need: a request model over existing session state, a bearer-token watch API with long-poll, session/history/model/prompt endpoints with live tokens-per-second, a weather proxy, and the Index 01 webhook that answers the request on the watch or starts a session in `~/pebble/`.

**Architecture:** A `WatchService` in `hub/src/watch.ts` derives requests from the registry's handles (pending dialogs) and from a shared turn-outcome tracker (refactored out of `push-watch.ts`), keeps dismissals and `showing` in memory, and wakes long-pollers on any change. Routes live in `hub/src/watch-routes.ts` and `hub/src/index-webhook.ts`, mounted by `server.ts`, which skips the Origin check for them in favour of a bearer token or an HMAC signature. `LiveStats` moves from the app to `shared/` so the hub computes the same context estimate and speed the app shows.

**Tech Stack:** Node 22+ TypeScript run directly (`node src/main.ts`), `node:test`, `node:crypto` (HMAC, random, timingSafeEqual), no new dependencies. App side: Lit, vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-pebble-watch-design.md` (§4 request model, §5 API, §9 security, §10 webhook, §11 weather, §13 testing). Plans 2 (watchapp) and 3 (watchface + hardware spike) follow this one.

## Global Constraints

- Only rpc (headless) handles produce requests; bridge sessions never do (spec §4).
- Request ids are deterministic: `dialog:<sessionId>:<dialogId>`, `finished:<sessionId>:<messageIndex>`, `error:<sessionId>:<messageIndex>` (spec §4).
- Viewer gate is the global `Viewers.watching()` count: while true, `pending` is empty; `finished`/`error` are recorded only when it was false at the turn's end and are dropped when it becomes true; `dialog` requests are hidden, not dropped (spec §4).
- Long-poll holds at most 25 s (spec §5).
- `/api/watch/*` and `/api/index/webhook`: no Origin check; Host and `Tailscale-User-Login` checks stay; `/api/watch/*` needs `Authorization: Bearer <token>`, compared in constant time (spec §9).
- Webhook: signature over `"v1\n" + timestamp + "\n" + delivery + "\n" + trigger + "\n" + ("1"|"0") + "\n"` followed by the raw body bytes, lowercase hex HMAC-SHA256 with the secret's UTF-8 bytes; reject timestamps more than 300 s off and delivery ids seen in the last hour; always 200 with an empty body once the signature passes (spec §9, §10; developer.repebble.com/index-01/webhooks/).
- A confirm dialog's `no` sends `confirmed: false`, never `cancelled` (spec §5).
- Ring with nothing pending: new session in `~/pebble/` (created if missing, `~` resolved like `POST /api/sessions`), transcription as the first prompt, hub default approval mode (spec §10).
- No cost figures in anything the watch receives (spec §1 non-goals).
- Code style as the hub has it: tabs, double quotes, `.ts` imports with extension, `node:test` + `node:assert/strict`, `FakeHandle` from `hub/test/support/fake-handle.ts`.

## Review Focus

Inputs the spec implies but no requirement names; each has a test in the owning task.

1. A dialog answered from the phone app while the watch holds it: the next `pending` must not list it, and `answer` for it must return `gone`, not reach pi (Task 5).
2. A session handle that exits (pi crashed) with a dialog request showing: the request ends and `showing` is cleared, so a ring recording does not target a dead session (Task 5).
3. A webhook whose body is not multipart, or has no `transcription` and no `audio`: 200 after the signature passes, logged, nothing sent to pi, no crash (Task 9).
4. `answer` with `text` that matches two options ("allow" against `allow` and `allow always`): exact match wins; a text that is a prefix of two options returns `no_match` with the options (Task 4).
5. Two watch clients long-polling at once (face and app): both wake on one change, neither blocks the other, and a client whose socket closes mid-wait is forgotten (Task 5, Task 7).

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/src/live-stats.ts` | `LiveStats` class (moved from app): context estimate + tokens per second from stream events. |
| `shared/src/protocol.ts` | Add watch wire types: `WatchRequest`, `WatchSession`, `WatchPending`, `WatchTurn`, `WatchAnswerResult`; extend `HealthInfo` with `watch`. |
| `app/src/lib/live-stats.ts` | Re-exports `LiveStats`, keeps `contextLabel`, `speedLabel`. |
| `hub/src/handle.ts` | `SessionHandle.observe()` (stream tap that doesn't count as a viewer) and optional `pendingTool()`. |
| `hub/src/rpc-handle.ts`, `hub/src/bridge-handle.ts`, `hub/test/support/fake-handle.ts` | Implement `observe`; `pendingTool` public on rpc. |
| `hub/src/turns.ts` | `watchTurns()`: the one place that turns `session_state` transitions into `needs_you`/`finished`/`error` outcomes (moved out of `push-watch.ts`). |
| `hub/src/push-watch.ts` | `Viewers` gains `onChange`; `watchPush` becomes a thin consumer of `watchTurns`. |
| `hub/src/watch-secrets.ts` | Generate/load `watch.json` (token + index secret), constant-time bearer check. |
| `hub/src/auth.ts` | `checkWatchRequest()`: Host + login + bearer, no Origin. |
| `hub/src/answer-match.ts` | Pure text→option matching with yes/no synonyms. |
| `hub/src/watch.ts` | `WatchService`: requests, dismiss, showing, long-poll, sessions, tps, history, models, answer, prompt. |
| `hub/src/watch-routes.ts` | `/api/watch/*` HTTP handlers, incl. weather proxy. |
| `hub/src/multipart.ts` | Minimal `multipart/form-data` parser. |
| `hub/src/index-webhook.ts` | Signature/replay checks, audio store, routing to `WatchService`. |
| `hub/src/server.ts` | Mount the two route groups with their own auth; health carries secrets. |
| `hub/src/main.ts` | Wire secrets, `WatchService`, webhook. |
| `app/src/components/pi-settings.ts` | "watch" section showing token and secret with copy buttons. |
| `hub/test/*.test.ts` | One test file per new module; `server.test.ts` untouched. |

---

### Task 1: Watch secrets and bearer auth

**Files:**
- Create: `hub/src/watch-secrets.ts`
- Modify: `hub/src/auth.ts`
- Test: `hub/test/watch-secrets.test.ts`, `hub/test/auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // watch-secrets.ts
  export interface WatchSecrets { token: string; indexSecret: string } // 64 lowercase hex chars each
  export function loadWatchSecrets(dataDir: string, log?: (m: string) => void): WatchSecrets // reads/creates <dataDir>/watch.json, mode 0600
  export function bearerMatches(authorization: string | undefined, token: string): boolean // "Bearer <token>", timingSafeEqual
  // auth.ts
  export function checkWatchRequest(cfg: AuthConfig, h: IncomingHttpHeaders, token: string): AuthResult
  export function checkHostAndLogin(cfg: AuthConfig, h: IncomingHttpHeaders): AuthResult // the Host + login half of checkRequest, reused by Task 9
  ```

- [ ] **Step 1: Write the failing tests**

`hub/test/watch-secrets.test.ts`:
```ts
test("creates watch.json with two 32-byte hex secrets, mode 0600, and reloads the same values", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-watch-secrets-"));
	const a = loadWatchSecrets(dir);
	assert.match(a.token, /^[0-9a-f]{64}$/);
	assert.match(a.indexSecret, /^[0-9a-f]{64}$/);
	assert.notEqual(a.token, a.indexSecret);
	assert.equal(statSync(join(dir, "watch.json")).mode & 0o777, 0o600);
	assert.deepEqual(loadWatchSecrets(dir), a);
});
test("an unreadable watch.json is replaced and logged", () => { /* write "not json", expect new secrets and a log line containing "watch.json" */ });
test("bearerMatches accepts only the exact token", () => {
	assert.equal(bearerMatches("Bearer abc", "abc"), true);
	assert.equal(bearerMatches("bearer abc", "abc"), true);
	assert.equal(bearerMatches("Bearer abd", "abc"), false);
	assert.equal(bearerMatches("Bearer ab", "abc"), false);
	assert.equal(bearerMatches(undefined, "abc"), false);
	assert.equal(bearerMatches("abc", "abc"), false);
});
```
Add to `hub/test/auth.test.ts`:
```ts
test("checkWatchRequest needs host, login and the bearer token, and ignores Origin", () => {
	const cfg = { hostname: "hub.test:7878", allowedLogin: "me@github", allowedOrigins: ["https://pi.thatsit.app"] };
	const good = { host: "hub.test:7878", "tailscale-user-login": "me@github", authorization: "Bearer t0k" };
	assert.deepEqual(checkWatchRequest(cfg, good, "t0k"), { ok: true });
	assert.deepEqual(checkWatchRequest(cfg, { ...good, origin: "https://evil.example" }, "t0k"), { ok: true });
	assert.equal(checkWatchRequest(cfg, { ...good, authorization: "Bearer nope" }, "t0k").ok, false);
	assert.equal(checkWatchRequest(cfg, { ...good, authorization: undefined }, "t0k").ok, false);
	assert.equal(checkWatchRequest(cfg, { ...good, host: "evil.example" }, "t0k").ok, false);
	assert.equal(checkWatchRequest(cfg, { ...good, "tailscale-user-login": "other@github" }, "t0k").ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hub && node --test test/watch-secrets.test.ts test/auth.test.ts`
Expected: FAIL, module `../src/watch-secrets.ts` not found / `checkWatchRequest` is not exported.

- [ ] **Step 3: Implement `watch-secrets.ts` and the two auth functions**

`loadWatchSecrets`: `randomBytes(32).toString("hex")` for each; write with the same atomic write + `0o600` as `push.ts` (copy `writeAtomic`, or export it from `push.ts` and import). `bearerMatches`: case-insensitive `Bearer ` prefix, then `timingSafeEqual` on `Buffer.from` of both strings only when lengths are equal. In `auth.ts`, split `checkRequest` so its Host + login half is `checkHostAndLogin`; `checkRequest` = Origin check then `checkHostAndLogin`; `checkWatchRequest` = `checkHostAndLogin` then `bearerMatches` with reason `"watch token"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hub && node --test test/watch-secrets.test.ts test/auth.test.ts`
Expected: PASS; the existing `auth.test.ts` cases still pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/watch-secrets.ts hub/src/auth.ts hub/test/watch-secrets.test.ts hub/test/auth.test.ts
git commit -m "feat(hub): watch token and Index secret, bearer check for watch routes"
```

---

### Task 2: `observe()` on session handles and a public `pendingTool`

**Files:**
- Modify: `hub/src/handle.ts`, `hub/src/rpc-handle.ts:112-130,157-165,487-497`, `hub/src/bridge-handle.ts:48,71,103-108,261-270`, `hub/test/support/fake-handle.ts`
- Test: `hub/test/registry.test.ts` (one new case), `hub/test/rpc-handle.test.ts` (one new case)

**Interfaces:**
- Produces, on `SessionHandle`:
  ```ts
  observe(fn: (msg: StreamMessage) => void): () => void; // every StreamMessage subscribe() gets, but not counted by subscriberCount()
  pendingTool?(): PendingTool | null; // rpc only: the tool call a permission dialog is about (auto-approve.ts PendingTool)
  ```

- [ ] **Step 1: Write the failing tests**

In `hub/test/registry.test.ts`:
```ts
test("an observer does not keep an idle headless session from being reaped", async () => {
	// registry with idleMs 1000 and a controllable now(); create a FakeHandle, h.observe(() => {}), advance now past idleMs, reap(); expect h.closed === true
});
```
In `hub/test/rpc-handle.test.ts`, next to the existing subscribe tests:
```ts
test("observe sees the same stream as subscribe without counting as a subscriber", async (t) => {
	const { h } = await startHandle(t);
	const seen: string[] = [];
	const off = h.observe((m) => seen.push(m.type));
	assert.equal(h.subscriberCount(), 0);
	await h.command({ type: "prompt", text: "hi", mode: "send" });
	// wait for an "event" with event.type === "agent_settled" via watch(h) as the other tests do
	assert.ok(seen.includes("event"));
	off();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hub && node --test test/registry.test.ts test/rpc-handle.test.ts`
Expected: FAIL with `h.observe is not a function`.

- [ ] **Step 3: Implement**

`handle.ts`: add the two members above. `rpc-handle.ts`: a second `Set` `observers`; `broadcast` iterates subscribers then observers, same try/catch; `observe` adds/removes without touching `lastActive`; rename `private pendingTool()` to public `pendingTool(): PendingTool | null` (export `PendingTool` from auto-approve.ts already exists). `bridge-handle.ts`: same `observers` set in its `broadcast`. `FakeHandle`: `observers` set, `observe()`, `push()` fans out to both, plus a public field `pendingToolValue: PendingTool | null = null` returned by `pendingTool()`.

- [ ] **Step 4: Run the whole hub suite**

Run: `cd hub && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/handle.ts hub/src/rpc-handle.ts hub/src/bridge-handle.ts hub/test/support/fake-handle.ts hub/test/registry.test.ts hub/test/rpc-handle.test.ts
git commit -m "feat(hub): observe() taps a handle's stream without holding it open; pendingTool public"
```

---

### Task 3: Move `LiveStats` to `shared/`

**Files:**
- Create: `shared/src/live-stats.ts`, `shared/test/live-stats.test.ts`
- Modify: `app/src/lib/live-stats.ts` (becomes re-export + labels), `app/src/lib/live-stats.test.ts` (imports unchanged; still passes)

**Interfaces:**
- Produces (unchanged API, new home): `export class LiveStats { constructor(now?: () => number); reset(stats: SessionStats | null, streaming: boolean): void; onStats(stats: SessionStats | null): void; onEvent(ev: PiEvent): void; context(): LiveContext | null; speed(): Speed | null }`, `export interface LiveContext`, `export interface Speed` in `shared/src/live-stats.ts`.

- [ ] **Step 1: Write the failing test**

`shared/test/live-stats.test.ts` with `node:test`: port the first two cases of `app/src/lib/live-stats.test.ts` ("context grows by an estimate while a reply streams, and real stats replace it", and the speed case) verbatim, with `assert.equal` in place of `expect(...).toBe`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npm test`
Expected: FAIL, `../src/live-stats.ts` not found.

- [ ] **Step 3: Move the class**

Cut everything in `app/src/lib/live-stats.ts` except `contextLabel` and `speedLabel` into `shared/src/live-stats.ts` (imports become `./protocol.ts`; drop the `formatTokens` import there). `app/src/lib/live-stats.ts` becomes:
```ts
export { LiveStats, type LiveContext, type Speed } from "../../../shared/src/live-stats.ts";
import type { LiveContext, Speed } from "../../../shared/src/live-stats.ts";
import { formatTokens } from "./format.ts";
// contextLabel and speedLabel unchanged
```

- [ ] **Step 4: Run both suites and typecheck**

Run: `cd shared && npm test && cd ../app && npx vitest run src/lib/live-stats.test.ts && npm run typecheck`
Expected: PASS, PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/src/live-stats.ts shared/test/live-stats.test.ts app/src/lib/live-stats.ts
git commit -m "refactor: LiveStats moves to shared so the hub can compute speed for the watch"
```

---

### Task 4: Answer matching

**Files:**
- Create: `hub/src/answer-match.ts`
- Modify: `hub/src/auto-approve.ts` (export `ALLOW_EXACT`, `ALLOW_PREFIX`; add `DENY_EXACT`, `DENY_PREFIX`; add `findAllow(options)`, `findDeny(options)`)
- Test: `hub/test/answer-match.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Match = { kind: "match"; option: string } | { kind: "none" } | { kind: "ambiguous"; options: string[] };
  export function matchOption(text: string, options: string[]): Match;
  export function yesNo(text: string): "yes" | "no" | null; // yes, yeah, yep, ok, okay, sure, go ahead, do it, allow, approve → "yes"; no, nope, don't, stop, deny, cancel → "no"
  // auto-approve.ts
  export function findAllow(options: string[]): string | undefined; // the existing ALLOW_EXACT-then-ALLOW_PREFIX rule
  export function findDeny(options: string[]): string | undefined; // /^(deny|no|reject|cancel|decline)$/i then /^(deny|no|reject|decline)\b/i
  ```
  Order inside `matchOption`: exact (trim, case-insensitive) → single option that starts with the text as a whole word → single option that contains the text as a whole word → `yesNo(text)` mapped through `findAllow`/`findDeny` → `none`. Two or more hits at a stage → `ambiguous` with the hits.

- [ ] **Step 1: Write the failing table test**

```ts
const OPTS = ["allow", "allow always", "deny"];
for (const [text, want] of [
	["allow", { kind: "match", option: "allow" }],
	[" Allow ", { kind: "match", option: "allow" }],
	["always", { kind: "match", option: "allow always" }],
	["allow al", { kind: "ambiguous", options: ["allow", "allow always"] }],
	["yes", { kind: "match", option: "allow" }],
	["go ahead", { kind: "match", option: "allow" }],
	["nope", { kind: "match", option: "deny" }],
	["banana", { kind: "none" }],
	["", { kind: "none" }],
] as const) test(`matchOption(${JSON.stringify(text)})`, () => assert.deepEqual(matchOption(text, [...OPTS]), want));
test("whole-word containment: 'phone' matches 'open on phone' but 'pho' does not", ...);
test("yes/no synonyms without allow/deny-shaped options give none", () => assert.deepEqual(matchOption("yes", ["red", "green"]), { kind: "none" }));
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd hub && node --test test/answer-match.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `answer-match.ts` and the `auto-approve.ts` exports**

`autoAnswer` keeps its behaviour by calling `findAllow`.

- [ ] **Step 4: Run tests**

Run: `cd hub && node --test test/answer-match.test.ts test/auto-approve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/answer-match.ts hub/src/auto-approve.ts hub/test/answer-match.test.ts
git commit -m "feat(hub): match spoken text to a dialog option, with yes/no synonyms"
```

---

### Task 5: Turn outcomes, Viewers.onChange, and the request model

**Files:**
- Create: `hub/src/turns.ts`, `hub/src/watch.ts`
- Modify: `hub/src/push-watch.ts` (use `watchTurns`; `Viewers.onChange`), `shared/src/protocol.ts` (types)
- Test: `hub/test/turns.test.ts`, `hub/test/watch.test.ts`; `hub/test/push-watch.test.ts` unchanged and still green

**Interfaces:**
- Produces, `shared/src/protocol.ts`:
  ```ts
  export type WatchRequestKind = "dialog" | "finished" | "error";
  export interface WatchRequest { id: string; kind: WatchRequestKind; sessionId: string; sessionTitle: string; tool: string | null; message: string; options: string[]; method: DialogMethod | null; createdAt: number }
  export interface WatchSession { id: string; title: string; state: LiveState; live: boolean; model: string | null; contextPercent: number | null; contextTokens: number | null; contextWindow: number | null; tps: number | null; updatedAt: number }
  export interface WatchPending { cursor: number; requests: WatchRequest[]; showing: string | null; sessions: WatchSession[] }
  export type WatchAnswerResult = { ok: true } | { ok: false; reason: "gone" | "no_match" | "ambiguous"; options?: string[] };
  export interface WatchTurn { i: number; role: "you" | "agent" | "tool"; text: string }
  ```
- Produces, `hub/src/turns.ts`:
  ```ts
  export type TurnOutcome = { sessionId: string; kind: "needs_you" } | { sessionId: string; kind: "finished" | "error"; messageIndex: number; text: string };
  export function watchTurns(registry: Pick<Registry, "onChange" | "get">, onOutcome: (o: TurnOutcome, snap: Snapshot) => void): () => void;
  ```
  (`text` = `contentText(last.content)` for finished; for error, `last.errorMessage` if a string else `contentText`; `messageIndex` = index of that last message.)
- Produces, `hub/src/push-watch.ts`: `Viewers.onChange(fn: (watching: boolean) => void): () => void`, fired when the count crosses 0 either way.
- Produces, `hub/src/watch.ts`:
  ```ts
  export interface WatchDeps { registry: Registry; index: SessionIndex; viewers: Viewers; home: string; now?: () => number; log?: (m: string) => void }
  export class WatchService {
  	constructor(deps: WatchDeps);
  	pending(): WatchPending;                                   // viewer-gated; dismissed excluded; oldest first
  	wait(since: number, maxMs?: number): Promise<WatchPending>; // resolves when cursor > since or after maxMs (default 25_000)
  	showing(requestId: string | null, sessionId?: string | null): void;
  	dismiss(requestId: string): void;
  	answer(requestId: string, a: { option?: string; text?: string }): Promise<WatchAnswerResult>;
  	prompt(sessionId: string, text: string): Promise<void>;    // registry.ensure + prompt send
  	setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
  	sessions(): Promise<WatchSession[]>;                       // Task 6
  	history(sessionId: string, before?: number, limit?: number): Promise<{ turns: WatchTurn[]; total: number }>; // Task 6
  	models(sessionId: string): Promise<{ current: { provider: string; id: string; name: string } | null; models: { provider: string; id: string; name: string }[] }>; // Task 6
  	currentTarget(): { requestId: string; sessionId: string } | null; // showing if still pending, else the most recently shown request still pending, else null (spec §10 step 3)
  	health(): { running: number; pending: number };
  	waiterCount(): number;                                      // long-pollers currently parked; for tests
  	close(): void;
  }
  ```
  This task implements everything except the three Task 6 methods (leave them throwing `new Error("not yet")`).

- [ ] **Step 1: Write the failing tests for `turns.ts`**

Port the scenarios of `push-watch.test.ts` (`setup`, `to`, `run` helpers) and assert on outcomes:
```ts
test("a finished run yields finished with the last assistant text and index", ...); // text "done", messageIndex 1
test("an error stopReason yields error", ...);
test("needs_you yields needs_you", ...);
test("an aborted run yields nothing; a bridge handle yields nothing", ...);
```

- [ ] **Step 2: Write the failing tests for `watch.ts`**

Helpers: a `FakeHandle` with `conv.messages`, `snapshot().dialogs` (make `FakeHandle.dialogs: Dialog[] = []` and return it from `snapshot()`), `pendingToolValue`. `setup()` builds `Registry` + `SessionIndex` on an empty temp dir + `Viewers` + `WatchService` with `now` controllable.
```ts
test("a pending select dialog becomes a request with tool name, title+message and options", async () => {
	// h.dialogs = [{ id: "d1", method: "select", title: "Allow git push?", message: "origin feat/x", options: ["allow", "allow always", "deny"] }]; h.pendingToolValue = { name: "bash", args: {} }; to(h, "needs_you")
	// expect requests[0] = { id: "dialog:s-1:d1", kind: "dialog", tool: "bash", message: "Allow git push?\norigin feat/x", options: [...], method: "select", sessionTitle: ... }
});
test("a confirm dialog gets options yes/no; input and editor get none", ...);
test("answering with an option sends dialog_response value; confirm no sends confirmed:false; the request is gone afterwards", async () => {
	// expect h.received to contain { type: "dialog_response", id: "d1", value: "allow" } and later { type: "dialog_response", id: "c1", confirmed: false }
});
test("answering with text uses matchOption; no_match returns the options and sends nothing", ...);
test("a dialog answered elsewhere: pending drops it and answer returns gone", async () => {
	// h.dialogs = []; to(h, "idle"); then svc.answer("dialog:s-1:d1", { option: "allow" }) → { ok: false, reason: "gone" }; h.received is empty
});
test("a finished turn with nobody watching becomes a finished request; a new run clears it", async () => {
	// run(h) → request { id: "finished:s-1:1", kind: "finished", tool: "question", message: "done", options: [] }; to(h,"running") → requests []
});
test("viewer gate: while an app is open, pending is empty; finished is dropped for good; a dialog comes back", async () => {
	// dialog pending + finished recorded; leave = viewers.add() → pending().requests = []; leave() → only the dialog request is back
});
test("finished recorded while an app is open never appears", ...);
test("dismiss hides a request until it ends; a new dialog with the same id after the old one ended is not dismissed", ...);
test("wait resolves early on change and at maxMs without one; two waiters both wake", async () => {
	// const a = svc.wait(c0, 50); const b = svc.wait(c0, 50); raise a dialog; both resolve with cursor > c0 in < 50ms (use real timers; pass maxMs 2000 and assert elapsed < 500)
	// then svc.wait(cursor, 30) resolves after ~30ms with the same cursor
});
test("showing is remembered and cleared when its request ends; currentTarget falls back to the most recently shown pending request", ...);
test("a handle exit with a dialog showing ends the request and clears showing", async () => {
	// h.deferExit = false; h.leave() or registry.close(id); expect pending().requests = [] and currentTarget() === null
});
test("prompt on a finished request's session sends prompt {text, mode:'send'} and ends the request", ...);
test("health counts running and pending rpc sessions", ...);
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd hub && node --test test/turns.test.ts test/watch.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `turns.ts` and refactor `push-watch.ts`**

Move the `Track`/transition logic from `watchPush` into `watchTurns`; `watchPush` becomes `watchTurns(registry, (o, snap) => { if (!viewers?.watching()) send({ sessionId: o.sessionId, title: sessionTitle(snap), kind: o.kind }) })`. `Viewers`: a `Set` of listeners, fire on 0→1 and 1→0.

- [ ] **Step 5: Implement `WatchService` (everything but the Task 6 methods)**

State: `cursor: number`, `waiters: Set<(p: WatchPending) => void>`, `dismissed: Set<string>`, `outcomes: Map<sessionId, { kind, messageIndex, text, createdAt }>`, `showingState: { requestId, sessionId, at } | null`, `lastShown: string[]` (most recent last, capped at 10), `created: Map<requestId, number>` for `createdAt`. Subscriptions: `registry.onChange` (any `session_state` → recompute, bump cursor; `running` clears that session's outcome), `watchTurns` (record `finished`/`error` only when `!viewers.watching()`), `viewers.onChange` (drop all outcomes when watching becomes true; bump cursor either way). `pending()`: if `viewers.watching()` → `requests: []`; else dialogs from every rpc handle's `snapshot().dialogs` plus outcomes; filter `dismissed`; sort by `createdAt`; prune `dismissed`, `created` and `lastShown` to ids still present; clear `showingState` if its id is gone. Dialog `tool` = `h.pendingTool?.()?.name ?? null`; finished/error `tool` = `"question"`. `sessions` in the `WatchPending` is `[]` until Task 6. `answer`: resolve the request; `gone` if absent; dialog select/confirm per the mapping table in spec §5 using `matchOption`; input/editor take `text` as `value`; finished/error take `text` via `prompt()`; `ambiguous` → `{ ok: false, reason: "no_match", options }` (the wire keeps two reasons only: `gone` and `no_match`; drop `ambiguous` from `WatchAnswerResult` if unused by the end of the task). Bump `cursor` and wake waiters after every state change via `queueMicrotask` so bursts coalesce.

- [ ] **Step 6: Run the tests**

Run: `cd hub && node --test test/turns.test.ts test/watch.test.ts test/push-watch.test.ts`
Expected: PASS, including the untouched push-watch cases.

- [ ] **Step 7: Commit**

```bash
git add shared/src/protocol.ts hub/src/turns.ts hub/src/watch.ts hub/src/push-watch.ts hub/test/turns.test.ts hub/test/watch.test.ts hub/test/support/fake-handle.ts
git commit -m "feat(hub): watch request model with viewer gate, dismissals, showing and long-poll"
```

---

### Task 6: Sessions, live speed, history, models

**Files:**
- Modify: `hub/src/watch.ts`, `hub/test/watch.test.ts`, `hub/test/support/fake-handle.ts` (`stats`, `models`, `state.model` settable)

**Interfaces:**
- Consumes: `LiveStats` (Task 3), `observe()` (Task 2), `SessionIndex.list()/find()`, `readHistory()` from `sessions.ts`, `sessionTitle()` from `push-watch.ts`, `contentText()` from `shared/src/reducer.ts`.
- Produces: the three methods declared in Task 5, plus `export function shortModel(model: string | null): string | null` (`"ollama/qwen3:32b"` → `"qwen3"`, `"anthropic/claude-opus-5-5"` → `"claude-opus-5-5"`: the part after the last `/`, cut at the first `:`), and `export function turnsFrom(messages: AgentMessage[], tools: Record<string, ToolRun>): WatchTurn[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test("sessions: live rpc sessions first by updatedAt, then closed ones capped at 20, with short model names and context percent", async () => {
	// index dir with 25 closed session files (model "ollama/qwen3:32b", contextTokens 52_000) and one live handle whose snapshot().stats.contextUsage = { tokens: 52_000, contextWindow: 128_000, percent: 40.6 }
	// expect sessions[0].live === true, model "qwen3", contextPercent 41 (rounded), sessions.length === 21, closed entries have contextPercent null and contextTokens 52_000
});
test("tps is null before any reply, a number while one streams, and keeps the last reply's figure after", async () => {
	// drive h.push({ type: "event", event }) with message_start / message_update deltas (now() advancing 1000ms, 400 chars → ~100 tps) / message_end; check sessions()[0].tps at each stage; speed changes bump the cursor only for the session reported current via showing(null, sessionId)
});
test("turnsFrom: user → you, assistant text → agent, toolCall blocks → tool lines 'name · first arg line', toolResult messages skipped, text clipped to 240 chars", ...);
test("history pages backwards: before=undefined gives the last `limit` turns with total; before=i gives the `limit` before i", ...);
test("history of a closed session reads the file", ...);
test("models lists the handle's models and marks the current one; setModel sends set_model", ...);
test("prompt to a closed session reopens it through registry.ensure", async () => { /* index has disk-1; registry factory creates on ensure; expect the new handle received a prompt */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hub && node --test test/watch.test.ts`
Expected: FAIL on the new cases (`not yet`).

- [ ] **Step 3: Implement**

Per live rpc handle keep `{ live: LiveStats; off: () => void }` created on first sight (`h.observe`: `event` → `live.onEvent`, `meta`/`snapshot` → `live.onStats(stats)`), disposed on `handle_gone`. `WatchSession.tps` = `Math.round(live.speed()?.tps)` or `null`. `contextPercent` from `snapshot().stats.contextUsage.percent` rounded, else from `live.context()`. Closed sessions from `index.list()` minus live ids, sorted by `updatedAt`, sliced to 20, `title` = `name ?? firstPrompt first line ?? basename(cwd)`. `history`: live → `h.snapshot().conv` (messages + tools); closed → `readHistory(file)` with `tools` built from `toolResult` messages absent → `{}`. Tool line text: `${name} · ${firstLine(JSON.stringify(args.command ?? args.path ?? args))}`. A speed tick while a reply streams bumps the cursor at most every 1000 ms, only for the session in `showingState.sessionId`.

- [ ] **Step 4: Run tests**

Run: `cd hub && node --test test/watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/watch.ts hub/test/watch.test.ts hub/test/support/fake-handle.ts
git commit -m "feat(hub): watch sessions with live speed, history paging and model list"
```

---

### Task 7: `/api/watch/*` routes and the weather proxy

**Files:**
- Create: `hub/src/watch-routes.ts`
- Modify: `hub/src/server.ts` (mount; auth switch; health), `shared/src/protocol.ts` (`HealthInfo.watch?: { token: string; indexSecret: string }`)
- Test: `hub/test/watch-routes.test.ts`

**Interfaces:**
- Consumes: `WatchService` (Tasks 5–6), `checkWatchRequest` (Task 1).
- Produces:
  ```ts
  // watch-routes.ts
  export interface WatchRouteDeps { watch: WatchService; fetchFn?: typeof fetch; now?: () => number; log?: (m: string) => void }
  export async function routeWatch(req: IncomingMessage, res: ServerResponse, url: URL, deps: WatchRouteDeps): Promise<boolean>; // true if handled
  // server.ts HubDeps gains: watch?: WatchService; secrets?: WatchSecrets; fetchFn?: typeof fetch
  ```
  Routes (all JSON, `cache-control: no-store`, no CORS headers needed):
  | Method, path | Behaviour |
  |---|---|
  | `GET /api/watch/pending?since=<n>&wait=1` | `wait=1` → `await watch.wait(since, 25_000)`; else `watch.pending()`. If the request socket closes while waiting, the waiter is dropped (`req.on("close")`). |
  | `POST /api/watch/showing` | body `{ requestId: string \| null; sessionId?: string \| null }` → 200 `{ ok: true }` |
  | `POST /api/watch/answer` | body `{ requestId, option?, text? }`; exactly one of option/text else 400; returns `WatchAnswerResult` with 200 |
  | `POST /api/watch/dismiss` | `{ requestId }` → `{ ok: true }` |
  | `POST /api/watch/prompt` | `{ sessionId, text }` → `{ ok: true }`; 404 if `registry.ensure` throws `HttpError(404)` |
  | `POST /api/watch/model` | `{ sessionId, provider, modelId }` → `{ ok: true }` |
  | `GET /api/watch/sessions` | `{ sessions }` |
  | `GET /api/watch/history?session=&before=&limit=` | limit default 12, max 50 |
  | `GET /api/watch/models?session=` | models payload |
  | `GET /api/watch/health` | `{ ok: true, hubVersion, sessions: watch.health() }` |
  | `GET /api/watch/weather?lat=&lon=` | Open-Meteo `https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>&current=temperature_2m,weather_code` → `{ tempC, code }`; cache 10 min keyed by `lat.toFixed(1),lon.toFixed(1)`; 502 on upstream failure |

- [ ] **Step 1: Write the failing tests**

Set up like `push-routes.test.ts` with a `WatchService` over a `Registry` of `FakeHandle`s and `secrets = { token: "t0k", indexSecret: "s3c" }`, `fetchFn` a stub returning Open-Meteo-shaped JSON and counting calls.
```ts
const WATCH = { host: "hub.test:7878", "tailscale-user-login": "me@github", authorization: "Bearer t0k" };
test("watch routes need the bearer token and not an Origin; other routes still need an Origin", ...); // 403 without token; 200 with token and no origin; GET /api/sessions with WATCH headers → 403
test("pending without wait returns at once; with wait=1 it returns when a dialog is raised", async () => { /* start the call, raise a dialog after 50ms, assert response within 2s and requests.length 1 */ });
test("a pending long-poll whose client disconnects is forgotten", async () => { /* open and destroy the request; raise a dialog; watch.waiterCount() is 0 */ });
test("answer: option, text no_match with options, both or neither → 400", ...);
test("showing, dismiss, prompt, model, sessions, history, models round-trip", ...);
test("health carries the watch token and index secret, and watch/health the counts", async () => { /* GET /api/health with GOOD headers → body.watch.token === "t0k" */ });
test("weather proxies Open-Meteo once per 10 minutes per rounded coordinate and answers 502 when upstream fails", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hub && node --test test/watch-routes.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`server.ts`: in the `createServer` handler, before `checkRequest`: if `p.startsWith("/api/watch/")` → require `deps.watch && deps.secrets` (503 otherwise), run `checkWatchRequest(cfg, headers, secrets.token)`, then `routeWatch`; if `p === "/api/index/webhook"` → Task 9. `/api/health` adds `watch: deps.secrets ? { token, indexSecret } : undefined`. `readJson` is reused (export it from server.ts or move it to `hub/src/http.ts` with `sendJson`; the plan picks `hub/src/http.ts` and has server.ts import from there).

- [ ] **Step 4: Run the hub suite**

Run: `cd hub && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/watch-routes.ts hub/src/http.ts hub/src/server.ts shared/src/protocol.ts hub/test/watch-routes.test.ts
git commit -m "feat(hub): /api/watch routes with bearer auth, long-poll and weather proxy"
```

---

### Task 8: Multipart parser and webhook verification

**Files:**
- Create: `hub/src/multipart.ts`, `hub/src/index-webhook.ts` (verification half)
- Test: `hub/test/multipart.test.ts`, `hub/test/index-webhook.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // multipart.ts
  export interface Part { name: string; filename?: string; contentType?: string; data: Buffer }
  export function parseMultipart(body: Buffer, contentType: string | undefined): Part[]; // throws HttpError(400) when the boundary is missing or the body is malformed
  // index-webhook.ts
  export interface IndexHeaders { version?: string; trigger?: string; test?: string; signature?: string; timestamp?: string; delivery?: string; audioSize?: string }
  export function readIndexHeaders(h: IncomingHttpHeaders): IndexHeaders; // x-index-webhook-version, x-index-trigger, x-index-test, x-index-signature, x-index-timestamp, x-index-delivery, x-audio-size
  export function signIndex(secret: string, timestamp: string, delivery: string, trigger: string, isTest: boolean, body: Buffer): string; // lowercase hex; used by tests to build fixtures
  export class ReplayCache { constructor(ttlMs?: number, now?: () => number); seen(id: string): boolean; /* records id; true if already present within ttl */ }
  export type Verify = { ok: true; isTest: boolean } | { ok: false; status: 400 | 401 | 409; reason: string };
  export function verifyIndex(h: IndexHeaders, body: Buffer, secret: string, replays: ReplayCache, now?: () => number): Verify;
  ```
  `verifyIndex` order: version !== "1" → 400; missing signature/timestamp/delivery → 401; timestamp not an integer → 400; `|now/1000 − timestamp| > 300` → 401 "Expired request"; HMAC mismatch (timingSafeEqual) → 401 "Invalid signature"; `replays.seen(delivery)` → 409.

- [ ] **Step 1: Write the failing tests**

`multipart.test.ts`: build a body by hand with boundary `----b`, three parts (`transcription` text, `recordedAt` text, `audio` binary with filename and `audio/mp4`), CRLF line endings; assert names, filename, contentType and exact bytes; a body without the closing `--` or with no boundary param throws 400; an empty part list parses to `[]`.

`index-webhook.test.ts` (verification half):
```ts
const body = Buffer.from("x"); const secret = "s3c"; const now = () => 1_700_000_000_000;
const good = (over: Partial<IndexHeaders> = {}) => ({ version: "1", trigger: "single-click-hold", timestamp: "1700000000", delivery: "d-1", signature: signIndex(secret, "1700000000", "d-1", "single-click-hold", false, body), ...over });
test("a correctly signed request passes once; the same delivery id is a 409 replay", ...);
test("test events sign with '1' and pass as isTest", () => { /* test: "true", signature built with isTest true */ });
test("wrong version → 400, stale timestamp (301s) → 401, bad signature → 401, missing signature → 401", ...);
test("signIndex matches the documented prefix", () => {
	const want = createHmac("sha256", secret).update(Buffer.concat([Buffer.from("v1\n1700000000\nd-1\nsingle-click-hold\n0\n", "utf8"), body])).digest("hex");
	assert.equal(signIndex(secret, "1700000000", "d-1", "single-click-hold", false, body), want);
});
test("replay cache forgets ids after the ttl", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hub && node --test test/multipart.test.ts test/index-webhook.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`parseMultipart`: find `boundary=` in the content type (quoted or bare), split the buffer on `\r\n--<boundary>` using `Buffer.indexOf`, for each part split headers from data at the first `\r\n\r\n`, parse `content-disposition` (`name="…"`, `filename="…"`) and `content-type`; strip the trailing `\r\n` from data. `ReplayCache`: `Map<string, number>` with lazy pruning on each `seen`.

- [ ] **Step 4: Run tests**

Run: `cd hub && node --test test/multipart.test.ts test/index-webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/multipart.ts hub/src/index-webhook.ts hub/test/multipart.test.ts hub/test/index-webhook.test.ts
git commit -m "feat(hub): multipart parser and Index 01 webhook signature, freshness and replay checks"
```

---

### Task 9: The webhook route: answer the watch or start a session

**Files:**
- Modify: `hub/src/index-webhook.ts` (handler half), `hub/src/server.ts` (mount), `hub/src/watch.ts` (`startRingSession`)
- Test: `hub/test/index-webhook.test.ts` (route cases), `hub/test/watch.test.ts` (one case)

**Interfaces:**
- Consumes: `checkHostAndLogin` (Task 1), `parseMultipart`/`verifyIndex` (Task 8), `WatchService.currentTarget()/answer()` (Task 5).
- Produces:
  ```ts
  // index-webhook.ts
  export interface IndexDeps { watch: WatchService; secret: string; dataDir: string; replays?: ReplayCache; now?: () => number; log?: (m: string) => void; keep?: number /* default 200 */ }
  export async function handleIndexWebhook(req: IncomingMessage, res: ServerResponse, deps: IndexDeps): Promise<void>;
  // watch.ts
  startRingSession(text: string): Promise<string>; // mkdir -p <home>/pebble, registry.create(cwd), prompt {text, mode:"send"}; returns sessionId
  ```
  Handler steps (spec §10): read the raw body (cap 25 MB → 413); `verifyIndex` → on failure respond with its status and `{ error: reason }` and log; `isTest` → 200 empty body; parse parts; save `<dataDir>/index/<delivery>.m4a` when an `audio` part exists and `<dataDir>/index/<delivery>.json` sidecar `{ headers: IndexHeaders, transcription, recordedAt, client, action, sessionId?, requestId? }`; prune the folder to the newest `keep` deliveries by mtime; decide: `transcription` empty → `action: "kept_audio"`; else `target = watch.currentTarget()` → `watch.answer(target.requestId, { text })` → `action: "answered" | "no_match"`; no target → `sessionId = await watch.startRingSession(text)`, `action: "new_session"`. Always `200` with an empty body after verification. Errors inside pi calls are logged, not surfaced.

- [ ] **Step 1: Write the failing tests**

In `index-webhook.test.ts`, a server built like `watch-routes.test.ts` with `dataDir` a temp dir and a `fixture(fields, { test? })` helper that builds a multipart body and signs it:
```ts
const RING = { host: "hub.test:7878", "tailscale-user-login": "me@github" }; // no origin, no bearer
test("rejects without the tailnet identity (403) and with a bad signature (401); a replayed delivery is 409", ...);
test("a test event is 200 with an empty body and writes nothing", ...);
test("with a dialog showing, the transcription answers it", async () => { /* raise dialog, watch.showing("dialog:s-1:d1", "s-1"), POST transcription "allow" → h.received has dialog_response allow; sidecar action "answered" */ });
test("with nothing pending, a session is created in <home>/pebble (folder made) and the transcription is its first prompt", async () => { /* expect existsSync(join(home, "pebble")); factory saw cwd join(home,"pebble"); new handle received prompt { text, mode: "send" }; sidecar action "new_session" with sessionId */ });
test("a transcription that matches no option is logged and nothing reaches pi", ...);
test("empty transcription keeps the audio and does nothing else", async () => { /* audio part present → <dataDir>/index/<delivery>.m4a exists with the same bytes; sidecar action "kept_audio" */ });
test("a non-multipart body or one with neither transcription nor audio is 200, logged, and sends nothing", ...);
test("only the newest 200 deliveries are kept", async () => { /* keep: 2 in deps; three deliveries → two files remain */ });
```
In `watch.test.ts`: `test("startRingSession creates ~/pebble once and prompts the new session", ...)`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd hub && node --test test/index-webhook.test.ts test/watch.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the handler, `startRingSession`, and the mount in `server.ts`**

In `server.ts`: `if (m === "POST" && p === "/api/index/webhook")` → `checkHostAndLogin` (403 on failure, logged) → `handleIndexWebhook(req, res, { watch, secret: secrets.indexSecret, dataDir: cfg.dataDir, replays, log })`; 503 when `watch`/`secrets` are absent. Keep one `ReplayCache` per server instance.

- [ ] **Step 4: Run the hub suite**

Run: `cd hub && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/index-webhook.ts hub/src/server.ts hub/src/watch.ts hub/test/index-webhook.test.ts hub/test/watch.test.ts
git commit -m "feat(hub): Index 01 webhook answers the request on the watch or starts a session in ~/pebble"
```

---

### Task 10: Wire it in `main.ts`; show the secrets in the app

**Files:**
- Modify: `hub/src/main.ts`, `app/src/components/pi-settings.ts`, `app/src/lib/api.ts` (no change needed if `health()` already returns `HealthInfo`)
- Test: `app/src/components/pi-settings.test.ts` (new, vitest, node environment: render the watch section's template to a string via `lit`'s `render` into a detached element is not available in node; instead extract the pure helper below and test it)

**Interfaces:**
- Produces in `pi-settings.ts`: `export function watchSectionCopy(h: HealthInfo | null): { token: string | null; secret: string | null; hint: string }` (pure; the template calls it). Hint copy, exact: when `h?.watch` is present, `"Enter the token in the Pebble face and app settings, and the secret in the Index app's webhook settings (Sign requests). Mute pi-web in the Pebble app's notifications so requests don't arrive twice."`; when absent, `"This hub predates watch support; update it."`.

- [ ] **Step 1: Write the failing test**

```ts
test("watchSectionCopy exposes the token and secret when the hub has them, and says to update otherwise", () => {
	expect(watchSectionCopy({ ok: true, login: "x", hubVersion: "1", vapidPublicKey: null, watch: { token: "t", indexSecret: "s" } })).toEqual({ token: "t", secret: "s", hint: expect.stringContaining("Pebble") });
	expect(watchSectionCopy(null).token).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run src/components/pi-settings.test.ts`
Expected: FAIL, `watchSectionCopy` not exported.

- [ ] **Step 3: Implement**

`main.ts`: after `viewers`: `const secrets = loadWatchSecrets(cfg.dataDir); const watch = new WatchService({ registry, index, viewers, home: homedir() });` and pass `watch, secrets` to `createHubServer`; `mkdirSync(join(cfg.dataDir, "index"), { recursive: true })`; `shutdown` calls `watch.close()`. `pi-settings.ts`: a `<h2>watch</h2>` section after notifications: fetches `api.health()` on `connectedCallback` (reuse the existing health fetch if one is stored), shows two rows `token` / `Index secret` with a monospace value and a `copy` button (`navigator.clipboard.writeText`, toast "Copied."), then the hint. Reuse the `row`, `hint`, `btn ghost` classes already in the component.

- [ ] **Step 4: Run app tests and typecheck, then start the hub against the dev data dir**

Run: `cd app && npm test && npm run typecheck && cd ../hub && npm run typecheck`
Expected: PASS, no errors.
Run: `cd hub && PI_WEB_DATA_DIR=../.dev-data timeout 5 node src/main.ts; ls ../.dev-data/watch.json`
Expected: the hub prints its startup line and `watch.json` exists (mode 600).

- [ ] **Step 5: Commit**

```bash
git add hub/src/main.ts app/src/components/pi-settings.ts app/src/components/pi-settings.test.ts
git commit -m "feat: hub serves the watch API and webhook; app settings show the watch token and Index secret"
```

---

### Task 11: README section and a curl walkthrough

**Files:**
- Modify: `README.md` (root)
- Create: `docs/watch-api.md`

- [ ] **Step 1: Write `docs/watch-api.md`**

A table of every `/api/watch/*` route and `/api/index/webhook` from Task 7 and Task 9 with request and response shapes, the auth rule, and three `curl` examples against `https://<hostname>` with `-H "Authorization: Bearer $(jq -r .token ~/.config/pi-web/watch.json)"`: pending with wait, answer with option, and a signed webhook built with `openssl dgst -sha256 -hmac`. State the Pebble-app mute step (spec §3) and where audio lands (`<dataDir>/index/`).

- [ ] **Step 2: Add a "watch" section to `README.md`**

Three sentences: what the watch API is for, where the token shows in the app, and a pointer to `docs/watch-api.md` and the spec.

- [ ] **Step 3: Run the full repo tests once**

Run: `npm test`
Expected: all four workspaces PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/watch-api.md
git commit -m "docs: watch API and Index webhook reference"
```

---

## Self-review notes

- Spec coverage: §4 (Task 5), §5 incl. sessions/history/models/prompt/tps (Tasks 6–7), §9 token + webhook security (Tasks 1, 8), §10 (Task 9), §11 (Task 7), §13 hub tests (each task), token display (Task 10). `/api/watch/launch` (§8 path 2) is deliberately deferred to Plan 3, since it depends on the hardware spike's outcome.
- `WatchAnswerResult` is declared with a possible `ambiguous` reason in Task 5 and collapsed to `no_match` on the wire; Task 7's tests assert `no_match` only.
- Review Focus items map to tests in Tasks 4, 5, 7 and 9 as marked.
