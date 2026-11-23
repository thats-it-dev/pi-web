# Session Types, Plan 2 of 2: Kit Icons and the App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-web's sessions panel gets the code/chat toggle (amber sliding pill, Lucide icons) and the square-pen new-session button; the list, launch, new-chat page and composer follow the selected type; the header's "+ new" is gone.

**Architecture:** The selected type is a per-device setting (`pi-web:session-type`) owned by `pi-app` and passed down. `pi-sidebar` renders the toggle (a pure render function with its own styles), filters the list by `SessionSummary.type`, and hosts the new-session button. `pi-new-chat` derives the draft's defaults from the type and sends `type` to the hub. `launchRoute` filters by type. The chat menu gains `cwdHidden`. Three Lucide icons join the kit.

**Tech Stack:** Lit 3, `@thatsit/kit`, vitest (node) for pure logic and render functions, Playwright e2e against the fake hub.

**Spec:** `docs/superpowers/specs/2026-11-23-session-types-design.md` (sections "The sessions panel", "Launch", "App state and UI", "The folder in chat", "Superpowers default").

**Depends on:** plan 1 (`SessionType`, `SessionSummary.type`, `POST /api/sessions` `type`).

## Global Constraints

- Toggle: icon-only segmented pair, Lucide `code` left and `message-circle` right, kit `.seg` geometry, a pill in `var(--primary)` that slides with a ~220 ms `transform` transition (the kit's reduced-motion rule disables it); active icon `var(--bg)`, inactive `var(--text-muted)`; `role="radiogroup"` with two labelled `aria-pressed` buttons ("Code sessions", "Chat sessions").
- The selected type is stored under localStorage `pi-web:session-type` (`"code" | "chat"`), default code, read through `app/src/lib/settings.ts` with the same try/catch guards as the other keys.
- The list shows only sessions whose `type` equals the selected type; a summary with no `type` counts as code.
- The new-session button is a filled kit `.btn` with `SQUARE_PEN_ICON` and the label "new code session" or "new chat", bottom-left of the panel, 12px from the edges, above the safe-area inset; the `.groups` scroll area gets `padding-bottom` so the last row is never hidden under it.
- Removed: `newChatButton`/`newChatStyles` (`app/src/render/new-chat.ts`), its use in `pi-header` and `pi-settings`, the sidebar's "+ new" nav link and the empty state's "Start one" link.
- Chat drafts: cwd fixed to the home folder, folder row hidden (`cwdHidden`), superpowers default off; code drafts: as today, superpowers default on. The hand-off no longer sends `set_superpowers` (plan 1 makes the default hold in pi).
- Flipping the toggle never navigates away from the open session.
- Icons are added to `kit/src/icons.ts` from lucide-static 1.73.0; nothing is pasted into the app.
- No new dependencies.

## Review Focus

1. A session list where some summaries lack `type` (an old hub, or the cached `pi-web:sessions` list from before the upgrade): they must show under code, not vanish. Test in Task 2 (`filterByType`).
2. The toggle is flipped while a chat is open: the open session stays, the list changes, the button label changes, and the `cur` row may disappear without error. Test in Task 6 e2e.
3. The toggle is flipped while the new-chat draft is open with typed text: the text survives, cwd and superpowers reset to the new type's defaults. Test in Task 5 (pure draft defaults) and Task 6 e2e.
4. A fresh load with the toggle on chat and only code sessions on the hub must open a new chat, not a code session. Test in Task 2 (`launchRoute` with type).
5. Phone: the button must not cover the last row or sit under the home indicator. Test in Task 6 e2e (phone project: last row's bottom ≤ button's top).

---

### Task 1: Kit icons `code`, `message-circle`, `square-pen`

**Files:**
- Modify: `kit/src/icons.ts` (three exports + `ICONS` entries), `kit/README.md` icon list if it enumerates names
- Test: `kit/test/dist.test.ts` already checks the build; add to `kit/src/icons.test.ts` if it exists, else a tiny new vitest asserting the three names are in `ICONS` and render an `<svg`.

**Interfaces:**
- Produces: `CODE_ICON`, `MESSAGE_CIRCLE_ICON`, `SQUARE_PEN_ICON` (lit `TemplateResult`), `ICONS["code"|"message-circle"|"square-pen"]`. Paths (lucide-static 1.73.0): code `<path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" />`; message-circle `<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />`; square-pen `<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />`.

- [ ] **Step 1: Failing test** — `expect(Object.keys(ICONS)).toEqual(expect.arrayContaining(["code", "message-circle", "square-pen"]))` and each renders to a string containing `viewBox="0 0 24 24"` (render with lit's `render` into a container as other kit tests do, or `ICONS.code.strings.join("")` for the wrapper).
- [ ] **Step 2: Run** — `cd kit && npx vitest run src/icons.test.ts` → FAIL.
- [ ] **Step 3: Add the icons** in the existing `svg(svgTag\`…\`)` form (note: some existing entries wrap a whole `<svg>` inside; use the bare paths like `X_ICON` does).
- [ ] **Step 4: Run** — kit vitest, `npm run build -w kit`, `npm run test -w kit` → PASS (api.json gains three exports; additive).
- [ ] **Step 5: Commit** — `kit: code, message-circle and square-pen icons`

---

### Task 2: Pure logic: the setting, the filter, launch by type, the API field

**Files:**
- Modify: `app/src/lib/settings.ts` (+ test `settings.test.ts`)
- Modify: `app/src/lib/format.ts` (+ `format.test.ts`)
- Modify: `app/src/lib/launch.ts` (+ `launch.test.ts`)
- Modify: `app/src/lib/api.ts` (`createSession` gains `type?: SessionType`)

**Interfaces:**
- Produces:
  ```ts
  // settings.ts
  export function getSessionType(): SessionType; // "pi-web:session-type", default "code"
  export function setSessionType(t: SessionType): void;
  // format.ts
  export function filterByType(sessions: SessionSummary[], type: SessionType): SessionSummary[]; // (s.type ?? "code") === type
  export function newSessionLabel(type: SessionType): string; // "new code session" | "new chat"
  // launch.ts
  export function launchRoute(sessions: SessionSummary[], now: number, type: SessionType): Route; // considers filterByType(sessions, type) only
  // api.ts
  createSession(o: { cwd: string; model?; thinking?; type?: SessionType })  // type sent as-is
  ```

- [ ] **Step 1: Failing tests**

```ts
it("getSessionType defaults to code and round-trips chat", …); // localStorage stubbed as the other settings tests do
it("filterByType treats a missing type as code", () => { expect(filterByType([{...s, type: undefined as any}, {...s, id: "c", type: "chat"}], "code").map(x => x.id)).toEqual([s.id]); });
it("newSessionLabel", () => expect([newSessionLabel("code"), newSessionLabel("chat")]).toEqual(["new code session", "new chat"]));
it("launchRoute with type chat ignores a live code session and opens a new chat", …);
it("launchRoute with type code behaves as before on a mixed list", …);
```

- [ ] **Step 2: Run** — `cd app && npx vitest run src/lib` → FAIL.
- [ ] **Step 3: Implement**; update the existing `launchRoute` call site in `pi-app.ts:279` to pass `this.sessionType` (added in Task 4; pass `getSessionType()` for now).
- [ ] **Step 4: Run** — app vitest + `npm run typecheck -w app` → PASS.
- [ ] **Step 5: Commit** — `app: session type setting, list filter, launch by type`

---

### Task 3: The toggle render function and the sidebar

**Files:**
- Create: `app/src/render/session-type-toggle.ts` (+ `session-type-toggle.test.ts`)
- Modify: `app/src/components/pi-sidebar.ts`

**Interfaces:**
- Consumes: `CODE_ICON`, `MESSAGE_CIRCLE_ICON`, `SQUARE_PEN_ICON` (Task 1), `filterByType`, `newSessionLabel` (Task 2).
- Produces:
  ```ts
  // render/session-type-toggle.ts
  export function sessionTypeToggle(type: SessionType, onPick: (t: SessionType) => void): TemplateResult;
  // <span class="type-toggle ${type}" role="radiogroup" aria-label="Session type"><button aria-label="Code sessions" aria-pressed=…>${CODE_ICON}</button><button aria-label="Chat sessions" aria-pressed=…>${MESSAGE_CIRCLE_ICON}</button></span>
  export const sessionTypeToggleStyles: CSSResult; // .type-toggle: inline-grid, 2 × 32px columns, 28px high, 1px var(--border-color) border, var(--radius); ::before pill 32px wide, background var(--primary), transition transform 0.22s; .type-toggle.chat::before { transform: translateX(32px) }; buttons color var(--text-muted), [aria-pressed="true"] color var(--bg); svg 15px
  ```
  `pi-sidebar` gains property `type: SessionType` (attribute false), emits `pi-session-type { type }` (bubbles, composed) from the toggle, renders `sessionTypeToggle` in `.top` in place of the `<nav>` (the settings link moves to the right of the toggle as a small `.u` link), filters with `filterByType(list.sessions, this.type)` before `groupSessions`, removes "Start one" (the empty state reads "No code sessions yet." / "No chat sessions yet."), and renders `<button class="btn new-session" @click=${() => (location.hash = hrefFor({ name: "new" }))}>${SQUARE_PEN_ICON}<span>${newSessionLabel(this.type)}</span></button>` positioned `position: absolute; left: 12px; bottom: calc(12px + var(--safe-bottom))` with `:host { position: relative }` and `.groups { padding-bottom: calc(64px + var(--safe-bottom)) }`.

- [ ] **Step 1: Failing render tests** (render into a detached container the way `progress.test.ts` does): code → first button `aria-pressed="true"`, container class has `code`; chat → second pressed, class `chat`; clicking the chat button calls `onPick("chat")`; the `.type-toggle` has exactly two buttons and the svgs carry `viewBox`.
- [ ] **Step 2: Run** — `cd app && npx vitest run src/render/session-type-toggle.test.ts` → FAIL.
- [ ] **Step 3: Implement** the render function and styles; wire `pi-sidebar` (styles from `sessionTypeToggleStyles` added to its `static styles`).
- [ ] **Step 4: Run** — app vitest, `npm run typecheck -w app`, `npm run build -w app` → PASS.
- [ ] **Step 5: Commit** — `app: session type toggle and new-session button in the sessions panel`

---

### Task 4: `pi-app` owns the type; the header loses "+ new"

**Files:**
- Modify: `app/src/components/pi-app.ts` (state `sessionType`, handlers, props to sidebar and new-chat, `launchRoute`)
- Modify: `app/src/components/pi-header.ts:7,20,71`, `app/src/components/pi-settings.ts:8,25,197` (remove `newChatButton`)
- Delete: `app/src/render/new-chat.ts`
- Test: `app/src/components/pi-app.test.ts` only if one exists; otherwise covered by Task 6 e2e.

**Interfaces:**
- Consumes: `getSessionType`/`setSessionType`, `launchRoute(…, type)`, `pi-session-type` event.
- Produces: `pi-app` state `sessionType: SessionType` (init `getSessionType()`); on `pi-session-type` → `setSessionType(t)`, `this.sessionType = t`, no navigation; `<pi-sidebar .type=${this.sessionType}>`; `<pi-new-chat .type=${this.sessionType}>`; `launchRoute(list.sessions, Date.now(), this.sessionType)`. `pi-header`'s draft frame heading becomes a property: `heading` is already a property; `pi-new-chat` passes `"new chat"` or `"new code session"` (Task 5).

- [ ] **Step 1: Implement** (no new pure logic here; the tests are Task 6's e2e). Remove the `new-chat.ts` module and every import.
- [ ] **Step 2: Run** — `npm run typecheck -w app && npm run test -w app && npm run build -w app` → PASS; `grep -rn newChatButton app/src` → nothing.
- [ ] **Step 3: Commit** — `app: pi-app owns the session type; the header's + new button is gone`

---

### Task 5: New-chat defaults per type, `cwdHidden`, type sent to the hub, folder hidden in chat sessions

**Files:**
- Modify: `app/src/lib/draft.ts` (+ `draft.test.ts`)
- Modify: `app/src/render/chat-menu.ts` (+ `chat-menu.test.ts`)
- Modify: `app/src/components/pi-new-chat.ts`, `pi-session.ts` (`sendHandoff`, the menu's `cwdHidden`, composer folder), `pi-composer.ts` (folder chip hidden when `folder` is null — check whether it already is)

**Interfaces:**
- Consumes: `SessionType`, `newSessionLabel`, `SessionSummary.type` (through `ListStore`: `list.sessions.find(s => s.id === id)?.type ?? "code"`).
- Produces:
  ```ts
  // draft.ts
  export function freshDraft(type: SessionType): Draft; // cwd "~", superpowers: type === "code"
  export function retypeDraft(type: SessionType): void; // keeps text/images/files/model/thinking/approval; resets cwd to "~" and superpowers to the type's default
  export function getDraft(): Draft; export function resetDraft(type: SessionType): void; // existing signatures take the type
  export interface Handoff { text; images; files; approval } // superpowers removed
  // chat-menu.ts
  export interface ChatMenuView { …; cwdHidden: boolean } // true → no folder row at all
  ```
  `pi-new-chat`: property `type: SessionType`; `willUpdate` on a `type` change calls `retypeDraft(type)`; the ＋ menu gets `cwdFixed: false, cwdHidden: type === "chat"`; `start()` sends `type` and a chat's `cwd` as `"~"`; `<pi-header .draft heading=${newSessionLabel(type)}>`; the composer's `.folder` is `null` for chat. `pi-session`: looks the session's type up from the list; `cwdHidden: type === "chat"` in its menu; composer `.folder` null for chat; `sendHandoff` no longer sends `set_superpowers`.

- [ ] **Step 1: Failing tests**

```ts
// draft.test.ts
it("freshDraft: code has superpowers on, chat off, both in ~", …);
it("retypeDraft keeps the text and attachments, resets cwd and superpowers", …);
// chat-menu.test.ts
it("cwdHidden leaves the folder row out entirely", () => { expect(menuRows({...view, cwdHidden: true}).map(r => r.key)).not.toContain("folder"); });
it("cwdFixed without cwdHidden still shows the disabled folder row", …);
```

- [ ] **Step 2: Run** — `cd app && npx vitest run src/lib/draft.test.ts src/render/chat-menu.test.ts` → FAIL.
- [ ] **Step 3: Implement** all of the above.
- [ ] **Step 4: Run** — app vitest, `npm run typecheck -w app`, `npm run build -w app` → PASS.
- [ ] **Step 5: Commit** — `app: new chats follow the session type (home folder, hidden folder row, superpowers default); type sent to the hub`

---

### Task 6: e2e and snapshots

**Files:**
- Modify: `app/e2e/hub-for-e2e.ts` (seed `session-types.json` in the fake hub's data dir marking one seeded session `e2e-chat` as chat; add that session file)
- Create: `app/e2e/session-types.spec.ts`
- Modify: `app/e2e/smoke.spec.ts` (the "New chat" header button test → the sidebar button), `app/e2e/look.spec.ts-snapshots/*` re-pinned for new-chat, chat-menu, drawer, settings, session-sheet

**Interfaces:**
- Consumes: everything above; hub plan 1 (the fake hub is the real hub server, so the store file is `<dataDir>/session-types.json`).

- [ ] **Step 1: Write the e2e**

```ts
test("the toggle filters the list and the button label follows", …); // desktop: default code → seeded code sessions visible, chat one absent, button "new code session"; click "Chat sessions" → chat session visible, code ones absent, button "new chat"; the open session stays (URL unchanged)
test("a new chat lands in home with no folder row", …); // toggle chat → click "new chat" → heading "new chat" → open ＋ menu: no "folder" row → send "hi" → session's ＋ menu has no folder row; GET /api/sessions shows type chat
test("a new code session starts with superpowers on", …); // toggle code → "new code session" → ＋ menu superpowers "on"
test("the setting survives a reload", …); // chat → reload → chat still selected
test("flipping the toggle keeps the typed draft", …); // type text on the new-chat page, flip → text still there, heading changed
test("phone: the button never covers the last row", …); // phone project: open the drawer; last .row bottom ≤ .new-session top
```

- [ ] **Step 2: Run** — `cd app && npx playwright test e2e/session-types.spec.ts` → iterate to green; then `npm run e2e -w app`, update snapshots with `--update-snapshots` for the five look.spec screens only after confirming the diffs are the intended ones (no "+ new" in headers, toggle and button in the drawer).
- [ ] **Step 3: Commit** — `app: e2e for session types; look snapshots re-pinned`

---

## Self-review notes

- Spec coverage: toggle (T3), per-device memory (T2/T4), filter with old-sessions-as-code (T2), open session stays (T4 handler, T6), button bottom-left with label (T3), header/nav/empty-state removals (T3/T4), launch by type (T2/T4), chat draft defaults + hidden folder + type to hub (T5), folder hidden in live chat sessions (T5), hand-off no longer sends superpowers (T5), icons in the kit (T1), e2e + snapshots (T6).
- Names shared with plan 1: `SessionType`, `SessionSummary.type`, `createSession({type})`.
