# pi-web chat-app feel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-web opens into a chat (last session if active within 2 h, else a new chat), has an always-visible new-chat button, starts new chats in `~` on the last-picked model, and folds attach/folder/model/approvals into one ＋ menu sheet.

**Architecture:** The hub gains a persisted last-pick store, a cached model catalog probed from an ephemeral `pi --mode rpc --no-session`, `GET /api/defaults`, and `model`/`thinking` on `POST /api/sessions` (passed to pi as `--model`/`--thinking`). The client replaces the new-session page with an in-memory draft chat (`pi-new-chat`) that creates the session on first send and hands the message to `pi-session` in memory; the launch route is a pure function over the session list.

**Tech Stack:** Node 24 + TypeScript (hub, `node --test`), Lit 3 (app, vitest for `lib/`, Playwright e2e against a real pi with a fake model), `@thatsit/kit` (in `kit/`).

**Spec:** `docs/superpowers/specs/2026-10-25-chat-app-feel-design.md`

## Global Constraints

- Launch reopens the latest session only if active within **2 hours** (`2 * 60 * 60 * 1000` ms) or currently live/streaming; else new chat. A URL route other than `#/` / empty always wins.
- No pi process or session file is created by opening the app or tapping new chat; only by sending.
- Folder defaults to `~`; never to the most recent folder. Folder is changeable only before the first message.
- New chats start with the model + thinking Michael **last picked** in pi-web, validated against the current model list; otherwise pi's default. What the draft shows is exactly what the hub passes to pi.
- Draft picks count as a "last pick" only when the session is created with them.
- Copy (exact): header title `new chat`; menu sheet heading `this chat`; rows `attach image`, `folder`, `model`, `approvals`; greyed folder hint `fixed once a chat starts`; new-chat button `aria-label="New chat"`.
- Unsent header stats: empty meter and `0 / <window> (0%) · — t/s` using the draft model's context window (`formatTokens`).
- Use existing design language: `tk-header`, `pi-header` stats row, `pi-composer`, `tk-sheet`, kit tokens, Lucide icons (new chat: `square-pen`). No cost figures added.
- Folder errors: hub keeps `400 Not a folder: …`; client toasts it; hub never creates folders.
- Commits: `git -c user.name="Michael Gutensohn" -c user.email="michael@gutensohn.me" commit …`, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verification for every task: `npm run typecheck` and the workspace's tests pass (`npm test -w hub`, `npm test -w app`, `npm test -w kit` as touched).

## Review Focus

1. **Last pick no longer installed** (model removed from models.json): `/api/defaults` reports pi's default and a session created with no model starts on it — pinned in Task 2.
2. **First send fails at create** (bad folder typed): draft keeps text + images, toast shows `Not a folder: …`, no session in the list — pinned in Task 6 e2e.
3. **App opened with `#/s/<id>` older than 2 h**: opens that session, not a new chat — pinned in Task 4 (`launchRoute` only runs for home) and Task 6.
4. **Probe pi fails or is slow** (bad piBin, no models): `/api/defaults` still answers with `models: []`, `model: null`, and `POST /api/sessions` without a model still works (pi default) — pinned in Task 2.
5. **Thinking level not supported by the chosen model** (non-reasoning model with a remembered `high`): draft shows no thinking control and the hub omits `--thinking` — pinned in Task 2 (`resolveChoice`) and Task 5 (`thinkingLevelsFor`).

---

### Task 1: Last-pick store and recording in the hub

**Files:**
- Create: `hub/src/last-model.ts`
- Modify: `hub/src/rpc-handle.ts` (`RpcHandleOptions`, `afterCommand` `set_model`/`set_thinking` case), `hub/src/main.ts` (wire it)
- Test: `hub/test/last-model.test.ts`, `hub/test/rpc-handle.test.ts`

**Interfaces:**
- Produces:
  - `export interface ModelChoice { provider: string; modelId: string; thinking: ThinkingLevel | null }`
  - `export class LastModelStore { constructor(file: string); get(): ModelChoice | null; set(c: ModelChoice): void }` — file `join(cfg.dataDir, "last-model.json")`, written with mode `0o600`, a missing/corrupt file reads as `null`.
  - `RpcHandleOptions.onModelPicked?: (c: ModelChoice) => void` — called after a successful `set_model` or `set_thinking` with the session's current `state.model` provider/id and `state.thinkingLevel` (after the existing refresh).

