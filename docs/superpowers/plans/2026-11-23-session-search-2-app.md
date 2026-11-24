# Session Search — Plan 2 of 2: panel search mode, hits, jump to message

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sessions panel gets a search icon that swaps the top row for a field; typing filters titles instantly and, after a pause, shows "In conversations" hits from the hub; tapping a hit opens the session scrolled to the message with a fading amber wash.

**Architecture:** `route.ts` learns `#/s/<id>/at/<n>`; `api.ts` gains `search()`; a `SearchStore` (debounce, abort, state) feeds a `render/search-hits.ts` module; `pi-sidebar` owns the search-open state and header swap; `render/messages.ts` tags rendered messages with `data-ordinal`; `pi-session` scrolls to `at` once the snapshot is in. Playwright runs against the fake hub with the hash embedder.

**Tech Stack:** Lit 3, `@thatsit/kit` icons (`SEARCH_ICON`, `X_ICON`, `SETTINGS_ICON`, `CODE_ICON`, `MESSAGE_CIRCLE_ICON`), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-session-search-design.md` · Runs after Plan 1 (needs `SearchHit`, `SearchResponse`, `GET /api/search`, `PI_WEB_SEARCH_EMBEDDER=hash`).

## Global Constraints

- Debounce 300 ms after the last keystroke; minimum 2 characters; a new query aborts the in-flight request; results for a stale query never render.
- Topic hits ignore the code/chat toggle; each hit shows its type icon (12 px) in the dot column.
- Hit row: title (`sessionTitle`), age (`relativeTime`), two-line clamped snippet with `terms` underlined in amber (`<mark>`: no background, `color: var(--text-primary)`, `font-weight: 600`, underline `var(--primary)` 2 px), footer `you|pi · <abbreviated cwd>` or `topic match` when `semanticOnly`. Up to 8 hits. Label "In conversations".
- Copy: "searching…", "No session titles match.", "Nothing in conversations.", "Search isn't available on this hub." (404), "Can't reach the hub." (network).
- Search open: the top row (brand, toggle, gear) is replaced by the field (full width, focused) + an X button (`aria-label="close search"`). Escape closes; X closes; closing clears the query and the hits. The header's search button has `aria-label="search sessions"`.
- Jump: `scrollIntoView({ block: "center" })` on the element with `data-ordinal=<n>` after the snapshot has loaded; add class `jump` (amber left border + wash fading over 3 s, no fade under `prefers-reduced-motion`); then `history.replaceState` to the plain session href. Missing ordinal → no scroll, no error.
- Old hub (404) and network errors degrade to the title filter with the one-line note; no toast, no console error.
- Kit tokens only; no new dependencies.
- Commits end with a blank line and `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. Typing fast then deleting back to one character must cancel the pending request and show no hits (Task 3 `store: a short query after a long one cancels and clears`).
2. Flipping the type toggle while search is open keeps the hits (they ignore the toggle) and refilters titles (Task 4 e2e `toggle while searching keeps hits`).
3. On a phone, tapping a hit closes the drawer and lands on the message (Task 6 e2e `phone: hit closes the drawer and scrolls`).
4. A hit into the session that is already open (same id) must still scroll (Task 5 `nextJump: at changes on the same session scroll again`; Task 6 e2e `a hit opens the session scrolled to the message` runs it twice from the open session).
5. The wash must not re-trigger on every re-render or stream event (Task 5 `nextJump: runs once per at`).

---

### Task 1: Route `at` and the API call

**Files:**
- Modify: `app/src/lib/route.ts`, `app/src/lib/api.ts`
- Test: `app/src/lib/route.test.ts`, `app/src/lib/api.test.ts` (exists? if not, create with a stubbed `fetch`)

**Interfaces:**
- Produces: `Route` session variant becomes `{ name: "session"; id: string; at?: number }`; `parse` accepts `s/<id>/at/<n>` (n a non-negative integer; anything else → plain session); `hrefFor` emits `/at/<n>` when `at` is a number. `HubApi.search(q: string, limit: number, signal?: AbortSignal): Promise<SearchResponse>` → `GET /api/search?q=<enc>&limit=<n>`.

- [ ] **Step 1: Failing tests** — `parseRoute("#/s/abc/at/3")` → `{ name: "session", id: "abc", at: 3 }`; `"#/s/abc/at/x"` → plain; `hrefFor({ name: "session", id: "a b", at: 2 })` → `"#/s/a%20b/at/2"`; `hrefFor` without `at` unchanged; `api.search("hub restart", 8)` fetches `/api/search?q=hub%20restart&limit=8` and passes the signal.
- [ ] **Step 2: Run to verify failure** (`cd app && npx vitest run src/lib/route.test.ts src/lib/api.test.ts`); **Step 3: Implement**; **Step 4: Run to verify pass**; **Step 5: Commit** `feat(app): session route with at, HubApi.search`

