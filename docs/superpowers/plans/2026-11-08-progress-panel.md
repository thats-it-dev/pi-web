# Progress Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick each box (`- [ ]` → `- [x]`) in this file as soon as the step is done.**

**Goal:** Add a progress panel to pi-web. It shows the session's goal, plan, to-dos and subagents as a right-hand column on desktop and as a header badge plus full-screen view on the phone, and it opens subagent threads read-only.

**Architecture:** A pure function in `shared/` derives to-dos, subagents and the plan path from the `Conversation` the app already holds, so live runs and loaded history go through the same code. The hub adds four read-only routes for things the conversation doesn't carry: the goal (stored as `custom` session entries), the plan file text, background-subagent status (from `status.json`), and a child's transcript. Every path these routes read comes from the parent session's own records, never from the request. The app gets a `ProgressStore`, a pure `renderProgress`, a layout change in `pi-session`, and a new route for subagent threads.

**Tech Stack:** TypeScript, Node ≥ 22.18 (`.ts` run directly, `node:test`) for `shared/` and `hub/`; Lit + Vite + vitest for `app/`; Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-08-progress-panel-design.md`

## Global Constraints

- The hub stays at **zero runtime dependencies**, and the app adds no new npm dependencies.
- **Read-only:** no route or UI action steers, stops or edits anything. The panel never writes to a session or a plan.
- **No arbitrary file reads:** every file the hub reads for the panel must be either a `.md` under the session's cwd (after realpath) or a path listed in that session's own subagent tool results.
- **Styling comes from existing tokens only:** `theme/theme.css` and `@thatsit/kit` `sharedStyles`, matching `pi-sidebar.ts`, in light and dark. No new fonts or colours.
- **Report states honestly:** a child or item whose state can't be confirmed shows `unknown`, never `running`.
- Breakpoints: the desktop column shows at **≥ 1200 px** viewport width; below that, the header badge plus full-screen view. (The left nav already collapses at 900 px.)
- Copy: section headings are `goal`, `plan`, `to-dos` and `subagents`, lower-case like the rest of pi-web. Activity labels are `working`, `idle` and `waiting on you`.

## Review Focus

1. **The pi process dies mid-subagent** (`handle_gone`, or the hub restarts). The child must show `unknown`, not `running`. Test in Task 2 (`live: false` with a running tool), plus a session-store case in Task 4.
2. **Reload or reconnect mid-run.** History arrives first, with a `subagent` toolCall that has no toolResult, then the snapshot with `conv.tools` running. The child shows `unknown` until the snapshot arrives, then `running`. Test in Task 2.
3. **Plan path escapes the cwd.** `../`, absolute paths, a symlink pointing outside, non-`.md` files and files over 512 KB must all return 404. Test in Task 3.
4. **Crafted child key.** A key that isn't in the parent's own derived subagent list, or a key from another session, returns 404 and reads nothing. Test in Task 3.
5. **Missing or broken background status.** An `asyncDir` that's deleted, or a `status.json` that's corrupt or partly written, shows `unknown`, not `running`. Test in Task 3.

---

### Task 1: Capture real fixtures and lock the data shapes

The spec flags that the subagent and goal record shapes were never seen in a real run. This task produces the fixtures every later test uses, and records any surprises.

**Files:**
- Create: `shared/test/fixtures/progress/todo.jsonl`, `subagent-fg.jsonl`, `subagent-bg.jsonl`, `goal.jsonl` (trimmed session files)
- Create: `shared/test/fixtures/progress/subagent-fg.rpc-events.jsonl` (RPC events from a live foreground subagent run)
- Create: `shared/test/fixtures/progress/bg-run/status.json` (copied from the real async dir, paths rewritten)
- Create: `shared/test/fixtures/progress/NOTES.md`

**Interfaces:**
- Produces: fixture files named above. `NOTES.md` states, for each one, the exact field paths later tasks read.

- [ ] **Step 1: Run real pi sessions** in a scratch dir (`mktemp -d`) on the spark, with the user's normal agent dir and default model (flash-auto), using `pi -p` / `pi --mode rpc`. Make four runs: (a) a 3-step task tracked with the `todo` tool; (b) a foreground `subagent` call (agent `scout`); (c) a background (async) `subagent` call; (d) `/goal <text>` driven to `goal_complete`. For (b), also record every RPC event to `subagent-fg.rpc-events.jsonl`.
- [ ] **Step 2: Trim the session files into fixtures.** Keep the session header, user and assistant messages, toolCall and toolResult entries, `custom` entries, and enough text to be readable. Rewrite absolute paths to `/FIXTURE/...`. **Never commit private content.**
- [ ] **Step 3: Write `NOTES.md` answering each question** with the field path that answers it:
  - Where are the to-do tasks? (expected: `toolResult.details.tasks[]`)
  - Where are the subagent children? (expected: `details.results[]` with `agent`, `task`, `exitCode`, `stopped`/`interrupted`/`timedOut`, `sessionFile`)
  - Does `tool_execution_update.partialResult.details.results[].sessionFile` exist while the child runs?
  - Is the child's `sessionFile` written incrementally while it runs?
  - Where are the background `asyncDir`/`asyncId`, the `status.json` `state` values (list every terminal value seen or documented in pi-subagents `docs/observability.md`), and `startedAt`/`endedAt`?
  - Where is the goal entry? (expected: entry `{type:"custom", customType:"goal-state", data:{goal:{id,text,status,...}|null}}` with `GoalStatus = active|paused|blocked|usage_limited|budget_limited|complete`, plus an optional `waiting` field)
  - What are the read/edit/write tool names and their path argument key? (expected: `read`/`edit`/`write`, `args.path`)
  - Do child session files land inside the hub's indexed sessions dir (`sessionsDir()` in `hub/src/sessions.ts`)? If so, does their header carry `parentSession`, and do they show up in `GET /api/sessions`?
- [ ] **Step 4: If any answer differs from "expected",** update the type definitions in Task 2's Interfaces block in this plan file (in place) before starting Task 2, and note the change at the top of `NOTES.md`.
- [ ] **Step 5: Commit**

```bash
git add shared/test/fixtures/progress docs/superpowers/plans/2026-11-08-progress-panel.md
git commit -m "test: real pi fixtures for todo, subagent and goal records"
```

### Task 2: Derive progress in `shared/`

**Files:**
- Create: `shared/src/progress.ts`, `shared/src/plan.ts`
- Test: `shared/test/progress.test.ts`, `shared/test/plan.test.ts`
- Modify: `hub/src/sessions.ts` (export `branchEntries(text): Entry[]`, which `historyFromText` then uses; no behaviour change)
- Create: `shared/src/goal.ts`, `shared/test/goal.test.ts`

**Interfaces:**
- Consumes: `Conversation`, `AgentMessage`, `ToolRun` from `shared/src/protocol.ts`; fixtures from Task 1.
- Produces:
```ts
// shared/src/progress.ts
export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export interface Todo { id: number; subject: string; status: TodoStatus; activeForm?: string }
export type ChildState = "running" | "done" | "failed" | "stopped" | "unknown";
export interface SubagentChild {
  key: string;            // `${toolCallId}:${index}`
  toolCallId: string; index: number;
  agent: string; task: string;   // task from the toolCall's arguments.task: results[].task is the literal "[prompt redacted]"
  state: ChildState;
  background: boolean;
  turn: number;           // number of user messages before the spawning toolCall
  startedAt: number | null; endedAt: number | null; // ms epoch
  sessionFile: string | null; asyncDir: string | null;
}
export interface Progress { todos: Todo[] | null; subagents: SubagentChild[]; planPath: string | null }
export function deriveProgress(conv: Conversation, opts: { live: boolean }): Progress;
export function groupSubagents(children: SubagentChild[]): { recent: SubagentChild[]; earlier: SubagentChild[] };
export const PLAN_PATH_RE: RegExp; // /(^|\/)docs\/superpowers\/plans\/[^/]+\.md$/