- [ ] **Step 1: Write failing tests** in `hub/test/last-model.test.ts`:
  - `set then get round-trips, and a new store on the same file reads it back` — `assert.deepEqual(new LastModelStore(f).get(), { provider: "fake", modelId: "b", thinking: "high" })`.
  - `missing or corrupt file reads as null` — write `"{nope"` to the file; `assert.equal(store.get(), null)`.
  - In `rpc-handle.test.ts`: `set_model reports the pick through onModelPicked` — start an `RpcHandle` with the fake pi env, `run({ type: "set_model", provider, modelId: <second fake model> })`, assert the callback got that provider/modelId.
- [ ] **Step 2:** `npm test -w hub` → the new tests FAIL (module missing / callback not called).
- [ ] **Step 3:** Implement `LastModelStore` and the callback; in `main.ts` create the store and pass `onModelPicked: (c) => lastModel.set(c)` in `factory.startRpc`.
- [ ] **Step 4:** `npm test -w hub` and `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(hub): remember the last model picked in pi-web`.

### Task 2: Model catalog, `/api/defaults`, and model/thinking on new sessions

**Files:**
- Create: `hub/src/model-catalog.ts`
- Modify: `hub/src/rpc-handle.ts` (`RpcHandleOptions.model?: ModelChoice`, `boot()` args), `hub/src/registry.ts` (`create(cwd, choice?)`, `factory.startRpc` options), `hub/src/server.ts` (`GET /api/defaults`, `POST /api/sessions` body), `hub/src/watch.ts:262` (use the default), `hub/src/main.ts`, `shared/src/protocol.ts` (`DefaultsInfo`)
- Test: `hub/test/model-catalog.test.ts`, `hub/test/server.test.ts`, `hub/test/registry.test.ts`

