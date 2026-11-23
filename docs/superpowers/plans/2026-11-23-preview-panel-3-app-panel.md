# Preview Panel, Plan 3 of 4: The App's Preview Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-web shows the preview pi opened: a Preview tab beside Progress in the aside with header strip, iframe and status line on desktop; docked side by side on iPad; full-screen on tablets in portrait; a card with an Open button on phones; PR preview links open in the same tab.

**Architecture:** `shared/src/preview.ts` derives `PreviewState` from the conversation (the `preview` tool's results), like `progress.ts`. `pi-session` announces it (`pi-preview` event) the way it announces progress; `pi-app` owns the aside state (tab, pages override, shell size) and mounts a new `pi-aside` (tab bar + `pi-progress-panel` + `pi-preview-panel`) in the shell's `aside` slot, driving the plan-1 shell attributes. `render/messages.ts` renders a finished `preview` call as a card. The CSP gains `frame-src`.

**Tech Stack:** Lit 3, `@thatsit/kit` (plan 1 shell), vitest (node) for pure logic, Playwright e2e against the fake hub.

**Spec:** `docs/superpowers/specs/2026-11-23-preview-panel-design.md` (sections "The panel (desktop)", "iPad", "iPad portrait and other tablets", "Phone", "UI state", "Progress tab links", "Testing").

**Depends on:** plan 1 (kit shell attributes) and plan 2 (`PreviewDetails` result shape: `{ url, label, kind: "dev" | "static", port, root }`, stop → `{ stopped: true }`).

## Global Constraints

- Width rules: `< 600` phone (card, no iframe), `600–899` tablet (full-screen Preview tab), `≥ 900` panel. No user-agent sniffing anywhere.
- Viewport presets are exactly `fit`, `390`, `768`.
- CSP: add only `frame-src https://*.ts.net:* https://*.pages.dev https://*.thatsit.app`; nothing else widens.
- Pop-out and the phone Open button are real anchors with `target="_blank" rel="noopener"`.
- Health poll: a `fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" })` every 15 s while the Preview tab is visible and the kind is not `pages`; a rejection means stopped.
- Drag handle only with a fine pointer (`matchMedia("(pointer: fine)")`); snap button always.
- No new dependencies.

## Review Focus

1. A session with an old `preview` result followed by `preview({ stop: true })`: the panel must show nothing (derive returns null), not the stale URL. Test in Task 1.
2. A `preview` result with `isError` (health timeout): never becomes the state. Test in Task 1.
3. Reopening a session from history: the state restores from messages alone (no `conv.tools` entries). Test in Task 1 and the e2e fixture in Task 7.
4. A Pages link opened, then pi opens a newer dev preview: the dev preview wins (override cleared). Test in Task 4 (pure `shownPreview`).
5. Phone: tapping the card must not try to show the aside or an iframe; the anchor's default navigation happens. Test in Task 7 (phone project).

---

### Task 1: `shared/src/preview.ts`

**Files:**
- Create: `shared/src/preview.ts`
- Test: `shared/test/preview.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PreviewKind = "dev" | "static" | "pages";
  export interface PreviewState { url: string; label: string; kind: PreviewKind; at: number } // at: the result's timestamp, else 0
  /** The latest successful `preview` result with a url; null after a later `{stopped:true}` result or when there is none.
   *  Reads finished tool results in conv.messages (toolResult with toolName "preview") and live ones in conv.tools. */
  export function derivePreview(conv: Conversation): PreviewState | null;
  export const PREVIEW_TOOL = "preview";
  ```

- [ ] **Step 1: Write the failing tests** (`node:test`, helpers like `shared/test/progress.test.ts`)

```ts
test("the latest successful preview result is the state", () => { /* two preview results; expect the second's url/label/kind and at = its timestamp */ });
test("a stop result clears it", () => { /* preview then {stopped:true} → null */ });
test("an error result is ignored", () => { /* isError true with details {error} → null; earlier good one still wins */ });
test("a live tool run with a result counts before its toolResult message lands", () => { /* conv.tools[id] = {name:"preview", running:false, result:{details:{url...}}} → state with at 0 */ });
test("nothing → null", () => { assert.equal(derivePreview(createConversation([user()])), null); });
```

- [ ] **Step 2: Run to verify failure** — `cd shared && node --test test/preview.test.ts` → FAIL.
- [ ] **Step 3: Implement** `derivePreview` (walk messages in order; a toolResult's `details.url` string sets, `details.stopped === true` clears; then apply `conv.tools` entries not yet in `results`, in insertion order).
- [ ] **Step 4: Run to verify pass**, plus `npm run typecheck -w shared`.
- [ ] **Step 5: Commit** — `git commit -m "shared: derivePreview from preview tool results"`

---

### Task 2: CSP `frame-src`

**Files:**
- Modify: `app/src/lib/csp.ts`
- Test: `app/src/lib/csp.test.ts`

- [ ] **Step 1: Add the failing assertion** to the existing CSP test: `expect(CSP).toContain("frame-src https://*.ts.net:* https://*.pages.dev https://*.thatsit.app")` and keep whatever asserts `default-src 'self'` is still first.
- [ ] **Step 2: Run** — `cd app && npx vitest run src/lib/csp.test.ts` → FAIL.
- [ ] **Step 3: Add the directive** after `connect-src` in `csp.ts`, with a one-line comment: previews are tailnet dev servers, Pages previews and thatsit.app sites.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "app: CSP frame-src for tailnet, Pages and thatsit.app previews"`

---

### Task 3: Pure UI logic: mode, sizes, stage scaling

**Files:**
- Create: `app/src/lib/preview-ui.ts`
- Test: `app/src/lib/preview-ui.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PreviewMode = "card" | "fullscreen" | "panel";
  export const PHONE_MAX_W = 599;   // < 600 is a phone
  export const TABLET_MAX_W = 899;  // 600–899 is a tablet
  export function previewMode(width: number): PreviewMode;
  export type Viewport = "fit" | "390" | "768";
  export const VIEWPORTS: Viewport[] = ["fit", "390", "768"];
  /** iframe css width/height and the scale that fits `preset` into a stage of stageW×stageH. fit → stage size, scale 1. */
  export function stageFor(preset: Viewport, stageW: number, stageH: number): { width: number; height: number; scale: number };
  export type AsideSize = "default" | "half" | "full"; // mirrors the kit's
  export function nextSize(size: AsideSize): AsideSize; // default → half → full → default
  export function readTab(raw: string | null): "progress" | "preview"; // anything else → "progress"
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("previewMode splits at 600 and 900", () => expect([previewMode(440), previewMode(599), previewMode(600), previewMode(834), previewMode(899), previewMode(900)]).toEqual(["card", "card", "fullscreen", "fullscreen", "fullscreen", "panel"]));
it("stageFor scales a wide preset down and never up", () => {
	expect(stageFor("fit", 500, 800)).toEqual({ width: 500, height: 800, scale: 1 });
	expect(stageFor("390", 500, 800)).toEqual({ width: 390, height: 800, scale: 1 });
	expect(stageFor("768", 500, 800)).toEqual({ width: 768, height: Math.round(800 / (500 / 768)), scale: 500 / 768 });
});
it("nextSize cycles", () => expect(["default", "half", "full"].map(nextSize)).toEqual(["half", "full", "default"]));
it("readTab", () => expect([readTab("preview"), readTab("progress"), readTab(null), readTab("x")]).toEqual(["preview", "progress", "progress", "progress"]));
```

- [ ] **Step 2–5:** run (FAIL), implement, run (PASS), commit `app: pure preview UI helpers (mode, viewport stage, size cycle)`.

---

### Task 4: `pi-app` aside state (pure) and the `pi-aside` + `pi-preview-panel` components

**Files:**
- Create: `app/src/lib/aside-state.ts` (pure) and `app/src/lib/aside-state.test.ts`
- Create: `app/src/components/pi-preview-panel.ts`
- Create: `app/src/components/pi-aside.ts`
- Modify: `app/src/components/pi-app.ts`
- Modify: `app/src/components/pi-session.ts` (announce `pi-preview`)

**Interfaces:**
- Consumes: Task 1 `PreviewState`, Task 3 helpers, plan 1 shell attributes (`resizable`, `aside-size`, `dock-aside`, `aside-fullscreen`, `resetAsideWidth()`).
- Produces:
  ```ts
  // aside-state.ts
  export interface AsideInput { derived: PreviewState | null; pages: PreviewState | null; tab: "progress" | "preview"; hasProgress: boolean; width: number; lastSeenAt: number }
  /** The preview to show: a Pages link opened after the latest derived preview wins; otherwise the derived one. */
  export function shownPreview(i: Pick<AsideInput, "derived" | "pages">): PreviewState | null;
  /** The tab to show: switches to "preview" when a derived preview newer than lastSeenAt arrives; "progress" when there is no preview. */
  export function nextTab(i: AsideInput): "progress" | "preview";
  /** The shell attributes for this state. */
  export function shellAttrs(i: { tab: "progress" | "preview"; preview: PreviewState | null; mode: PreviewMode; finePointer: boolean; size: AsideSize }): { resizable: boolean; dockAside: boolean; asideFullscreen: boolean; asideSize: AsideSize };
  // dockAside = tab preview && preview && mode panel; asideFullscreen = tab preview && preview && mode fullscreen; resizable = finePointer && mode panel; asideSize = tab preview ? size : "default"
  ```
  Events (bubbling, composed):
  - `pi-session` → `pi-preview { preview: PreviewState | null }` whenever `derivePreview(store.conv)` changes (compare url+at+kind).
  - `pi-aside` → `pi-aside-tab { tab }`.
  - `pi-preview-panel` → `pi-preview-snap` (cycle size), `pi-preview-back` (fullscreen "Back to chat" → shell.hide("aside")), `pi-preview-close` (clear a Pages override / go to Progress tab). Pop-out is a plain anchor, no event.
  - Anywhere → `pi-open-preview { url, label, kind }` (Task 5 card, Task 6 Progress links) → pi-app sets `pages` override when kind is `pages`, switches tab to preview, shows the aside.
  `pi-preview-panel` properties: `preview: PreviewState | null`, `mode: PreviewMode`, `size: AsideSize`, `viewport: Viewport` (state), `alive: boolean | null` (state), `reloadKey` (state). Renders:
  - panel/fullscreen: `.hdr` (label + url in `<code>`, `.seg` of viewport buttons hidden in fullscreen, reload `.icon-btn` aria-label "Reload preview", snap `.icon-btn` aria-label "Resize preview" hidden in fullscreen, pop-out `<a class="icon-btn" href target="_blank" rel="noopener" aria-label="Open in a new tab">`; in fullscreen a leading `<button class="btn ghost">Back to chat</button>`), `.stage` with `<iframe title="Preview of ${label}" src=${url} referrerpolicy="no-referrer">` sized by `stageFor` (ResizeObserver on `.stage`), `.status` with `<span class="dot ${alive ? "ok" : alive === false ? "off" : ""}">` + `label · dev server|static|Pages preview · up Xm` (or `stopped · pi can start it again`).
  - card mode: the same card as Task 5 (`renderPreviewCard`) plus the status line, no iframe.
- [ ] **Step 1: Write the failing pure tests** for `shownPreview`, `nextTab`, `shellAttrs` covering: pages newer than derived wins, derived newer than pages wins, no preview → progress tab, new derived preview flips tab to preview once (lastSeenAt), fullscreen attrs in 600–899, resizable only with finePointer in panel mode, asideSize default when on the Progress tab.
- [ ] **Step 2: Run** — `cd app && npx vitest run src/lib/aside-state.test.ts` → FAIL.
- [ ] **Step 3: Implement `aside-state.ts`**, run → PASS, commit `app: aside state logic (shown preview, tab switching, shell attrs)`.
- [ ] **Step 4: Implement `pi-preview-panel.ts`** per the properties above. Health poll with `setInterval` 15 000 ms started in `connectedCallback`/when `preview` changes and `kind !== "pages"`, stopped on disconnect and when `document.visibilityState === "hidden"`. Uptime from `preview.at`. Styles: `:host{display:block;height:100%}`, `.hdr{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line)}`, `.hdr code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:0.72rem;color:var(--text-secondary)}`, `.stage{position:relative;flex:1;min-height:0;background:var(--panel);overflow:hidden;display:grid;place-items:start center}`, `iframe{border:0;background:#fff;transform-origin:top center}`, `.status{display:flex;gap:8px;align-items:center;padding:6px 12px;border-top:1px solid var(--line);font-size:0.72rem;color:var(--text-secondary)}`. Only kit tokens and classes.
- [ ] **Step 5: Implement `pi-aside.ts`**: properties `progress: ProgressStore | null`, `preview: PreviewState | null`, `tab`, `mode`, `size`, `selectedKey`; renders a `.tabs` row (`<button class="u ${on}">Progress</button>` and `Preview`, each present only when it has content; the row is hidden when only one has content) above the active panel; in fullscreen mode no tab row (the panel's bar has Back). Forwards `pi-open-child`, `pi-open-plan`.
- [ ] **Step 6: Wire `pi-app.ts`**: state `preview` (from `pi-preview`), `pages`, `tab` (init `readTab(localStorage["pi-web:aside-tab"])`, written on change), `size: AsideSize` (init "default"), `mode` (from `matchMedia` on 599/899, updated on change), `finePointer`, `lastSeenAt`. Render `<tk-shell ... ?resizable ?dock-aside ?aside-fullscreen aside-size=...>` from `shellAttrs`, `<pi-aside slot="aside" ...>` when `progress || shown`. Handlers: `pi-open-preview` (set pages when kind pages, tab preview, `shell.show("aside")`), `pi-preview-snap` (`size = nextSize(size)`; `"default"` also calls `shell.resetAsideWidth()`), `pi-preview-back` (`shell.hide("aside")`), `pi-preview-close` (pages = null; tab = progress), `pi-aside-tab`. CSS for `full`: `tk-shell[aside-full] pi-session { display: none }` (the shell reflects the boolean `aside-full` only while the 48px strip layout is in effect; `aside-size` is the requested size and may say `full` while the aside is hidden or a drawer) and a 48px `.strip` rendered in main with one `.icon-btn` aria-label "Back to chat" that sets `size = "half"`. On phone (`mode === "card"`) the header's aside button opens the drawer whose Preview tab shows the card.
- [ ] **Step 7: `pi-session.ts`**: on store change compute `derivePreview(store.conv)`; if changed dispatch `pi-preview`. Pass `previewLive` to `pi-header` (Task 6).
- [ ] **Step 8: Typecheck and unit tests** — `npm run typecheck -w app && npm run test -w app` → PASS.
- [ ] **Step 9: Commit** — `git commit -m "app: Preview tab in the aside (panel, fullscreen, card), wired to the shell sizes"`

---

### Task 5: The card in the reply

**Files:**
- Modify: `app/src/render/messages.ts` (`renderTool`: `call.name === "preview" && done && !isError && details.url` → `renderPreviewCard`)
- Test: `app/src/render/messages.test.ts`

**Interfaces:**
- Produces: `export function renderPreviewCard(d: { url: string; label: string; kind: "dev" | "static" | "pages" }, onOpen?: (d) => boolean): TemplateResult` rendering
  `<div class="preview-card"><a class="btn" href=${url} target="_blank" rel="noopener" @click=${...}>Open preview</a><span class="txt">${label} · <code>${host}</code></span></div>` where the click handler calls `onOpen` and, when it returns true, `preventDefault()`; `messages.ts` passes an `onOpen` that dispatches `pi-open-preview` from the clicked element and returns `previewMode(window.innerWidth) !== "card"`.
- [ ] **Step 1: Failing test**: render a conversation with a finished `preview` toolResult (details `{url:"https://spark-713a.tail9274fa.ts.net:10600", label:"fret", kind:"dev", port:10600, root:"/x"}`) through `renderConversation` into a `render`-to-string helper the file already uses (or `lit`'s `render` into a detached element under a jsdom-free approach the existing tests use); assert the output contains `Open preview`, the href, and `fret`; an `isError` result renders the ordinary `<details class="tool error">`; a `{stopped:true}` result renders the ordinary collapsed tool card.
- [ ] **Step 2–5:** run (FAIL), implement + styles (`.preview-card{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius);margin:6px 0}`), run (PASS), commit `app: preview tool result renders as a card with an Open button`.

---

### Task 6: Progress links open in the panel; header dot

**Files:**
- Modify: `app/src/render/progress.ts` (`ProgressOpts.openPreview: (url: string, label: string) => void`; `prSection` preview links call it on click with `preventDefault` when `previewMode(innerWidth) !== "card"`)
- Modify: `app/src/components/pi-progress-panel.ts` (emit `pi-open-preview { url, label, kind: "pages" }`)
- Modify: `app/src/components/pi-header.ts` (`previewLive: boolean` → `aside-badge="•"` when true; aria-label becomes "Progress, preview open")
- Modify: `app/src/components/pi-child-thread.ts:137` (same label handling, no badge)
- Test: `app/src/render/progress.test.ts`

- [ ] **Step 1: Failing test** in `progress.test.ts`: with a PR whose `ci` is `passed` and `preview` set, the rendered preview link calls `opts.openPreview(url, "preview")` on click when given a fake `innerWidth` ≥ 900 (inject via an `opts.mode` field: `ProgressOpts.mode: PreviewMode`, default from `previewMode(innerWidth)` in the panel); and navigates normally (no call) when `mode` is `card`.
- [ ] **Step 2–5:** run (FAIL), implement, run (PASS), commit `app: PR preview links open in the Preview tab; header dot while a preview is live`.

---

### Task 7: e2e

**Files:**
- Modify: `app/e2e/hub-for-e2e.ts` (seed a session `preview.jsonl` under `--pi-web-e2e-progress--` with: a user message, an assistant `preview` toolCall `{cwd:"/x"}`, a toolResult with details `{ url: "http://localhost:5173/", label: "fret", kind: "dev", port: 10600, root: "/x" }` and content text `Preview open at http://localhost:5173/ ...`; a second seeded session `preview-stopped.jsonl` that adds a `{stopped:true}` result)
- Create: `app/e2e/preview.spec.ts`

- [ ] **Step 1: Write the failing e2e**

```ts
test.describe("desktop", () => {
	test.skip(({ isMobile }) => isMobile);
	test("the Preview tab shows the iframe, viewport presets and status; stop hides it", async ({ page }) => {
		await page.goto("/#/s/<preview session id>");
		const aside = page.locator('tk-shell aside[aria-label="Progress"]');
		await expect(aside.locator("pi-preview-panel iframe")).toHaveAttribute("src", "http://localhost:5173/");
		await expect(aside.getByRole("button", { name: "390" })).toBeVisible();
		await aside.getByRole("button", { name: "390" }).click();
		await expect.poll(async () => Math.round((await aside.locator("iframe").boundingBox())!.width)).toBe(390);
		await expect(aside.locator(".status")).toContainText("fret");
		await expect(page.locator("pi-header .badge")).toHaveText("•");
		await page.goto("/#/s/<stopped session id>");
		await expect(page.locator("pi-preview-panel")).toHaveCount(0);
	});
	test("the card in the reply focuses the tab; pop-out is a new-tab link", async ({ page }) => {
		await page.goto("/#/s/<preview session id>");
		await page.locator("tk-shell").evaluate((s: any) => s.hide("aside"));
		await page.getByRole("link", { name: "Open preview" }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		await expect(page.locator('pi-preview-panel a[aria-label="Open in a new tab"]')).toHaveAttribute("target", "_blank");
	});
	test("snap cycles half and full; full leaves a 48px strip", async ({ page }) => { /* click "Resize preview" twice; aside width = (vw-280)/2 then vw-280-48; strip button "Back to chat" visible; click → half */ });
});
test.describe("phone", () => {
	test.skip(({ isMobile }) => !isMobile);
	test("the reply has an Open button and no iframe anywhere", async ({ page, context }) => {
		await page.goto("/#/s/<preview session id>");
		const open = page.getByRole("link", { name: "Open preview" });
		await expect(open).toHaveAttribute("target", "_blank");
		await expect(page.locator("iframe")).toHaveCount(0);
		const [popup] = await Promise.all([context.waitForEvent("page"), open.click()]);
		expect(popup.url()).toBe("http://localhost:5173/");
	});
});
test.describe("tablet", () => {
	test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });
	test("the Preview tab is full screen with Back to chat", async ({ page }) => {
		await page.goto("/#/s/<preview session id>");
		await page.getByRole("button", { name: /Progress/ }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeVisible();
		await expect.poll(async () => Math.round((await page.locator('tk-shell aside[aria-label="Progress"]').boundingBox())!.width)).toBe(820);
		await page.getByRole("button", { name: "Back to chat" }).click();
		await expect(page.locator("pi-preview-panel iframe")).toBeHidden();
	});
});
```

The seeded session ids are what the fixture files' `session` lines carry (`e2e-preview`, `e2e-preview-stopped`); the hub lists them by id.

- [ ] **Step 2: Run** — `cd app && npx playwright test e2e/preview.spec.ts` → FAIL.
- [ ] **Step 3: Fix what fails**, then run the whole app e2e: `npm run e2e -w app` → PASS (look.spec snapshots unchanged: the aside is absent in those sessions).
- [ ] **Step 4: Commit** — `git commit -m "app: e2e for the Preview tab on desktop, tablet and phone"`

---

## Self-review notes

- Spec coverage: tabs (T4), header strip with fit/390/768, reload, snap, pop-out (T4), status line + health poll (T4), drag only with a fine pointer (T4 `shellAttrs`), snap cycle + 48px strip + Back to chat (T4/T7), iPad docking (`dockAside`, T4), tablet fullscreen with Back (T4/T7), phone card → in-app browser via a real anchor (T5/T7), header dot (T6), card on desktop focuses the tab (T5/T7), Pages links in the panel (T6), state derived from the conversation and restored on reopen (T1/T7), CSP (T2), same URL announced again reloads (T4: `reloadKey` bumps when `at` changes with equal url).
- Type names shared with plans 1 and 2: `AsideSize` values match the kit's; `PreviewDetails` fields `url/label/kind/port/root` and `{stopped:true}` match plan 2 Task 4.