---

### Task 2: Ordinals on rendered messages

**Files:**
- Modify: `app/src/render/messages.ts` (`renderConversation` counts user/assistant messages in `conv.messages` order and passes the ordinal to `renderUser`/`renderAssistant`, which set `data-ordinal=${n}` on `.user` / `.assistant`; the streaming `partial` gets none)
- Test: `app/src/render/messages.test.ts` (exists; add)

- [ ] **Step 1: Failing test** — render a conversation `[user, assistant(toolCall only), toolResult, assistant, user]` → `.user`/`.assistant` elements carry `data-ordinal` 0,1,2,3 in DOM order; a `partial` has no attribute.
- [ ] **Step 2: Run to verify failure**; **Step 3: Implement**; **Step 4: Run to verify pass**; **Step 5: Commit** `feat(app): rendered messages carry their ordinal`

---

### Task 3: SearchStore and the hits renderer

**Files:**
- Create: `app/src/lib/search-store.ts`, `app/src/render/search-hits.ts`
- Test: `app/src/lib/search-store.test.ts`, `app/src/render/search-hits.test.ts`

**Interfaces:**
```ts
// search-store.ts
export type SearchState = { status: "idle" } | { status: "searching"; query: string } | { status: "done"; query: string; hits: SearchHit[]; semantic: boolean } | { status: "error"; query: string; message: string };
export interface SearchStoreOptions { api: Pick<HubApi, "search">; debounceMs?: number /* 300 */; minChars?: number /* 2 */; limit?: number /* 8 */; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout }
export class SearchStore extends EventTarget { // dispatches "change"
  constructor(opts: SearchStoreOptions);
  readonly state: SearchState;
  setQuery(q: string): void; // trims; < minChars → idle (cancels timer + aborts in-flight); else restarts the debounce
  clear(): void; // idle, aborts
}
export function errorMessage(e: unknown): string; // HubError 404 → "Search isn't available on this hub."; HubError 0 → "Can't reach the hub."; else "Search failed."

// search-hits.ts
export function highlight(text: string, terms: string[]): TemplateResult; // case-insensitive, non-overlapping <mark> around each term occurrence
export function searchHits(state: SearchState, home: string): TemplateResult | typeof nothing; // the "In conversations" label + rows (anchors to hrefFor({name:"session", id, at: ordinal})) or the status line; nothing when idle
export const searchHitsStyles: CSSResult; // .hits, .hit (grid like .row), .ty, .snip, mark, .foot, .status, .pulse
```

- [ ] **Step 1: Failing tests** — store: debounce fires once after 300 ms with fake timers; `store: a short query after a long one cancels and clears`; a second query aborts the first's signal and only the latest result lands (resolve the older promise later and assert it is ignored); 404 → the unsupported message; highlight marks `restart` in "We restarted it" once and escapes nothing (text nodes); searchHits renders the label, type icon per hit, footer "you · ~/x" vs "topic match", the four status lines.
- [ ] **Step 2: Run to verify failure**; **Step 3: Implement**; **Step 4: Run to verify pass** (`cd app && npx vitest run src/lib/search-store.test.ts src/render/search-hits.test.ts`); **Step 5: Commit** `feat(app): search store and hit rows`

---

### Task 4: Search mode in the sessions panel

**Files:**
- Modify: `app/src/components/pi-sidebar.ts` (state `searchOpen`; header renders either the top row with a new icon button `SEARCH_ICON` between the toggle and the gear, or the field row: `<label class="search open"><span class="sr-only">Search sessions</span><input type="search" …>` + `<button class="x" aria-label="close search">${X_ICON}</button>`; `@keydown` Escape on the input closes; opening focuses the input on `updated`; a `SearchStore` created from `api` (new property `api: Pick<HubApi,"search">`), `setQuery` on input; below the groups: `searchHits(store.state, list.home)`; closing calls `store.clear()` and resets `query`), `app/src/components/pi-app.ts` (pass `.api=${this.api}` to `pi-sidebar`)
- Test: none at unit level (app vitest runs in a node environment with no DOM; components are covered by Playwright in Task 6). The pure parts already have tests (Task 3).

