# Session Types, Plan 1 of 2: Hub, Prompt and Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub knows each session's type (code or chat), spawns chat sessions with the assistant prompt instead of the engineering rules, carries the type through resumes and in-process session switches, and the superpowers and guard extensions behave per type.

**Architecture:** A small JSON store in the hub's data dir maps session id → "chat" (absence = code). The registry threads the type through create, resume and `session_changed`; `RpcHandle.boot` adds `--no-context-files` and `--append-system-prompt <chat.md>` for chat and marks every child with `PI_WEB_SESSION_TYPE`. The superpowers package reads that env for its default; the guard reads it to drop ritual nudges in chat. The app half (plan 2) consumes `SessionSummary.type` and the `type` field on `POST /api/sessions`.

**Tech Stack:** TypeScript on Node 22+ (run directly), `node:test`, pi 1.0.2 CLI flags.

**Spec:** `docs/superpowers/specs/2026-11-23-session-types-design.md` (sections "Types and their defaults", "Type storage and transport", "Prompts", "Superpowers default", "The guard in chat sessions").

## Global Constraints

- `SessionType = "code" | "chat"`; code is the absence of a store entry, so every pre-existing session, terminal session and watch-created session is code with no migration.
- Chat sessions spawn with `--no-context-files` and `--append-system-prompt <absolute path of hub/prompts/chat.md>` in addition to the existing TLDR prompt; code sessions spawn exactly as today.
- Every hub-spawned child gets `PI_WEB_SESSION_TYPE=code|chat` in its env beside `PI_WEB=1`.
- The store file is `<dataDir>/session-types.json`, written with `writeAtomic` (hub/src/push.ts).
- Chat sessions always run in the home folder; the hub ignores a chat request's `cwd`.
- `chat.md` ends with the safety block Michael asked for: never merge or close a PR or hand him a merge command; DNS/domains/deleting cloud resources/anything the public sees need his explicit yes for that exact action; Cloudflare through the `cf` CLI (and `gh` for GitHub), never wrangler or raw API calls. No review/screenshot/preview rituals in it.
- Superpowers default: on when `PI_WEB_SESSION_TYPE=code`, off otherwise; an explicit session entry always wins.
- Guard in a chat child: every block and the merge nudge stay; the stall, PR, to-do and preview nudges are off; app briefs still attach.
- No new npm dependencies.

## Review Focus