// shared/src/plan.ts
export interface PlanTask { title: string; done: number; total: number }
export interface PlanDoc { title: string | null; tasks: PlanTask[]; current: number | null } // index into tasks
export function parsePlan(markdown: string): PlanDoc;

// shared/src/goal.ts
export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
// Real pi writes `{goal:null}` right after a `complete` entry (see fixtures NOTES.md), so a null that
// immediately follows a complete goal keeps the complete goal; any other null gives null.
export interface Goal { text: string; status: GoalStatus; waiting: boolean; updatedAt: number | null }
export function goalFromEntries(entries: Array<{ type?: string; customType?: string; data?: unknown }>): Goal | null;
```

- [x] **Step 1: Write the failing tests** in `shared/test/progress.test.ts`. Each test builds a `Conversation` from a fixture (`historyFromText`) or replays `subagent-fg.rpc-events.jsonl` through `applyEvent`:
  - `todos come from the latest todo result`: the `todo.jsonl` fixture yields the last snapshot's tasks, in order, with `activeForm` kept. A conversation with no `todo` results yields `todos === null`. Rows with `status: "deleted"` are left out.
  - `foreground child finished`: `subagent-fg.jsonl` with `live:false` gives one child with `state === "done"`, a non-empty `agent` and `task`, `background === false`, and `sessionFile` matching the fixture.
  - `running only while live`: replaying events up to (not including) `tool_execution_end` gives `state === "running"` with `live:true`, and `state === "unknown"` with `live:false` (**Review Focus 1**).
  - `reload mid-run`: history containing the subagent toolCall but no toolResult, `live:false`, gives `unknown`. After the same conv gets `tool_execution_start`, `live:true` gives `running` (**Review Focus 2**).
  - `failed and stopped`: a result with `exitCode !== 0` or `isError` gives `failed`; `stopped`/`interrupted`/`timedOut` gives `stopped`.
  - `background child is unknown until status is read`: `subagent-bg.jsonl` gives `background === true`, `state === "unknown"` and `asyncDir` set.
  - `groupSubagents`: children in turns 1, 1, 3 plus a background child in turn 1 with state `running` give `recent` = the turn-3 child plus the running background child, and `earlier` = the other two, newest (highest turn, then highest index) first.
  - `planPath`: the most recent `read`/`edit`/`write` call whose `args.path` matches `PLAN_PATH_RE` wins. Paths elsewhere (e.g. `docs/notes.md`) are ignored, and there's `null` when none match.
- [x] **Step 2: Write the failing tests** in `shared/test/plan.test.ts`:
  - `### Task 1: A` with 2 boxes (1 ticked) and `### Task 2: B` with 3 unticked gives `tasks = [{title:"Task 1: A",done:1,total:2},{title:"Task 2: B",done:0,total:3}]`, `current === 0`, and `title` from the first `# ` heading.
  - All ticked gives `current === null`.
  - No `### Task` headings gives `tasks: []` and `current: null` (show nothing rather than a wrong step).
  - Boxes inside fenced code blocks are not counted (plans quote checkbox syntax in code).