- [ ] **Step 1: Implement** the header swap, focus-on-open, Escape/X close, store wiring and the hits section as specified above. Keep every string from Global Constraints verbatim.
- [ ] **Step 2: Verify by hand** with `npm run dev -w app` against the fake hub (`cd app && npx tsx e2e/hub-for-e2e.ts` or the Playwright webServer): open search, type, see hits, Escape. `npm run typecheck -w app` and `cd app && npx vitest run` stay green.
- [ ] **Step 3: Commit** `feat(app): search mode in the sessions panel with conversation hits`

---

### Task 5: Jump to the message

**Files:**
- Create: `app/src/lib/jump.ts` — the decision, kept pure so it can be unit-tested without a DOM:
  ```ts
  export interface JumpState { at: number | null; jumped: number | null; sessionId: string; jumpedSession: string | null; messages: number }
  export function nextJump(s: JumpState): number | null; // the ordinal to scroll to now, or null: null when at is null, when messages === 0, or when (at, sessionId) equals (jumped, jumpedSession)
  ```
- Modify: `app/src/components/pi-session.ts` (property `at: number | null`; in `updated`, `const n = nextJump({...})`; when not null: find `pi-messages` → `[data-ordinal="<n>"]`; if found `scrollIntoView({ block: "center" })`, add class `jump`, set `atBottom = false`; either way record `jumped = n, jumpedSession = sessionId` and `history.replaceState(null, "", hrefFor({ name: "session", id }))`), `app/src/render/messages.ts` (styles: `.jump { border-left: 2px solid var(--primary); background: linear-gradient(90deg, color-mix(in srgb, var(--primary) 18%, transparent), transparent 70%); animation: jump-fade 3s ease-out forwards }`, `@keyframes jump-fade { to { background: transparent } }`, `@media (prefers-reduced-motion: reduce) { .jump { animation: none; background: transparent } }`), `app/src/components/pi-app.ts` (pass `.at=${r.name === "session" ? r.at ?? null : null}`)
- Test: `app/src/lib/jump.test.ts`

- [ ] **Step 1: Failing tests** — `nextJump: null without at or before messages load`; `nextJump: runs once per at` (same at/session after it jumped → null); `nextJump: at changes on the same session scroll again`; `nextJump: the same at on another session scrolls`.
- [ ] **Step 2: Run to verify failure** (`cd app && npx vitest run src/lib/jump.test.ts`); **Step 3: Implement** `jump.ts` and the component wiring; **Step 4: Run to verify pass** plus `npm run typecheck -w app`; **Step 5: Commit** `feat(app): open a session at a message with a fading wash`

---

### Task 6: Playwright and look snapshots

**Files:**
- Create: `app/e2e/session-search.spec.ts`
- Modify: `app/e2e/hub-for-e2e.ts` (hub env `PI_WEB_SEARCH_EMBEDDER: "hash"`; seed two sessions in the seed dir with distinctive text: `e2e-search-a` (code, cwd WORKDIR) with a user message "how do we restart the hub after a deploy" and an assistant reply "systemctl --user restart pi-web-hub, then reload the terminal pis"; `e2e-search-b` (chat, listed in `session-types.json`) with "the Pebble battery drained overnight" / "poll less often; the WebSocket only wakes the watch on change"; wait for `/api/search?q=restart` to return a hit before the suite starts), `app/e2e/look.spec.ts` (new shot `search` for desktop and phone: open search, type "restart", wait for the hits label; add masks for ages)

- [ ] **Step 1: Write the tests**

```ts
test("search opens from the header and closes on Escape", ...);
test("typing shows title matches instantly and conversation hits after a pause", ...); // hits label visible; hit row has the snippet with <mark>restart</mark>
test("toggle while searching keeps hits", ...); // flip to chat: the title list changes, the hit list still has both sessions
test("a hit opens the session scrolled to the message", ...); // click → URL #/s/e2e-search-a (no /at/ after settle), the [data-ordinal="1"] element has class jump and is within the viewport
test("phone: hit closes the drawer and scrolls", ...);
test("an old hub degrades quietly", ...); // route /api/search → 404 → the note "Search isn't available on this hub." and no console errors
```

- [ ] **Step 2: Run** `cd app && npx playwright test e2e/session-search.spec.ts` twice — Expected: all pass both times.
- [ ] **Step 3: Look snapshots**: `npx playwright test e2e/look.spec.ts` → new `search-*` shots fail as missing; run with `--update-snapshots`, inspect the desktop light and phone dark images, re-run clean. Expected: 29 + new shots pass.
- [ ] **Step 4:** `npm run e2e -w app` full, `npm run typecheck -w app`, `cd app && npx vitest run` — Expected: green.
- [ ] **Step 5: Commit** `test(app): e2e for session search; look shots for the open search`