**Interfaces:**
- Consumes: `ModelChoice`, `LastModelStore` (Task 1).
- Produces:
  - `shared/src/protocol.ts`: `export interface DefaultsInfo { models: ModelInfo[]; model: { provider: string; modelId: string; thinking: ThinkingLevel | null } | null; thinkingLevels: ThinkingLevel[]; approvalMode: ApprovalMode; home: string }` — `thinkingLevels` are the levels pi reports for `model` (empty when it doesn't reason).
  - `export class ModelCatalog { constructor(opts: { piBin: string; env?: Record<string,string>; ttlMs?: number }); get(): Promise<Catalog> }` with `interface Catalog { models: ModelInfo[]; piDefault: ModelChoice | null; levels: Record<string, ThinkingLevel[]> }` (key `provider/id`). Probes by spawning `piBin --mode rpc --no-session` in `homedir()`, sending `get_available_models` and `get_state`, then for each reasoning model `set_model` + `get_available_thinking_levels`, then kills it. Cached for `ttlMs` (default `10 * 60_000`); concurrent calls share one probe; a failed probe resolves `{ models: [], piDefault: null, levels: {} }` and is not cached.
  - `export function resolveChoice(cat: Catalog, wanted: ModelChoice | null): ModelChoice | null` — returns `wanted` if its model is in `cat.models` (with `thinking` set to `null` when not in that model's levels), else `cat.piDefault`.
  - `Registry.create(cwd: string, choice?: ModelChoice | null): Promise<SessionHandle>`; `factory.startRpc(o: { cwd: string; sessionFile?: string; model?: ModelChoice | null })`.
  - `RpcHandle.boot()` appends `--model <provider>/<modelId>` and, when `thinking` is set, `--thinking <level>`, only for new sessions (no `sessionFile`).
  - `GET /api/defaults` → `DefaultsInfo` with `model = resolveChoice(catalog, lastModel.get())`.
  - `POST /api/sessions` body `{ cwd?: string; model?: { provider: string; modelId: string }; thinking?: ThinkingLevel }`: choice = body model (validated with `resolveChoice`; an unknown model → 400 `Unknown model: <provider>/<id>`) or the resolved default; when the body named a model, also `lastModel.set(choice)`. Watch-launched sessions use the resolved default.

- [ ] **Step 1: Write failing tests:**
  - `model-catalog.test.ts`: `probes models and pi's default without writing a session file` — fake pi env; `cat.models.length === 2`, `cat.piDefault` equals the env's default model, and the env's sessions dir has no files afterwards. `a bad piBin resolves an empty catalog` — `{ models: [], piDefault: null }`. `resolveChoice falls back to pi's default for an unknown model, and drops thinking a model can't do` — pure, with a hand-built `Catalog`.
  - `server.test.ts`: `defaults report the last pick when it is still available` (pre-set the store to the second fake model; `GET /api/defaults` → `model.modelId` equals it); `defaults fall back to pi's default when the last pick is gone` (store set to `{ provider: "fake", modelId: "gone" }` → `model` equals pi default); `a new session starts on the requested model and records it` (POST with second model → that session's snapshot `state.model.id` equals it and `GET /api/defaults` now reports it); `an unknown model is a 400` (`Unknown model: fake/gone`); `a new session with no model starts on the resolved default`.
- [ ] **Step 2:** `npm test -w hub` → new tests FAIL.
- [ ] **Step 3:** Implement as in Interfaces; `main.ts` builds one `ModelCatalog` with `cfg.piBin` and passes `catalog` and `lastModel` into `createHubServer` deps and the watch.
- [ ] **Step 4:** `npm test -w hub` (all, including watch tests) and `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(hub): start new sessions on the last-picked model`.

### Task 3: Kit header actions slot

**Files:**
- Modify: `kit/src/tk-header.ts` (add `<slot name="actions">` after the title slot inside `.l1`, `flex: none`), kit demo if it lists slots
- Test: `kit/e2e/demo.spec.ts` or existing kit unit test (whichever covers tk-header)

**Interfaces:**
- Produces: `tk-header` renders `slot="actions"` children at the right end of the title line on phone and desktop.

- [ ] **Step 1:** Add a test asserting a `<button slot="actions">` inside `tk-header` is visible and right of the title (bounding box `x` greater than the title's right edge).
- [ ] **Step 2:** Run `npm test -w kit` (or the kit e2e) → FAIL.
- [ ] **Step 3:** Add the slot; style `::slotted([slot="actions"]) { flex: none; }`.
- [ ] **Step 4:** Tests PASS; `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(kit): header actions slot`.

### Task 4: Client libs — routes, launch, draft, API

**Files:**
- Modify: `app/src/lib/route.ts` (drop `cwd` from `new`), `app/src/lib/api.ts` (`defaults()`, `createSession(o)`)
- Create: `app/src/lib/launch.ts`, `app/src/lib/draft.ts`
- Test: `app/src/lib/route.test.ts`, `app/src/lib/launch.test.ts`, `app/src/lib/draft.test.ts`, `app/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `DefaultsInfo` (Task 2).
- Produces:
  - `Route` becomes `{ name: "home" } | { name: "session"; id: string } | { name: "new" } | { name: "settings" }`; `#/new?cwd=x` parses as `{ name: "new" }`.
  - `export const RECENT_MS = 2 * 60 * 60 * 1000;` `export function launchRoute(sessions: SessionSummary[], now: number): Route` — if any session is `live`, the most recently updated live one; otherwise the session with the highest `updatedAt` if `now - updatedAt <= RECENT_MS`; else `{ name: "new" }`.
  - `api.defaults(): Promise<DefaultsInfo>`; `api.createSession(o: { cwd: string; model?: { provider: string; modelId: string }; thinking?: ThinkingLevel | null }): Promise<{ sessionId: string }>` (omit `thinking` when null).
  - `draft.ts` (module state, one per tab): `export interface Draft { text: string; images: ImageInput[]; cwd: string; model: { provider: string; modelId: string } | null; thinking: ThinkingLevel | null; approval: ApprovalMode | null }`; `getDraft(): Draft` (fresh: `cwd "~"`, others empty/null); `updateDraft(p: Partial<Draft>): void`; `resetDraft(): void`; `handOff(sessionId: string, msg: { text: string; images: ImageInput[]; approval: ApprovalMode | null }): void`; `takeHandoff(sessionId: string): { text; images; approval } | null` (returns once, then null).

- [ ] **Step 1: Write failing tests:**
  - `launch.test.ts`: `reopens the latest session updated within 2 hours`; `opens a new chat when the latest is older than 2 hours` (`updatedAt = now - RECENT_MS - 1` → `{ name: "new" }`); `a live session counts however old`; `no sessions → new chat`.
  - `route.test.ts`: `#/new?cwd=/x` → `{ name: "new" }`; `hrefFor({ name: "new" }) === "#/new"`.
  - `draft.test.ts`: `a fresh draft is ~ with no model`; `takeHandoff returns the message once`; `resetDraft clears text, images, folder and model`.
  - `api.test.ts`: `createSession sends model and omits a null thinking` (assert request body JSON).
- [ ] **Step 2:** `npm test -w app` → FAIL.
- [ ] **Step 3:** Implement. Remove the `cwd` uses from callers only as far as typecheck requires (`pi-new-session` is deleted in Task 6).
- [ ] **Step 4:** `npm test -w app` and `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(app): launch route, draft chat and defaults API`.

### Task 5: ＋ menu sheet, composer footer, header new-chat button

**Files:**
- Create: `app/src/render/chat-menu.ts`
- Modify: `app/src/components/pi-composer.ts` (footer), `app/src/components/pi-header.ts` (actions slot button; draft mode), `app/src/components/pi-session.ts` (`Sheet` gains `"menu"`; menu steps), `app/src/render/sheets.ts` (export model/settings sheet bodies so the menu can reuse them without a `Snapshot` where needed)
- Test: `app/src/render/chat-menu.test.ts` (pure helpers), e2e in Task 6

**Interfaces:**
- Produces:
  - `pi-composer`: footer order `＋` (button, `aria-label="Chat options"`, emits `pi-open-sheet` with `"menu"`), model label (unchanged event `"model"`; new optional `folder: string | null` property shown after the label as ` · <folder>` in `--text-secondary`), send/stop. The sliders button and the image `<label>` are removed; a public `pickImages(): void` opens the hidden file input (same `onFiles` rules).
  - `export type MenuStep = "root" | "folder" | "model" | "approvals";`
  - `export function chatMenu(v: { step: MenuStep; canImages: boolean; cwd: string; cwdFixed: boolean; model: string; approval: ApprovalMode | null; recentCwds: string[] }, on: { step(s: MenuStep): void; attach(): void; pickCwd(path: string): void }): TemplateResult` — root rows in order `attach image` (hidden unless `canImages`), `folder` (value = abbreviated cwd; when `cwdFixed` greyed, not clickable, hint `fixed once a chat starts`), `model`, `approvals`; `folder` step renders a path input (default the current cwd) + `recent` list from `recentCwds`, Enter/tap calls `pickCwd`. `model` and `approvals` steps are rendered by the caller with the existing sheet bodies. Non-root steps show a `‹` back control that calls `step("root")`.
  - `export function thinkingLevelsFor(m: ModelInfo | null, known: ThinkingLevel[]): ThinkingLevel[]` — `known` when non-empty, else `[]` for a non-reasoning model.
  - `pi-header`: a `square-pen` button in `slot="actions"`, `aria-label="New chat"`, `href`-like behaviour: `location.hash = "#/new"`. New property `draft: { contextWindow: number } | null` — when set, title row shows `new chat` and the stats row shows an empty meter and `0 / <formatTokens(window)> (0%) · — t/s`.
  - `pi-session` heading for the menu sheet: `this chat`; steps swap the body in place.

- [ ] **Step 1:** `chat-menu.test.ts`: `thinkingLevelsFor hides levels for a non-reasoning model`; `chatMenu omits attach image when the model takes no images` (render to a container with lit `render`, assert no element with text `attach image`); `a fixed folder row is not clickable and says fixed once a chat starts`.
- [ ] **Step 2:** `npm test -w app` → FAIL.
- [ ] **Step 3:** Implement; in `pi-session`, the `folder` row is `cwdFixed: true` with the session's cwd; `model`/`approvals` steps reuse `modelSheet`/`settingsSheet`; `attach` closes the sheet and calls `composer.pickImages()`.
- [ ] **Step 4:** `npm test -w app`, `npm run typecheck` → PASS. Manually check with `npm run dev` + e2e hub if convenient.
- [ ] **Step 5:** Commit `feat(app): one ＋ menu and an always-visible new-chat button`.

### Task 6: Draft chat page, first-send handoff, launch, e2e

**Files:**
- Create: `app/src/components/pi-new-chat.ts`
- Delete: `app/src/components/pi-new-session.ts`
- Modify: `app/src/components/pi-app.ts` (launch + routes, remove the "pick a session" home and the `pi-new-session` import), `app/src/components/pi-session.ts` (consume handoff), `app/src/components/pi-sidebar.ts` (`+ new` / empty-state links stay `#/new`), `app/src/components/pi-settings.ts` if it renders its own header (add the new-chat action), `app/e2e/smoke.spec.ts`, `app/e2e/look.spec.ts` + snapshots
- Test: e2e

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces:
  - `pi-new-chat` (`api`, `home` props): loads `api.defaults()` and `api.cwds()` once; shows `pi-header` with `draft` set, an empty state (`what are we doing?`), `pi-composer` with `folder` = draft cwd, and the `this chat` menu sheet (folder step live, model step lists `defaults.models` with `thinkingLevelsFor`, approvals step defaults to `defaults.approvalMode`). Composer text/images mirror into `updateDraft` so leaving and returning keeps them. On submit: `api.createSession({ cwd, model, thinking })`; on error toast the message and `composer.restore(text, images)`; on success `handOff(id, { text, images, approval })`, `resetDraft()`, `location.hash = hrefFor({ name: "session", id })`.
  - `pi-session`: after its first snapshot, `takeHandoff(sessionId)`; if present, apply `approval` (when non-null and different) via `set_approval`, then send `text`/`images` through the same path as `onSubmit` (so failures `restore()` into the composer).
  - `pi-app`: on `home` route, wait for the first sessions list (`ListStore` loaded), then `history.replaceState` to `hrefFor(launchRoute(list.sessions, Date.now()))` and render that; while loading render nothing.
- [ ] **Step 1: Update/add e2e tests** (`smoke.spec.ts`):
  - `launch with no route opens a new chat when nothing is recent` — goto `/`; expect heading `new chat` and URL `#/new`.
  - `new chat: send creates the session in ~ and the reply streams` — goto `/#/new`, type `hi`, send; URL becomes `#/s/…`, the user message `hi` and `Hello world` appear, the stats sheet's folder is the hub's home.
  - `new chat: a bad folder keeps the message and says why` — open ＋ → folder, enter `/nope`, back, type `hi`, send; toast contains `Not a folder`, composer still contains `hi`, URL still `#/new`.
  - `new chat: the model picked in the draft is the one pi starts with, and the next new chat remembers it` — pick the second fake model in ＋ → model, send; session header/model label shows it; click `New chat`; model label shows it.
  - `launch reopens a session active within 2 hours` — after the send test, goto `/`; URL is that `#/s/<id>`.
  - Existing tests that used `/#/new`'s folder field and `start session` switch to the new flow (folder via ＋ → folder, `WORKDIR` for the @-mention test).
  - `look.spec.ts`: replace `new` snapshot with the draft chat; add `chat-menu` (sheet open) snapshot; regenerate with `npx playwright test --update-snapshots` and eyeball the PNGs (both themes, phone + desktop).
- [ ] **Step 2:** `npm run e2e -w app` → new tests FAIL.
- [ ] **Step 3:** Implement `pi-new-chat`, the handoff, and the launch; delete `pi-new-session.ts`.
- [ ] **Step 4:** `npm run e2e -w app`, `npm test`, `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(app): open into a chat; new chats start on send`.