- [x] **Step 3: Write the failing tests** in `shared/test/goal.test.ts`: the `goal.jsonl` entries give the final goal with `status === "complete"`. The latest entry with `goal: null` gives `null`, except that a `goal: null` entry directly after a `complete` entry (what pi really writes on `goal_complete`) keeps that complete goal. A malformed `data` gives `null`. A goal with a `waiting` field gives `waiting: true`.
- [x] **Step 4: Run the tests and confirm they fail**

Run: `npm test -w shared`
Expected: FAIL (modules not found)

- [x] **Step 5: Implement `progress.ts`, `plan.ts` and `goal.ts`** to the signatures above. Walk `conv.messages` in order, counting user messages for `turn`. Take toolCall timestamps from the containing assistant message and `endedAt` from the toolResult message. Overlay `conv.tools[toolCallId]` (running, `partialResult`, `result`) on top. A toolCall without a result is `running` only when `opts.live && conv.tools[id]?.running`, otherwise `unknown`.
- [x] **Step 6: Export `branchEntries`** from `hub/src/sessions.ts`. Refactor `historyFromText` to use it.
- [x] **Step 7: Run the tests and confirm they pass**

Run: `npm test -w shared && npm test -w hub && npm run typecheck`
Expected: PASS

- [x] **Step 8: Commit**

```bash
git add shared/src/progress.ts shared/src/plan.ts shared/src/goal.ts shared/test hub/src/sessions.ts
git commit -m "feat(shared): derive to-dos, subagents, plan and goal from a session"
```