1. A chat session resumed after the hub reaper killed it must come back with the chat flags, not the engineering rules. Test in Task 2 (ensure passes the stored type) and Task 3 (boot args for a resume with `type: "chat"`).
2. `/new` inside a chat session makes a new id: it must list as chat and resume as chat. Test in Task 2 (`session_changed` records the parent's type) and Task 4 (`GET /api/sessions` falls back to `parentSession`).
3. A corrupt or missing `session-types.json` must not break listing or creation: everything is code. Test in Task 1.
4. A terminal (bridge) session has no store entry and no env: it lists as code and superpowers stays manual-off. Test in Task 4 (list) and Task 5 (default off without the env).
5. In a chat child, asking pi to edit a repo must still hit the guard's blocks (push, merge) but not produce a PR nudge afterwards. Test in Task 6.

---

### Task 1: `SessionType` in the protocol and the hub's type store

**Files:**
- Modify: `shared/src/protocol.ts:246-260` (`SessionSummary`)
- Create: `hub/src/session-types.ts`
- Test: `hub/test/session-types.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/src/protocol.ts
  export type SessionType = "code" | "chat";
  export interface SessionSummary { …existing…; type: SessionType }
  // hub/src/session-types.ts
  export class SessionTypeStore {
  	constructor(file: string);
  	/** "chat" when recorded, else "code" (missing file, unreadable file or unknown id all mean code). */
  	get(id: string): SessionType;
  	/** Records a chat session; `set(id, "code")` removes any entry. Writes atomically. */
  	set(id: string, type: SessionType): void;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("an unknown id, a missing file and a corrupt file are code", () => {
	const dir = mkdtempSync(join(tmpdir(), "types-"));
	const s = new SessionTypeStore(join(dir, "session-types.json"));
	assert.equal(s.get("nope"), "code");
	writeFileSync(join(dir, "session-types.json"), "{not json");
	assert.equal(new SessionTypeStore(join(dir, "session-types.json")).get("x"), "code");
});
test("set chat is remembered across instances; set code removes the entry", () => {
	const file = join(mkdtempSync(join(tmpdir(), "types-")), "session-types.json");
	const s = new SessionTypeStore(file);
	s.set("a", "chat");
	assert.equal(new SessionTypeStore(file).get("a"), "chat");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: "chat" });
	s.set("a", "code");
	assert.equal(new SessionTypeStore(file).get("a"), "code");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});
```

- [ ] **Step 2: Run to verify failure** — `cd hub && node --test test/session-types.test.ts` → FAIL, module missing.
- [ ] **Step 3: Implement** `hub/src/session-types.ts` (read the file on each `get`, like `LastModelStore`; keep the whole map in memory after the first read and rewrite it on `set`), and add `type: SessionType` to `SessionSummary` plus the `SessionType` export. Fix the typecheck fallout where summaries are built: `hub/src/sessions.ts` `summarize()` sets `type: "code"` (the index does not know types; Task 4 overlays the store), and `hub/src/server.ts` `listSessions()`'s fresh stub gets `type: "code"` for now.
- [ ] **Step 4: Run** — `cd hub && node --test test/session-types.test.ts`, then `npm run typecheck -w shared && npm run typecheck -w hub && npm run typecheck -w app` (the app compiles against the shared type) → PASS / clean.
- [ ] **Step 5: Commit** — `hub: session type store; SessionSummary.type`

---

### Task 2: The registry threads the type through create, resume and session_changed

**Files:**
- Modify: `hub/src/registry.ts` (`HandleFactory.startRpc` opts, `create`, `ensure`, `adopt`'s `session_changed` case, `RegistryOptions`)
- Modify: `hub/src/main.ts:44-50` (pass the store)
- Test: `hub/test/registry.test.ts`

**Interfaces:**
- Consumes: `SessionTypeStore` (Task 1).
- Produces:
  ```ts
  export interface HandleFactory { startRpc(opts: { cwd: string; sessionFile?: string; model?: ModelChoice | null; type: SessionType }): Promise<SessionHandle> }
  export interface RegistryOptions { …existing…; types: Pick<SessionTypeStore, "get" | "set"> }
  create(cwd: string, choice?: ModelChoice | null, type?: SessionType /* default "code" */): Promise<SessionHandle>  // records type in the store before launching when "chat"
  ensure(id: string): Promise<SessionHandle>  // launches with type: types.get(id)
  typeOf(id: string, parentSession?: string | null): SessionType  // store, else the parent's type, else "code"
  ```
  On `session_changed` from `e.from` to `e.to`: `types.set(e.to, types.get(e.from))` when that is "chat" (code needs no entry).

- [ ] **Step 1: Write the failing tests** (extend `registry.test.ts` with its existing fake factory and `FakeHandle`; add a fake `types` map object)

```ts
test("create records chat in the store and passes the type to the factory; code records nothing", …); // startRpc called with type:"chat"; types.get(h.sessionId)==="chat"; a code create leaves the map empty and passes type:"code"
test("ensure resumes with the stored type", …); // types has id→chat; ensure(id) → startRpc opts.type === "chat"
test("session_changed carries the parent's type to the new id", …); // create chat, emit session_changed {from,to}; types.get(to) === "chat"; typeOf(to) === "chat"
test("typeOf falls back to the parent session's type", …); // types has p→chat; typeOf("child", "p") === "chat"; typeOf("other", null) === "code"
```

- [ ] **Step 2: Run** — `cd hub && node --test test/registry.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `registry.ts`; in `main.ts` build `const types = new SessionTypeStore(join(cfg.dataDir, "session-types.json"))` and pass `types` to the registry and `o.type` through to `RpcHandle.start`.
- [ ] **Step 4: Run** — `npm run test -w hub` (registry + others) and `npm run typecheck -w hub` → PASS.
- [ ] **Step 5: Commit** — `hub: the registry threads the session type through create, resume and session switches`

---

### Task 3: Chat spawn flags, the env mark and `hub/prompts/chat.md`

**Files:**
- Create: `hub/prompts/chat.md`
- Modify: `hub/src/rpc-handle.ts:52-63` (`RpcHandleOptions.type: SessionType`), `boot()` (~`:253-261`)
- Test: `hub/test/rpc-handle.test.ts`

**Interfaces:**
- Consumes: `SessionType`.
- Produces: `export const CHAT_PROMPT_FILE = fileURLToPath(new URL("../prompts/chat.md", import.meta.url))` in `rpc-handle.ts`; spawn args for chat append `"--no-context-files", "--append-system-prompt", CHAT_PROMPT_FILE` after the TLDR prompt; env gains `PI_WEB_SESSION_TYPE: opts.type`.

- [ ] **Step 1: Write the failing tests** (the file already starts RPC handles against a fake `pi`; find how it inspects spawn args — if it only runs the real fake pi binary, assert through a `PI_BIN` shim script that echoes `process.argv` and `process.env.PI_WEB_SESSION_TYPE` into a file, as other hub tests do for env checks)

```ts
test("a chat session spawns with --no-context-files and the chat prompt file, and PI_WEB_SESSION_TYPE=chat", …);
test("a code session spawns as before (no --no-context-files) with PI_WEB_SESSION_TYPE=code", …);
test("a resumed chat session (sessionFile set) still gets the chat flags", …);
test("chat.md exists, ends with the safety block and names no review/screenshot/preview ritual", () => {
	const text = readFileSync(CHAT_PROMPT_FILE, "utf8");
	assert.match(text, /never merge or close a pull request/i);
	assert.match(text, /explicit yes/i);
	assert.match(text, /`cf`/);
	assert.doesNotMatch(text, /screenshot|reviewer|preview\(/i);
});
```

- [ ] **Step 2: Run** — `cd hub && node --test --test-concurrency=1 test/rpc-handle.test.ts` → FAIL.
- [ ] **Step 3: Write `hub/prompts/chat.md`** (~25 lines, Michael's style, plain prose, these sections in order): *Who this is*: Michael is asking you things, not pointing you at a repo. *Do*: answer plainly and briefly; search the web or the local SearXNG when it helps; read files, notes and sessions when asked; help draft and think things through; check on the spark (models, GPU, sessions) when asked; ask one question when unsure. *Don't*: don't edit repositories, open pull requests, run the app skill, start builds or deploys unless Michael explicitly asks; no engineering process rituals (no reviews, no plans, no to-do lists) unless asked. *If you do touch a repo or infrastructure, these still hold*: the three safety rules verbatim from Global Constraints.
- [ ] **Step 4: Implement** the `type` option and the boot changes.
- [ ] **Step 5: Run** — `npm run test -w hub && npm run typecheck -w hub` → PASS.
- [ ] **Step 6: Commit** — `hub: chat sessions spawn with the assistant prompt and no context files; PI_WEB_SESSION_TYPE on every child`

---

### Task 4: `POST /api/sessions` takes a type; `GET /api/sessions` reports it

**Files:**
- Modify: `hub/src/server.ts:102-128` (POST), `:211-222` (`listSessions`)
- Modify: `hub/src/watch.ts:434` (pass `"code"` explicitly or rely on the default; no behaviour change)
- Test: `hub/test/server.test.ts`

**Interfaces:**
- Consumes: `registry.create(cwd, choice, type)`, `registry.typeOf(id, parentSession)`.
- Produces: `POST /api/sessions` body `{ cwd?, model?, thinking?, type?: "code" | "chat" }` (anything but "chat" is code); for chat the cwd is `home` regardless of the body; `SessionSummary.type` filled by `registry.typeOf(s.id, s.parentSession)` in `listSessions` for both fresh stubs and on-disk summaries.

- [ ] **Step 1: Write the failing tests**

```ts
test("POST /api/sessions type chat creates in home and lists as chat", …); // body {cwd: work, type:"chat"} → factory saw cwd === home and type "chat"; GET lists it with type "chat"
test("POST without type is code; existing disk sessions list as code", …); // disk-1 → type "code"
test("a child of a chat session lists as chat through parentSession", …); // write a second session file with parentSession: "<chat id>" → type "chat"
test("type is validated: 'bogus' → code, not 400", …);
```

- [ ] **Step 2: Run** — `cd hub && node --test --test-concurrency=1 test/server.test.ts` → FAIL.
- [ ] **Step 3: Implement.** — `npm run test -w hub && npm run typecheck -w hub` → PASS.
- [ ] **Step 4: Commit** — `hub: POST /api/sessions takes a session type; listings carry it`

---

### Task 5: Superpowers defaults on for code children

**Files:**
- Modify: `superpowers/index.ts` (`savedState`, `session_start`)
- Test: `superpowers/test/index.test.ts`

**Interfaces:**
- Produces: `export function savedState(branch: Iterable<unknown>, env: NodeJS.ProcessEnv = process.env): boolean` — the last `pi-web-superpowers` entry wins; with none, `env.PI_WEB_SESSION_TYPE === "code"` → true, else false. `session_start` uses it (the extension's default export already receives nothing for env; read `process.env` there, injectable through the existing options object if the tests need it — check how the test file constructs the extension).

- [ ] **Step 1: Write the failing tests**

```ts
test("savedState: default on for a code child, off otherwise, an entry always wins", () => {
	assert.equal(savedState([], { PI_WEB_SESSION_TYPE: "code" }), true);
	assert.equal(savedState([], { PI_WEB_SESSION_TYPE: "chat" }), false);
	assert.equal(savedState([], {}), false);
	assert.equal(savedState([entry(false)], { PI_WEB_SESSION_TYPE: "code" }), false);
	assert.equal(savedState([entry(true)], { PI_WEB_SESSION_TYPE: "chat" }), true);
});
```
Plus a `session_start` test: with env code and an empty branch, the status is set to `STATUS_ON` and a `flash-auto-floor` entry with level `medium` is appended (mirror the existing session_start test).

- [ ] **Step 2: Run** — `cd superpowers && node --test test/index.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Update `superpowers/README.md` (one paragraph: default per `PI_WEB_SESSION_TYPE`). — `npm run test -w superpowers && npm run typecheck -w superpowers` → PASS.
- [ ] **Step 4: Commit** — `superpowers: on by default in pi-web code sessions (PI_WEB_SESSION_TYPE)`

---

### Task 6: The guard in chat sessions

**Files:**
- Modify: `guard/index.ts` (~`:427`: `const chat = env.PI_WEB_SESSION_TYPE === "chat"`; `agent_before_settle` ~`:600`; the preview-note trigger)
- Modify: `guard/README.md` (one paragraph under the nudges: chat sessions)
- Test: `guard/test/index.test.ts`

**Interfaces:**
- Consumes: `PI_WEB_SESSION_TYPE` (Task 3).
- Produces: in a chat child, `agent_before_settle` returns the merge nudge when due and nothing else (no stall, to-do or PR nudge); `tool_call` blocks are unchanged; the preview note (`previewNudge`) never fires; app briefs still attach.

- [ ] **Step 1: Write the failing tests** (with the `load(gitNeedsPr, env)` helper)

```ts
test("a chat session gets no stall, to-do or PR nudge, but still the merge nudge", …); // env {PI_WEB_SESSION_TYPE:"chat"}: stalled run → undefined; open todos → undefined; appsNeedingPr run → undefined; a reply with `gh pr merge` → MERGE_NUDGE entry
test("a chat session is still blocked from pushing and merging", …); // tool_call bash `git push` in an app → REASONS.push; `gh pr merge 3` → REASONS.merge
test("a chat session never gets the preview note", …); // reviewer call for an app with uiChanged and no preview → result carries no PREVIEW_NOTE_MARK
```

- [ ] **Step 2: Run** — `cd guard && node --test --test-concurrency=1 test/index.test.ts` → FAIL.
- [ ] **Step 3: Implement.** — `npm run test -w guard && npm run typecheck -w guard` → PASS.
- [ ] **Step 4: Commit** — `guard: chat sessions keep the blocks and the merge nudge, drop the ritual nudges`

---

## Self-review notes

- Spec coverage: store + absence = code (T1), type follows resume and `/new`/fork/clone (T2), chat flags + env + prompt with the safety block (T3), POST type + home cwd + GET type with parent fallback (T4), superpowers default (T5), guard behaviour (T6). The watch app's sessions stay code (T4 default).
- Names shared with plan 2: `SessionType`, `SessionSummary.type`, `POST /api/sessions` `type` field, env `PI_WEB_SESSION_TYPE`.
