# Preview Panel, Plan 1 of 4: Kit Shell Widths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tk-shell` gains a resizable, snappable aside (drag handle, narrow/half/full sizes), forced docking in mid mode, and a full-screen drawer mode, so pi-web's Preview tab can use them in plan 3.

**Architecture:** All width arithmetic lives in pure functions in `kit/src/panels.ts` (vitest, node env). `tk-shell.ts` reads four new attributes (`resizable`, `aside-size`, `dock-aside`, `aside-fullscreen`), computes the aside width through those functions, writes it to the `--aside-w` custom property on its own `.layout`, persists a dragged width under `<store-key>:aside-w`, and reflects the state for the app's CSS. Kit e2e (`kit/e2e/panels.spec.ts`, against the built demo) pins the DOM behaviour.

**Tech Stack:** Lit 3, TypeScript, vitest (pure), Playwright (kit e2e against `dist/`).

**Spec:** `docs/superpowers/specs/2026-11-23-preview-panel-design.md` (sections "The panel (desktop)", "iPad", "iPad portrait and other tablets", "Kit shell changes", "The chat floor wins").

## Global Constraints

- Breakpoints stay `PHONE_MAX = 899`, `WIDE_MIN = 1200`; the kit's public API is additive only (`kit/scripts/check-api.ts` fails a deploy that removes an export or attribute).
- Default aside width stays 300px; `--sidebar-w` stays 280px; drawers stay `min(85vw, 360px)` unless `aside-fullscreen` is set.
- Chat floor is 360px: the main column is never narrower except in `full` size, where it is the 48px strip.
- No new dependencies. Kit builds to `kit.js` importing only `./lit.js` (`kit/test/dist.test.ts`).
- Kit README documents every new attribute (the README is the kit's spec for app sessions).

## Review Focus

1. Window shrinks while a dragged width is stored (e.g. 1600 → 1100 with `--aside-w` 900): the aside must clamp live so the chat floor holds, not overflow. Test in Task 1 (`clampAsideWidth`) and Task 3 (e2e resize).
2. `dock-aside` at 900px with nav present: 280 + 300 + 360 > 900, so the nav must un-dock (become a drawer), not the chat shrink. Test in Task 1 (`navFits`, `isDocked`).
3. Stored width junk (`"abc"`, `-5`, `1e9`): falls back to 300 and clamps. Test in Task 1 (`readAsideWidth`).
4. `aside-size="full"` then the shell loses `dock-aside` or the window drops to phone: size must not leak into the drawer width. Test in Task 2 (asideSize ignored when undocked) via e2e in Task 3.
5. Double-click on the handle after a drag resets to 300 and clears the stored width. Test in Task 3.

---

### Task 1: Pure width helpers in `panels.ts`

**Files:**
- Modify: `kit/src/panels.ts`
- Test: `kit/src/panels.test.ts`

**Interfaces:**
- Produces (exported from `panels.ts` and re-exported from `kit/src/index.ts` as types/consts):
  ```ts
  export type AsideSize = "default" | "half" | "full";
  export const SIDEBAR_W = 280;
  export const ASIDE_DEFAULT_W = 300;
  export const ASIDE_MIN_W = 240;
  export const CHAT_FLOOR = 360;
  export const MAIN_STRIP = 48;
  /** Whether a docked nav still leaves the chat its floor beside an aside this wide. */
  export function navFits(o: { total: number; asideW: number }): boolean; // total - asideW - CHAT_FLOOR >= SIDEBAR_W
  /** isDocked gains an options arg: dockAside forces the aside to dock in mid mode; with total+asideW the nav un-docks when it no longer fits. */
  export function isDocked(panel: Panel, mode: Mode, present: Record<Panel, boolean>, opts?: { dockAside?: boolean; total?: number; asideW?: number }): boolean;
  /** The aside column width in px for a size, clamped so the main column keeps CHAT_FLOOR (or MAIN_STRIP in full). */
  export function asideWidthFor(size: AsideSize, o: { total: number; navDocked: boolean; stored: number | null }): number;
  /** A dragged width clamped to [ASIDE_MIN_W, total - (navDocked ? SIDEBAR_W : 0) - CHAT_FLOOR]. */
  export function clampAsideWidth(px: number, o: { total: number; navDocked: boolean }): number;
  export function readAsideWidth(raw: string | null): number | null; // finite integer in [ASIDE_MIN_W, 10000] else null
  export function writeAsideWidth(px: number): string;
  /** panelsState gains the same opts as isDocked. */
  export function panelsState(o: { mode: Mode; present: Record<Panel, boolean>; hidden: Hidden; drawer: Panel | null; dockAside?: boolean; total?: number; asideW?: number }): PanelsState;
  ```
  Semantics pinned by the tests below: `half` = `(total - navW) / 2` rounded, `full` = `total - navW - MAIN_STRIP`, `default` = `stored ?? ASIDE_DEFAULT_W`, all then clamped (`full` is clamped only to `>= ASIDE_MIN_W`). `navW` is `SIDEBAR_W` when `navDocked`, else 0.

- [ ] **Step 1: Write the failing tests**

Append to `kit/src/panels.test.ts`:

```ts
import { ASIDE_DEFAULT_W, ASIDE_MIN_W, CHAT_FLOOR, MAIN_STRIP, SIDEBAR_W, asideWidthFor, clampAsideWidth, navFits, readAsideWidth, writeAsideWidth } from "./panels.ts";

describe("aside widths", () => {
	it("constants", () => {
		expect([SIDEBAR_W, ASIDE_DEFAULT_W, ASIDE_MIN_W, CHAT_FLOOR, MAIN_STRIP]).toEqual([280, 300, 240, 360, 48]);
	});
	it("clampAsideWidth keeps the chat floor beside a docked nav", () => {
		expect(clampAsideWidth(900, { total: 1100, navDocked: true })).toBe(1100 - 280 - 360);
		expect(clampAsideWidth(900, { total: 1100, navDocked: false })).toBe(1100 - 360);
		expect(clampAsideWidth(100, { total: 1600, navDocked: true })).toBe(ASIDE_MIN_W);
		expect(clampAsideWidth(420, { total: 1600, navDocked: true })).toBe(420);
	});
	it("asideWidthFor: default is the stored width or 300, half splits the space, full leaves the strip", () => {
		expect(asideWidthFor("default", { total: 1600, navDocked: true, stored: null })).toBe(300);
		expect(asideWidthFor("default", { total: 1600, navDocked: true, stored: 500 })).toBe(500);
		expect(asideWidthFor("default", { total: 1000, navDocked: true, stored: 900 })).toBe(1000 - 280 - 360);
		expect(asideWidthFor("half", { total: 1600, navDocked: true, stored: null })).toBe(660);
		expect(asideWidthFor("half", { total: 1600, navDocked: false, stored: null })).toBe(800);
		expect(asideWidthFor("full", { total: 1600, navDocked: true, stored: null })).toBe(1600 - 280 - 48);
		expect(asideWidthFor("full", { total: 1600, navDocked: false, stored: 300 })).toBe(1600 - 48);
	});
	it("navFits: 280 + aside + 360 must fit", () => {
		expect(navFits({ total: 900, asideW: 300 })).toBe(false);
		expect(navFits({ total: 940, asideW: 300 })).toBe(true);
		expect(navFits({ total: 1199, asideW: 559 })).toBe(true);
		expect(navFits({ total: 1199, asideW: 560 })).toBe(false);
	});
	it("isDocked with dockAside: the aside docks in mid mode and the nav un-docks when it no longer fits", () => {
		const both = { nav: true, aside: true };
		expect(isDocked("aside", "mid", both, { dockAside: true })).toBe(true);
		expect(isDocked("aside", "phone", both, { dockAside: true })).toBe(false);
		expect(isDocked("nav", "mid", both, { dockAside: true, total: 900, asideW: 300 })).toBe(false);
		expect(isDocked("nav", "mid", both, { dockAside: true, total: 1000, asideW: 300 })).toBe(true);
		expect(isDocked("nav", "mid", both, { total: 900, asideW: 300 })).toBe(true); // without dockAside the aside is a drawer, so the nav always fits
		expect(isDocked("nav", "wide", both, { dockAside: true, total: 1200, asideW: 600 })).toBe(false);
	});
	it("readAsideWidth accepts a stored integer in range and nothing else", () => {
		expect(readAsideWidth("420")).toBe(420);
		expect(readAsideWidth(writeAsideWidth(512))).toBe(512);
		for (const junk of [null, "", "abc", "-5", "1e9", "239", "10001", "{}", "300.5"]) expect(readAsideWidth(junk)).toBe(null);
	});
	it("panelsState passes dockAside through", () => {
		const s = panelsState({ mode: "mid", present: { nav: true, aside: true }, hidden: { nav: false, aside: false }, drawer: null, dockAside: true, total: 900, asideW: 300 });
		expect(s.aside).toEqual({ present: true, docked: true, open: true });
		expect(s.nav).toEqual({ present: true, docked: false, open: false });
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd kit && npx vitest run src/panels.test.ts`
Expected: FAIL, `asideWidthFor is not a function` (and the rest).

- [ ] **Step 3: Implement the helpers in `kit/src/panels.ts`**

Add the constants, `AsideSize`, `navFits`, `asideWidthFor`, `clampAsideWidth`, `readAsideWidth`, `writeAsideWidth`; extend `isDocked` and `panelsState` with the optional `opts`. In `isDocked`, for `nav` in mid/wide mode: when `opts.dockAside` (or mode is wide) and both `total` and `asideW` are given and the aside is present, return `navFits({ total, asideW })`. Export the new names from `kit/src/index.ts` (`export { ..., type AsideSize } from "./panels.ts"`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd kit && npx vitest run src/panels.test.ts && npm run typecheck -w kit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add kit/src/panels.ts kit/src/panels.test.ts kit/src/index.ts
git commit -m "kit: pure aside width helpers (sizes, clamp, nav fit) for a resizable shell"
```

---

### Task 2: `tk-shell` attributes, handle and width

**Files:**
- Modify: `kit/src/tk-shell.ts`
- Modify: `kit/src/kit.css:12-13` (comment only: `--aside-w` is now set by the shell when resizable)
- Modify: `kit/README.md` ("Side panels" section)

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces (public surface, used by plan 3):
  - Attributes/properties on `tk-shell`:
    - `resizable` (boolean, property `resizable`): draws a drag handle on the docked aside's inner edge.
    - `aside-size` (reflected, property `asideSize: AsideSize`, default `"default"`).
    - `dock-aside` (boolean, property `dockAside`): aside docks in mid mode; nav un-docks when it doesn't fit.
    - `aside-fullscreen` (boolean, property `asideFullscreen`): the aside drawer is `100vw` wide instead of `min(85vw, 360px)`.
  - Methods: `resetAsideWidth(): void` (clears the stored width, back to 300).
  - Event: `tk-aside-resize` `{ width: number }` after a drag ends, bubbles+composed.
  - Storage: `<store-key>:aside-w` holds the dragged width (plain integer string).
  - Reflected attribute `aside-size` lets the app style the main area in `full` (plan 3 uses `tk-shell[aside-size="full"]`).
  - CSS: the shell sets `--aside-w: <px>` on `.layout` whenever the aside is docked; `.layout.aside-full .main` gets `min-width: 0` and the grid's main track is `var(--main-strip, 48px)` fixed.

- [ ] **Step 1: Add the properties and state**

In `static properties` add `resizable: { type: Boolean }`, `asideSize: { attribute: "aside-size", reflect: true }`, `dockAside: { type: Boolean, attribute: "dock-aside" }`, `asideFullscreen: { type: Boolean, attribute: "aside-fullscreen" }`, `width: { state: true }` (the shell's own `clientWidth`, kept current with a `ResizeObserver` on `this` from `connectedCallback`, disconnected in `disconnectedCallback`), `storedAsideW: { state: true }` (read in `connectedCallback` with `readAsideWidth(localStorage.getItem(`${storeKey}:aside-w`))`, in the same try/catch as the hidden flags).

- [ ] **Step 2: Compute the state and width through the helpers**

Replace the `state` getter's `panelsState(...)` call with one that passes `dockAside: this.dockAside, total: this.width, asideW: this.asideW`, where the getter `asideW` is `asideWidthFor(this.asideSize, { total: this.width, navDocked: <nav docked by panelsState without asideW>, stored: this.storedAsideW })`. Avoid the circularity by computing nav docking first with `isDocked("nav", mode, present, { dockAside, total, asideW: asideWidthFor(size, {navDocked: true ...}) })`: if the nav fits with a docked nav's width, it is docked; otherwise recompute the aside width with `navDocked: false`. One private method `layout(): { state: PanelsState; asideW: number }` does both; `state` and `asideW` read from it.

- [ ] **Step 3: Render the width, the full-size track, the handle and the fullscreen drawer**

In `render()`: set `style="--aside-w:${asideW}px"` on `.layout` when the aside is docked and open; add class `aside-full` when `asideSize === "full"` and the aside is docked. CSS: `.layout.aside-full { grid-template-columns: var(--sidebar-w) var(--main-strip, 48px) var(--aside-w); } .layout.aside-full.nav-closed { grid-template-columns: 0 var(--main-strip, 48px) var(--aside-w); }`. Inside the `.details` aside, when `this.resizable && s.aside.docked`, render `<div class="handle" role="separator" aria-orientation="vertical" aria-label="Resize panel" @pointerdown=${this.onHandleDown} @dblclick=${() => this.resetAsideWidth()}></div>` with CSS `.handle { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 3; touch-action: none; }` (`.details` gets `position: relative`). Drawer CSS: `:host([aside-fullscreen]) .details.drawer { width: 100vw; max-width: none; }`.

- [ ] **Step 4: Implement the drag**

`onHandleDown(e: PointerEvent)`: `setPointerCapture`, remember `startX` and the current `asideW`; on `pointermove` set `storedAsideW = clampAsideWidth(startW + (startX - e.clientX), { total: this.width, navDocked: state.nav.docked })` and `asideSize = "default"`; on `pointerup`/`pointercancel` persist with `localStorage.setItem(`${storeKey}:aside-w`, writeAsideWidth(storedAsideW))` (try/catch, only with a `storeKey`) and dispatch `tk-aside-resize { width }`. Add `.layout.dragging { transition: none; }` while dragging so the column follows the pointer. `resetAsideWidth()` sets `storedAsideW = null`, `asideSize = "default"`, removes the key.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck -w kit && npm run build -w kit && npm run test -w kit`
Expected: no errors; `dist.test.ts` passes (kit.js still imports only ./lit.js).

- [ ] **Step 6: Document in `kit/README.md`**

Under "Side panels" add a "Resizing and sizes" subsection listing the four attributes, `resetAsideWidth()`, `tk-aside-resize`, the storage key, the 240px minimum, the 360px chat floor, the 48px strip in `full`, and that `dock-aside` un-docks the nav before it narrows the chat. Keep the existing text; this supersedes the side-panels spec's "resizable widths" non-goal.

- [ ] **Step 7: Commit**

```bash
git add kit/src/tk-shell.ts kit/src/kit.css kit/README.md
git commit -m "kit: tk-shell resizable aside with snap sizes, forced docking and a fullscreen drawer"
```

---

### Task 3: Kit e2e for the new shell behaviour

**Files:**
- Modify: `kit/demo/index.html` (give the demo shell `resizable`, and buttons that set `aside-size`, `dock-aside`, `aside-fullscreen`; ids `size-default`, `size-half`, `size-full`, `dock-toggle`, `fullscreen-toggle`)
- Test: `kit/e2e/resize.spec.ts`

**Interfaces:**
- Consumes: Task 2 attributes and `resetAsideWidth()`; demo store key is `kit-demo:panels`.

- [ ] **Step 1: Write the failing e2e**

```ts
import { expect, test } from "@playwright/test";

const shell = "tk-shell";
const aside = 'tk-shell aside[aria-label="Details"]';
const main = "tk-shell main";
const width = async (page: any, sel: string) => Math.round((await page.locator(sel).boundingBox())!.width);

test.describe("resizable aside", () => {
	test.skip(({ isMobile }) => isMobile, "desktop columns only");
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.clear());
		await page.setViewportSize({ width: 1600, height: 900 });
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
	});

	test("dragging the handle widens the aside and the width survives a reload", async ({ page }) => {
		const h = page.locator("tk-shell .handle");
		const hb = (await h.boundingBox())!;
		await page.mouse.move(hb.x + 4, hb.y + 200);
		await page.mouse.down();
		await page.mouse.move(hb.x - 200, hb.y + 200, { steps: 5 });
		await page.mouse.up();
		await expect.poll(() => width(page, aside)).toBe(500);
		expect(await page.evaluate(() => localStorage.getItem("kit-demo:panels:aside-w"))).toBe("500");
		await page.reload();
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await expect.poll(() => width(page, aside)).toBe(500);
	});

	test("the chat floor wins when the window shrinks", async ({ page }) => {
		await page.evaluate(() => localStorage.setItem("kit-demo:panels:aside-w", "900"));
		await page.reload();
		await page.setViewportSize({ width: 1100, height: 900 });
		await expect.poll(() => width(page, aside)).toBe(1100 - 280 - 360);
		await expect.poll(() => width(page, main)).toBeGreaterThanOrEqual(360);
	});

	test("double-click resets to 300 and clears the stored width", async ({ page }) => {
		await page.evaluate(() => localStorage.setItem("kit-demo:panels:aside-w", "500"));
		await page.reload();
		await expect.poll(() => width(page, aside)).toBe(500);
		await page.locator("tk-shell .handle").dblclick();
		await expect.poll(() => width(page, aside)).toBe(300);
		expect(await page.evaluate(() => localStorage.getItem("kit-demo:panels:aside-w"))).toBe(null);
	});

	test("half and full sizes", async ({ page }) => {
		await page.locator("#size-half").click();
		await expect.poll(() => width(page, aside)).toBe(660);
		await page.locator("#size-full").click();
		await expect.poll(() => width(page, aside)).toBe(1600 - 280 - 48);
		await expect.poll(() => width(page, main)).toBe(48);
		await expect(page.locator(shell)).toHaveAttribute("aside-size", "full");
		await page.locator("#size-default").click();
		await expect.poll(() => width(page, aside)).toBe(300);
	});

	test("dock-aside at 900px docks the aside and un-docks the nav", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 900 });
		await expect.poll(() => width(page, aside)).toBe(0); // a closed drawer
		await page.locator("#dock-toggle").click();
		await expect.poll(() => width(page, aside)).toBe(300);
		await expect(page.locator('tk-shell aside[aria-label="Demo pages"]')).toHaveClass(/drawer/);
		await expect.poll(() => width(page, main)).toBeGreaterThanOrEqual(360);
	});
});

test.describe("fullscreen drawer", () => {
	test.skip(({ isMobile }) => !isMobile, "phone only");
	test("aside-fullscreen makes the details drawer the whole width", async ({ page }) => {
		await page.goto("/");
		await page.waitForFunction(() => customElements.get("tk-shell"));
		await page.locator("#fullscreen-toggle").click();
		await page.locator(shell).evaluate((s: any) => s.show("aside"));
		await expect.poll(() => width(page, aside)).toBe(page.viewportSize()!.width);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build -w kit && cd kit && npx playwright test e2e/resize.spec.ts`
Expected: FAIL (no `.handle`, no `#size-half`).

- [ ] **Step 3: Update the demo page**

In `kit/demo/index.html` add `resizable` to the `<tk-shell>` and a row of buttons in the main area with the ids above, each a one-line inline `onclick` that sets the attribute on `document.querySelector("tk-shell")` (`setAttribute("aside-size","half")`, `toggleAttribute("dock-aside")`, `toggleAttribute("aside-fullscreen")`).

- [ ] **Step 4: Run the whole kit e2e**

Run: `npm run build -w kit && cd kit && npx playwright test`
Expected: PASS, including the existing `panels.spec.ts` (default width still 300, hide/show unchanged).

- [ ] **Step 5: Commit**

```bash
git add kit/demo/index.html kit/e2e/resize.spec.ts
git commit -m "kit: e2e for the resizable aside, snap sizes, dock-aside and the fullscreen drawer"
```

---

## Self-review notes

- Spec coverage: drag handle (T2), per-device remembered width (T2, storage), double-click reset (T2/T3), snap narrow/half/full with 48px strip (T1/T2/T3), iPad docking via `dock-aside` (T1/T2/T3), chat floor wins and nav un-docks first (T1/T3), fullscreen drawer for tablets (T2/T3), README (T2). "No drag handle on touch" is the app's call (plan 3 sets `resizable` only with a fine pointer).
- Names used across tasks: `AsideSize`, `asideWidthFor`, `clampAsideWidth`, `navFits`, `readAsideWidth`, `writeAsideWidth`, `resetAsideWidth`, `tk-aside-resize`, `<store-key>:aside-w`, attributes `resizable`, `aside-size`, `dock-aside`, `aside-fullscreen`. Plan 3 consumes exactly these.