### Task 3: Hub read-only progress routes

**Files:**
- Create: `hub/src/progress-routes.ts`
- Modify: `hub/src/server.ts` (call `routeProgress` before the generic `sm` session-route match)
- Test: `hub/test/progress-routes.test.ts`

**Interfaces:**
- Consumes: `deriveProgress`, `goalFromEntries`, `SubagentChild` (Task 2); `branchEntries`, `readHistory`, `SessionIndex` (`hub/src/sessions.ts`); `Registry`.
- Produces (all `GET`, same auth and CORS as the other session routes, 404 `{error}` for unknown session or disallowed input):
  - `/api/sessions/:id/goal` → `{ goal: Goal | null }`. Reads the session file (live handle's `sessionFile`, or the index), using `branchEntries` + `goalFromEntries`.
  - `/api/sessions/:id/plan?path=<rel>` → `{ path: string; text: string; mtimeMs: number }`. The path must be relative, match `/\.md$/` and be ≤ 512 KB, and `realpath(join(cwd, path))` must stay under `realpath(cwd)`.
  - `/api/sessions/:id/subagents` → `{ children: SubagentChild[] }`. This is `deriveProgress(parentConv, {live})` with each background child's `state`/`startedAt`/`endedAt` replaced from `<asyncDir>/status.json`. A missing, unreadable or invalid file, or an unrecognised state, gives `unknown`.
  - `/api/sessions/:id/subagents/:key/history` → `{ messages: AgentMessage[]; child: SubagentChild }`. `key` must be one of the derived children's keys. Messages come from `readHistory(child.sessionFile)`. With no `sessionFile`, they fall back to `details.results[index].messages` from the parent; with neither, 404.
  - `export async function routeProgress(req, res, url, deps: { registry: Registry; index: SessionIndex; cors: Cors }): Promise<boolean>` returns `false` when the path isn't one of these routes.

Parent conv: `registry.get(id)?.snapshot().conv` with `live: true`, else `createConversation(await readHistory(file))` with `live: false`. Map the status.json `state` values recorded in Task 1's `NOTES.md` onto `ChildState`.

- [ ] **Step 1: Write the failing tests** in `hub/test/progress-routes.test.ts`, set up the way `hub/test/server.test.ts` does (temp sessions dir, `SessionIndex`, `Registry`, `createHubServer`, `call(...)` with the `GOOD` headers). Copy Task 1's fixtures in as session files, with `/FIXTURE` rewritten to the temp root:
  - `goal`: the fixture session gives the `complete` goal; a session with no goal entries gives `{goal:null}`; an unknown id gives 404.
  - `plan`: `docs/superpowers/plans/p.md` under the cwd gives its text. `../outside.md`, `/etc/hosts`, `notes.txt`, a symlink `docs/superpowers/plans/evil.md → <root>/secret.md`, and a 600 KB `.md` all give 404 (**Review Focus 3**).
  - `subagents`: the background fixture with `status.json` `state` set to a running value gives `running`, and a terminal success value gives `done`. With the asyncDir deleted, `status.json` = `"{"`, or `state: "weird"`, it gives `unknown` (**Review Focus 5**).
  - `child history`: a valid key gives the child transcript's messages. A key not in the list, the key of a child from a *different* session, and `..%2F` all give 404 without touching the filesystem outside the recorded `sessionFile` (**Review Focus 4**).
  - `children stay out of the sidebar` (only if Task 1's NOTES say child files land in the indexed dir): a child session file seeded beside its parent is missing from `GET /api/sessions`. Filter it in `listSessions` in `server.ts`, using the marker NOTES identified (e.g. `parentSession` plus the pi-subagents session name).
- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test hub/test/progress-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `hub/src/progress-routes.ts`** and wire it into `server.ts`.
- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -w hub && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hub/src/progress-routes.ts hub/src/server.ts hub/test/progress-routes.test.ts
git commit -m "feat(hub): read-only goal, plan, subagent status and child history routes"
```

### Task 4: App data: API methods and `ProgressStore`

**Files:**
- Modify: `app/src/lib/api.ts` (add four methods)
- Create: `app/src/lib/progress-store.ts`
- Test: `app/src/lib/progress-store.test.ts`

**Interfaces:**
- Consumes: Task 3 routes; `SessionStore` (`app/src/lib/session-store.ts`: `conv`, `status`, `snapshot`, `"change"` event); Task 2 types.
- Produces:
```ts
// api.ts (HubApi)
goal(id: string): Promise<{ goal: Goal | null }>;
plan(id: string, path: string): Promise<{ path: string; text: string; mtimeMs: number }>;
subagents(id: string): Promise<{ children: SubagentChild[] }>;
childHistory(id: string, key: string): Promise<{ messages: AgentMessage[]; child: SubagentChild }>;

// progress-store.ts
export type Activity = "working" | "idle" | "waiting";
export interface ProgressView {
  goal: Goal | null;
  plan: (PlanDoc & { path: string }) | null;
  todos: Todo[] | null;
  subagents: { recent: SubagentChild[]; earlier: SubagentChild[] };
  activity: Activity;
  empty: boolean; // nothing in any section
}
export class ProgressStore extends EventTarget { // dispatches "change"
  constructor(api: Pick<HubApi, "goal" | "plan" | "subagents">, session: SessionStore);
  get view(): ProgressView;
  start(): void; stop(): void;
}
```

Behaviour (implement exactly):
- `live` = `session.status === "live"`. `activity`: `waiting` if the snapshot has `dialogs.length > 0` or a `terminalPrompt`; else `working` if `conv.streaming`; else `idle`.
- Re-derive on every session `"change"`.
- Goal: fetch on `start()`, on each `agent_settled` (watch `conv.streaming` going true→false), when a `goal_*` tool run ends, and every 5 s while `conv.streaming`.
- Plan: fetch when `planPath` changes, and again when an `edit`/`write` tool run on that path ends. A 404 sets `plan = null`.
- Subagents: while any background child is `unknown` or `running`, poll `subagents()` every 3 s and merge each background child's `state`/`startedAt`/`endedAt` by `key`. Stop polling once all are terminal or on `stop()`.
- Fetch errors keep the last good value. They never turn a terminal state back into `running`.

- [ ] **Step 1: Write the failing tests** (vitest, fake timers, a fake api, and a real `SessionStore` fed `setHistory`/`apply`):
  - `activity follows the snapshot`: an open dialog gives `waiting`, streaming gives `working`, neither gives `idle`.
  - `goal refetches on settle`: streaming true→false triggers a second `goal()` call.
  - `plan refetches after an edit to it`: a `tool_execution_end` for `edit` with that `path` triggers a second `plan()` call, while an edit to another file doesn't.
  - `background polling stops when terminal`: the fake api returns `running` then `done`. After `done` and advancing 10 s, no further `subagents()` calls are made.
  - `stream drops mid-run`: the session store gets `handle_gone`, so status leaves `live` and a previously `running` foreground child becomes `unknown` (**Review Focus 1**).
- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w app -- progress-store`
Expected: FAIL

- [ ] **Step 3: Implement the API methods and `ProgressStore`.**
- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -w app && npm run typecheck -w app`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/progress-store.ts app/src/lib/progress-store.test.ts
git commit -m "feat(app): progress store over the session and the hub's progress routes"
```

### Task 5: Render the panel

**Files:**
- Create: `app/src/render/progress.ts`
- Test: `app/src/render/progress.test.ts`

**Interfaces:**
- Consumes: `ProgressView` (Task 4).
- Produces:
```ts
export function renderProgress(view: ProgressView, opts: { now: number; selectedKey: string | null; openChild: (key: string) => void; openPlan: (path: string) => void }): TemplateResult;
export function badgeLabel(view: ProgressView): string | null; // null = no badge
export const progressStyles: CSSResult;
```

Render rules:
- The top line is the activity: `working`, `idle` or `waiting on you` (the last uses `--accent`).
- Sections appear in this order, each only when it has data: `goal` (text plus status pill; `complete` uses `--success`, `blocked`/`*_limited` use `--accent`); `plan` (file name, each task with `done/total`, `current` highlighted with `--primary`, an "open plan" link calling `openPlan`); `to-dos` (heading count `completed/total excluding deleted`, the in-progress row showing `activeForm ?? subject` in `--primary`, completed rows struck through with `--text-muted`); `subagents` (the `recent` rows, then a `<details>` "earlier (n)").
- A subagent row shows `agent · task` truncated with ellipsis, a state glyph (`◐` running, `✓` done, `✕` failed, `■` stopped, `?` unknown, each with an `aria-label` of the state), and elapsed time from `startedAt` to `endedAt ?? now` via the existing `app/src/lib/format.ts` helpers (add `formatElapsed(ms): string` there if none exists, as `1m 12s` / `45s`). It is a `<button>` calling `openChild(key)`, with `aria-current` when its key is `selectedKey`.
- `badgeLabel`: to-dos present gives `"done/total"`; else the running-subagent count gives `"◐ n"`; else a goal or plan gives `"•"`; else `null`.
- When a list is long, keep the in-progress item visible: show at most 8 to-dos and 12 plan tasks, centred on the current one, with a `+n more` line.

- [ ] **Step 1: Write the failing tests** (vitest + lit `render` into a detached div; assert on text and attributes): each section's presence and absence; the to-do count excludes `deleted`; an `unknown` child has `aria-label="unknown"` and never contains `◐`; clicking a subagent row calls `openChild` with its key; `badgeLabel` covers all four cases; the overflow keeps the current item visible with 20 to-dos and in-progress at index 15.
- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w app -- render/progress`
Expected: FAIL

- [ ] **Step 3: Implement it.** Match `pi-sidebar.ts`'s spacing and typography (read it first). Use only the tokens in Global Constraints.
- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -w app`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/render/progress.ts app/src/render/progress.test.ts app/src/lib/format.ts
git commit -m "feat(app): render goal, plan, to-dos and subagents"
```

### Task 6: Desktop column, phone badge and full-screen view

**Files:**
- Modify: `app/src/components/pi-session.ts` (own a `ProgressStore`; layout)
- Modify: `app/src/components/pi-header.ts` (add a `badge: string | null` property that renders a button emitting `pi-open-progress`)
- Create: `app/src/components/pi-progress-view.ts` (the full-screen phone view: a close button, `renderProgress`, and focus trapped like the existing `tk-sheet`)
- Modify: `app/e2e/hub-for-e2e.ts`, `app/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces: the custom events `pi-open-progress` (header → session), `pi-open-child` (detail: `key`) and `pi-open-plan` (detail: `path`). Task 7 handles `pi-open-child`; for `pi-open-plan`, open the plan text from `ProgressStore` in a `tk-sheet` rendered with the existing markdown renderer.

Layout rules:
- At ≥ 1200 px with `!view.empty`, `pi-session` is a two-column grid: chat, then a 300 px `<aside>` with `border-left: 1px solid var(--line)` that scrolls on its own. With `view.empty` there's no aside and the chat is full width.
- Below 1200 px there's no aside: the header shows the badge when `badgeLabel` isn't `null`. Tapping it, or a touch swipe starting within 24 px of the right edge and moving ≥ 60 px left, opens `pi-progress-view` full screen. Close it with ✕, Escape, or browser Back (push a history state while it's open).
- `ProgressStore` is created in `open()`, alongside `SessionStore`, and stopped in `teardown()`.

- [ ] **Step 1: Seed the e2e hub.** Copy `todo.jsonl` and `subagent-fg.jsonl` from Task 1 into the e2e sessions dir, with `/FIXTURE` rewritten to `WORKDIR`, plus a `docs/superpowers/plans/p.md` with two tasks.
- [ ] **Step 2: Write the failing e2e tests** in `smoke.spec.ts`:
  - desktop (1280×800): open the seeded session. The aside shows `to-dos` with the fixture's count and `subagents` with one `done` row.
  - phone project: the header badge shows the count; tapping it shows the full-screen view; Escape closes it.
  - desktop: a session with none of this data has no aside.
- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm run e2e -w app -- smoke`
Expected: FAIL

- [ ] **Step 4: Implement the layout, the header badge and `pi-progress-view`.**
- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run e2e -w app`
Expected: PASS. Update the `look.spec.ts` snapshots only for sessions that now legitimately show the panel, and say so in the commit message.

- [ ] **Step 6: Visual check:** run the dev hub and app (README "Develop") against a real session that has to-dos and a subagent, and screenshot desktop (1280 and 1440) and phone, in light and dark. Compare against `pi-sidebar` for spacing and type, and fix anything that looks bolted on.
- [ ] **Step 7: Commit**

```bash
git add app/src app/e2e
git commit -m "feat(app): progress column on desktop, badge and full view on phone"
```

### Task 7: Read-only subagent thread

**Files:**
- Modify: `app/src/lib/route.ts` (+ `route.test.ts`)
- Modify: `app/src/components/pi-app.ts`, `app/src/components/pi-session.ts`
- Create: `app/src/components/pi-child-thread.ts`
- Modify: `app/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `api.childHistory` (Task 4); `renderConversation` (`app/src/render/messages.ts`); `pi-open-child` (Task 6).
- Produces:
  - `Route` gains `{ name: "subagent"; id: string; key: string }`, with `#/s/<id>/sub/<key>` parsed and printed by `parseRoute`/`hrefFor`.
  - `pi-session` gets `childKey: string | null`. When it's set, the chat area renders `<pi-child-thread .api .sessionId .childKey>` instead of messages + composer. The parent's `SessionStore` stream stays open, so the column stays live.
  - `pi-child-thread`: a breadcrumb `<parent heading> › <agent> · <task>` with a `read-only` tag and the state glyph; the transcript via `renderConversation`; and a bottom bar `viewing a subagent · back to parent` that takes the place of the composer, with no input. While `child.state` is `running` or `unknown` *and* the parent is live, it polls `childHistory` every 2 s, and stops once the state is terminal.
  - `pi-open-child` → `location.hash = hrefFor({name:"subagent", id, key})`. On the phone this also closes `pi-progress-view`. Back to parent → `hrefFor({name:"session", id})`.

- [ ] **Step 1: Write the failing tests:** `route.test.ts` round-trips `#/s/abc/sub/call_1%3A0`. In e2e on desktop, clicking the seeded subagent row shows the breadcrumb, the `read-only` tag and the child's first message, no textarea is present, and clicking "back to parent" returns to the chat. On the phone: badge → row → thread full screen → back.
- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w app -- route && npm run e2e -w app -- smoke`
Expected: FAIL

- [ ] **Step 3: Implement the route, `pi-child-thread` and the wiring.**
- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run e2e -w app`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src app/e2e
git commit -m "feat(app): open a subagent's thread read-only"
```

### Task 8: Make agents tick plan checkboxes, and verify it end to end

**Files:**
- Create or modify: `~/.pi/agent/AGENTS.md`. Outside the repo, but pi loads it for every session; confirmed in pi 1.0.2 `docs/configuration.md` (context files). Check with `ls` that it doesn't already exist; if it does, append rather than overwrite.
- Modify: `README.md` (one paragraph under a new "Progress panel" heading: what it shows, where the data comes from, and the AGENTS.md instruction)

- [ ] **Step 1: Add this instruction verbatim** to `~/.pi/agent/AGENTS.md`:

```markdown
## Plan files

When you are executing a plan file (for example `docs/superpowers/plans/*.md`) that uses `- [ ]` checkboxes, change each step's `- [ ]` to `- [x]` in that file as soon as the step is done, before starting the next step. Do not tick a step you skipped or that failed.
```

- [ ] **Step 2: Verify with a real run.** In a scratch git repo, write a 2-task / 5-step toy plan under `docs/superpowers/plans/` and run `pi -p "execute the plan in docs/superpowers/plans/toy.md"` on flash-auto. Expected: all 5 boxes are `[x]` afterwards. Then open that session in the dev app and confirm the plan section moved through the tasks. Run it twice. **If ticking fails in either run, stop and report to Michael with the session file. Don't guess at the current step.**
- [ ] **Step 3: Live check of the whole panel:** start the dev hub and app, and run one real session that uses `todo`, a foreground `subagent`, a background `subagent` and `/goal`. Watch it live on desktop and phone. Kill the pi process mid-subagent and confirm the child turns `unknown` (**Review Focus 1**).
- [ ] **Step 4: Commit the README** (AGENTS.md lives outside the repo; mention it in the commit body)

```bash
git add README.md
git commit -m "docs: progress panel; agents tick plan checkboxes via ~/.pi/agent/AGENTS.md"
```
