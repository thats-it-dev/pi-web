# Kit Side Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tk-shell` gets a right-hand details panel next to its left navigation panel. Both are hideable columns on desktop and drawers on phones, and the header owns their buttons. pi-web's progress panel moves onto the new panel, and the template and skill tell apps to use it.

**Architecture:** A pure state module (`kit/src/panels.ts`) decides the layout mode, which panels are docked, and how stored state is parsed; it is unit-tested in node. `tk-shell` owns panel state and pushes it to every connected `tk-header` (found through a bubbling `tk-header-connect` event, because headers often sit inside other shadow roots). Headers send toggle requests back as bubbling events. pi-web renders its progress sections in a new `pi-progress-panel` slotted into the shell from `pi-app`, so it retires its own column, its 1200px media query and its full-screen phone view.

**Tech Stack:** Lit 3.3.3 web components with shadow DOM, TypeScript, Vite; vitest (kit unit tests, node environment), Playwright (kit e2e against the built demo, pi-web e2e against a test hub).

**Spec:** `docs/superpowers/specs/2026-11-10-kit-side-panels-design.md`

## Global Constraints

- **Additive-only kit API.** Never remove or rename an export, `tk-` tag, attribute, event, slot, CSS custom property or published file. The `nav` slot, `nav-label`, `menu-label`, `tucked`, `tk-open-nav` and the `navOpen` property keep their current meaning. `npm run check-api -w kit` must pass.
- **An app that changes nothing must look and work the same after the kit deploys.** Every app loads the kit live from kit.thatsit.app.
- **Breakpoints:**
  - Phone is `max-width: 899px`.
  - With both panels, details is docked only at `min-width: 1200px`.
  - With only a details panel, it docks from 900px.
- **Widths:** `--sidebar-w` (280px, existing) for navigation; new `--aside-w: 300px` in `kit.css`.
- **Look:** theme and kit tokens only. Drawer shadows use `var(--shadow-color)`, motion is `0.25s ease`, and `prefers-reduced-motion` already disables it in `sharedStyles`.
- **Stacking order:** header 5, overlay 10, drawers 20, sheet scrim 30, sheet panel 31.
- **Icons:** Lucide (ISC), inline SVG with `aria-hidden="true"`, in the same form as `tk-sheet`'s `X_ICON`: `panel-left`, `panel-right`, `menu`.
- **Git:**
  - Work on branch `feat/kit-side-panels` in worktree `~/workspace/pi-web-side-panels`, created from `master` at `1538a18` or later.
  - Commit with `git -c user.name="Michael Gutensohn" -c user.email="michael@gutensohn.me" commit`, messages `type: summary` of at most 72 characters, ending with the Claude co-author line.
  - Never push. Michael merges locally with `--no-ff` and says when to ship.
- **app-template** is a separate repo (`~/workspace/app-template`, branch `docs/side-panels`). keeb is never edited; it gets a prompt for pi.

## Review Focus

1. **A live app on an older layout.** The app-template starter and the kit demo (`tk-shell` + `nav` + `tk-header`, no `aside`) must look exactly as before: no right column, no extra header button, and ☰ still opens the drawer on phones. → Task 3 test `an app without a details panel looks as before`.
2. **A header used without any shell** (keeb today, single-page apps). It must render no panel buttons and throw no errors. → Task 4 test `a header outside a shell has no panel buttons`.
3. **A corrupt or foreign value under the storage key** (another app's JSON, `"1"`, invalid JSON). It must fall back to the defaults. → Task 1 tests for `readHidden`.
4. **Resizing across breakpoints with a drawer open.** At docked widths, nothing may stay inert or dimmed. → Task 3 test `widening the window closes an open drawer and nothing stays inert`.
5. **A sheet opened from inside an open drawer** (pi-web's "open plan"). The sheet must be clickable, its own Escape must close it first, and the drawer must stay open. → Task 3 test `a sheet opened from a drawer is usable and takes Escape first`.

---

## File Structure

**Kit (`kit/`)**
- `src/panels.ts` (new): pure state. Mode, docking, stored-state parsing, and the `PanelsState` type shared with the header.
- `src/panels.test.ts` (new): unit tests.
- `src/tk-shell.ts`: aside slot, columns, drawers, persistence, focus, inert, events.
- `src/tk-header.ts`: panel buttons and badge.
- `src/tk-sheet.ts`: emits `tk-sheet-toggle`.
- `src/styles.ts`: public `.icon-btn` and `.badge` classes.
- `src/icons.ts` (new): the Lucide SVG templates (`X_ICON` moves here from `tk-sheet.ts`).
- `src/kit.css`: `--aside-w`.
- `src/index.ts`: export the `Panel` and `PanelsState` types.
- `demo/index.html`: a details panel, a sheet button inside it, and `store-key`.
- `e2e/panels.spec.ts` (new): panel behaviour. `e2e/demo.spec.ts` stays as it is, apart from the old phone test (see Task 3).
- `README.md`: documents the panels.

**pi-web app (`app/`)**
- `src/components/pi-progress-panel.ts` (new): the progress sections as a slotted shell panel, with their own 1s ticker.
- `src/components/pi-app.ts`: renders the panel into `slot="aside"`, forwards panel events to `pi-session`, and owns the Back-closes-drawer history entry.
- `src/components/pi-session.ts`: drops the column, `WIDE`, `progressOpen`, `pi-progress-view` and the history handling. Emits `pi-progress`. Keeps the edge swipe and the plan sheet.
- `src/components/pi-header.ts`: drops its own `.badge` button and passes `aside-label` and `aside-badge` to `tk-header`.
- `src/components/pi-progress-view.ts`: deleted.
- `e2e/smoke.spec.ts`: progress tests rewritten for the drawer. Look snapshots are updated.

**Docs**
- `~/workspace/app-template/README.md` and `AGENTS.md`.
- `skills/thatsit-app/SKILL.md` (pi-web repo).

---

### Task 1: Panel state module

**Files:**
- Create: `kit/src/panels.ts`, `kit/src/panels.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Panel = "nav" | "aside";
  export type Mode = "phone" | "mid" | "wide";
  export const PHONE_MAX = 899;
  export const WIDE_MIN = 1200;
  export type Hidden = Record<Panel, boolean>;
  export type PanelState = { present: boolean; docked: boolean; open: boolean };
  export type PanelsState = Record<Panel, PanelState>;
  export function modeFor(width: number): Mode;
  export function isDocked(panel: Panel, mode: Mode, present: Record<Panel, boolean>): boolean;
  export function readHidden(raw: string | null, fallback: Hidden): Hidden;
  export function writeHidden(h: Hidden): string;
  export function panelsState(o: { mode: Mode; present: Record<Panel, boolean>; hidden: Hidden; drawer: Panel | null }): PanelsState;
  ```

- [ ] **Step 1: Write the failing tests** in `kit/src/panels.test.ts`:

```ts
it("modeFor uses 899 and 1200", () => {
	expect([modeFor(320), modeFor(899), modeFor(900), modeFor(1199), modeFor(1200)]).toEqual(["phone", "phone", "mid", "mid", "wide"]);
});
it("nav docks from 900; details docks from 1200, or from 900 when there is no nav", () => {
	const both = { nav: true, aside: true };
	const asideOnly = { nav: false, aside: true };
	expect(isDocked("nav", "phone", both)).toBe(false);
	expect(isDocked("nav", "mid", both)).toBe(true);
	expect(isDocked("aside", "mid", both)).toBe(false);
	expect(isDocked("aside", "wide", both)).toBe(true);
	expect(isDocked("aside", "mid", asideOnly)).toBe(true);
	expect(isDocked("aside", "phone", asideOnly)).toBe(false);
});
it("readHidden keeps booleans it knows and falls back on anything else", () => {
	const fb = { nav: false, aside: true };
	expect(readHidden('{"nav":true}', fb)).toEqual({ nav: true, aside: true });
	expect(readHidden('{"nav":"yes","aside":false}', fb)).toEqual({ nav: false, aside: false });
	for (const junk of [null, "", "1", "x{", "[]", "null", '"s"']) expect(readHidden(junk, fb)).toEqual(fb);
	expect(readHidden(writeHidden({ nav: true, aside: false }), fb)).toEqual({ nav: true, aside: false });
});
it("panelsState: open means a visible column, or the one open drawer", () => {
	const s = panelsState({ mode: "mid", present: { nav: true, aside: true }, hidden: { nav: false, aside: false }, drawer: "aside" });
	expect(s).toEqual({ nav: { present: true, docked: true, open: true }, aside: { present: true, docked: false, open: true } });
	const h = panelsState({ mode: "wide", present: { nav: true, aside: false }, hidden: { nav: true, aside: false }, drawer: null });
	expect(h).toEqual({ nav: { present: true, docked: true, open: false }, aside: { present: false, docked: false, open: false } });
});
```

- [ ] **Step 2: Run them and check they fail**
  Run: `npm test -w kit -- panels`
  Expected: FAIL. The module `./panels.ts` does not exist.

- [ ] **Step 3: Implement `kit/src/panels.ts`** with the signatures above.
  - A missing panel is never docked and never open.
  - A docked panel is open when it is not hidden.
  - An undocked panel is open only when it is `drawer`.

- [ ] **Step 4: Run the tests and check they pass**
  Run: `npm test -w kit -- panels`
  Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**
  Commit `kit/src/panels.ts` and `kit/src/panels.test.ts` with the message `feat(kit): panel layout state for tk-shell`.

---

### Task 2: Shell details panel and desktop hide/show

**Files:**
- Modify: `kit/src/tk-shell.ts`, `kit/src/kit.css` (add `--aside-w: 300px;` to the `:root` block), `kit/src/index.ts` (`export type { Panel, PanelsState } from "./panels.ts";`), `kit/demo/index.html`
- Test: `kit/e2e/panels.spec.ts`

**Interfaces:**
- Consumes: Task 1, all of it.
- Produces the `tk-shell` API:
  - **Slots:** `nav` (existing), `aside` (new), default.
  - **Attributes:**
    - `nav-label` (existing).
    - `aside-label`, default `"Details"`, used as the aria-label of the right `<aside>`.
    - `store-key`: a localStorage key. With no key set, nothing is stored.
    - `nav-hidden` and `aside-hidden`: reflected booleans, the desktop hidden state. Writing one in markup sets the default.
  - **Properties:** `navOpen` (existing: nav drawer open), `asideOpen: boolean` (aside drawer open), `navHidden`, `asideHidden`.
  - **Methods:** `show(panel: Panel): void`, `hide(panel: Panel): void`, `toggle(panel: Panel): void`.
    - When the panel is docked, they set the `*Hidden` flag and write `store-key`.
    - Otherwise they set the drawer; opening one drawer closes the other.
  - **Events listened for on the host** (all with detail `{ panel: Panel }`): `tk-open-nav` (existing, means `show("nav")`), `tk-toggle-panel`, `tk-show-panel`, `tk-hide-panel`.
  - **Event emitted:** `tk-panel-change`, with detail `{ panel: Panel; open: boolean; docked: boolean }`, bubbling and composed. It fires whenever a panel's `open` or `docked` changes, but not on first render.
  - **Listeners:** the shell adds its host listeners in the constructor, not in `connectedCallback`, so a header that connects in the same upgrade pass is never missed.
  - **Mode:** computed from `matchMedia("(max-width: 899px)")` and `matchMedia("(min-width: 1200px)")`. Presence is computed from each slot's `slotchange` (assigned elements > 0).

- [ ] **Step 1: Update the demo.** In `kit/demo/index.html`:
  - Give `tk-shell` the attributes `aside-label="Details"` and `store-key="kit-demo:panels"`.
  - Add `<section slot="aside"><span class="label">details</span><p>Slotted details.</p><button class="btn ghost" id="open-sheet-2">Open sheet</button></section>`. Wire `#open-sheet-2` to open the same sheet.
  - Add query switches to the demo script, run before the page settles, so the tests can cover other app setups:
    - `?nav=0` and `?aside=0` remove the matching slotted element, for an app without one of the panels.
    - `?navhidden=1` sets the `nav-hidden` attribute on `tk-shell` before it upgrades.
- [ ] **Step 2: Write the failing desktop tests** in `kit/e2e/panels.spec.ts`. Use the `desktop` project only (`test.skip(isMobile)`); the default viewport is 1280 wide. Clear localStorage in `beforeEach`.
  - `both panels are columns that push the main area`:
    - `tk-shell aside[aria-label="Details"]` is visible.
    - Its box sits at the right edge, 300px wide.
    - The main area's right edge is at most the aside's left edge.
  - `hide and show the details column, remembered after reload`:
    - Call `document.querySelector("tk-shell").hide("aside")`. The aside's width animates to 0, the host gets the `aside-hidden` attribute, and `localStorage["kit-demo:panels"]` is `{"nav":false,"aside":true}`.
    - After a reload it is still hidden.
    - `show("aside")` brings it back.
  - `nav-hidden in markup is the default when nothing is stored`: open `/?navhidden=1`, where the demo script sets the attribute before upgrade. The nav column has width 0.
  - `tk-panel-change reports hide and show`: collect events on `window`. `hide("nav")` gives `{panel:"nav",open:false,docked:true}`.
- [ ] **Step 3: Check the new tests fail.**
  Run: `npm run build -w kit && npx playwright test -c kit/playwright.config.ts kit/e2e/panels.spec.ts --project=desktop`
  Expected: FAIL. There is no `aside` in the shell.
- [ ] **Step 4: Implement it in `tk-shell.ts`.**
  - **Grid:** `grid-template-columns: var(--sidebar-w) minmax(0,1fr) var(--aside-w)`. The `0` width for a hidden or absent column, `transition: grid-template-columns 0.25s ease`, a `--line` border on the inner edge of each docked column, and `overflow: hidden` on the column so its content doesn't wrap while it animates.
  - **Columns:** always render both `<aside>` elements. The second one is `aria-label=${asideLabel}`.
  - **Storage:** read stored state once in `connectedCallback` with `readHidden(localStorage.getItem(key), {nav: navHidden, aside: asideHidden})`. Wrap every storage call in try/catch.
- [ ] **Step 5: Check the tests pass, and the old demo tests too.**
  Run: `npm run build -w kit && npx playwright test -c kit/playwright.config.ts`
  Expected: PASS on desktop and phone. The old phone drawer test in `demo.spec.ts` may fail only because of the class names it reads; Task 3 rewrites it.
- [ ] **Step 6: Commit** with the message `feat(kit): tk-shell details panel with hideable desktop columns`.

---

### Task 3: Drawers, inert, Escape, focus, sheets on top

**Files:**
- Modify: `kit/src/tk-shell.ts`, `kit/src/tk-sheet.ts`, `kit/e2e/demo.spec.ts` (the phone drawer test)
- Test: `kit/e2e/panels.spec.ts`

**Interfaces:**
- Consumes: Task 2's shell API.
- Produces: `tk-sheet` dispatches `tk-sheet-toggle` with detail `{ open: boolean }`, bubbling and composed, from `updated()` whenever `open` changes (including a first render with `open` set). The shell listens for it on `document` and keeps a count of open sheets.

- [ ] **Step 1: Write the failing tests** in `kit/e2e/panels.spec.ts`. Phone tests run on the `phone` project; mid-width tests call `page.setViewportSize({ width: 1000, height: 800 })` on desktop.
  - `phone: both panels are drawers; tap the dim or Escape closes`:
    - `show("nav")` slides the nav in and leaves `aside` hidden.
    - `show("aside")` closes nav and opens aside from the right.
    - A click on `tk-shell .overlay` at x=10 closes it.
    - Reopen, then press Escape, and it closes.
  - `phone: a closed drawer cannot be reached with Tab`:
    - With nothing open, pressing Tab 15 times never focuses an element inside `[slot=nav]` or `[slot=aside]`.
  - `phone: focus moves into an opened drawer and back to its opener`:
    - Focus a button in the main area, then dispatch `tk-show-panel` from it.
    - The focused element is inside `[slot=aside]`.
    - Press Escape, and focus is back on that button.
  - `mid width with both panels: nav is a column, details a drawer`:
    - At 1000px wide, nav is docked (width 280), and `show("aside")` opens a drawer over the page with the overlay visible.
  - `mid width with only details: it is a column`: at `/?nav=0` and 1000px wide, the aside is docked.
  - `widening the window closes an open drawer and nothing stays inert`:
    - On a 412px viewport, open aside, then resize to 1280.
    - The overlay is hidden.
    - No element in `tk-shell`'s shadow root has `inert` except a hidden column.
    - Clicking a main-area button works.
  - `a sheet opened from a drawer is usable and takes Escape first`:
    - On phone, open aside and click `#open-sheet-2`.
    - The sheet's Close button is clickable.
    - Escape closes the sheet, and the aside stays open.
    - A second Escape closes the aside.
  - `an app without a details panel looks as before`:
    - At `/?aside=0`, on desktop the right column has width 0 and there's no second border.
    - On phone, `tk-header .menu` opens the nav drawer, and clicking a nav link closes it.
  - Rewrite `demo.spec.ts`'s phone drawer test to assert `aside[aria-label="Demo pages"]` is in the viewport, instead of reading the `nav-open` class. Its behaviour stays the same.
- [ ] **Step 2: Check they fail.** Run the e2e command from Task 2. Expected: FAIL in the new tests.
- [ ] **Step 3: Implement it.**
  - **Drawers:**
    - Undocked panels are `position: fixed` drawers, `width: min(85vw, 360px)`, nav on the left and aside on the right, `z-index: 20`, with `box-shadow` from `--shadow-color`.
    - Closed means `translateX(∓100%)` plus `visibility: hidden` delayed until the slide ends (`transition: transform .25s ease, visibility 0s linear .25s`). Closed drawers also get `inert`.
    - The overlay (`z-index: 10`) shows while a drawer is open.
    - Safe areas: `padding-top: env(safe-area-inset-top)` on both sides, as nav has today.
  - **Open drawer:** while a drawer is open, the main area and the other panel are `inert`, unless the open-sheet count is above 0.
  - **Focus on open:** remember the deep active element (follow `shadowRoot.activeElement`). After render, focus the first focusable in the drawer's slotted content, or the `<aside>` itself with `tabindex="-1"`. On close, restore focus to the remembered element if it is still connected.
  - **Escape:** a `document` `keydown` closes the open drawer, but only when no sheet is open.
  - **Mode changes:** going into a mode where the open drawer's panel is docked clears the drawer.
  - **Nav drawer:** link clicks and `hashchange` close it, as today.
- [ ] **Step 4: Check the tests pass.** Run the same command. Expected: all kit e2e tests pass on both projects.
- [ ] **Step 5: Commit** with the message `feat(kit): side panel drawers with inert, Escape and focus`.

---

### Task 4: Header panel buttons, badge, shared icon-button

**Files:**
- Create: `kit/src/icons.ts`
- Modify: `kit/src/tk-header.ts`, `kit/src/tk-shell.ts`, `kit/src/styles.ts`, `kit/src/tk-sheet.ts` (import `X_ICON` from `icons.ts`), `kit/demo/index.html` (header `aside-label="Details" aside-badge="3/7"`)
- Test: `kit/e2e/panels.spec.ts`

**Interfaces:**
- Consumes: `PanelsState` (Task 1); the shell events (Task 2).
- Produces:
  - **`icons.ts`:** `export const X_ICON, MENU_ICON, PANEL_LEFT_ICON, PANEL_RIGHT_ICON` (Lit `html` templates).
  - **`sharedStyles` classes:**
    - `.icon-btn`: 36px square grid, centered, `color: var(--text-muted)`, hover `var(--text-primary)`, svg 20px.
    - `.badge`: the pill from `pi-header.ts:28`: `padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 0.72rem; color: var(--text-secondary); font-variant-numeric: tabular-nums`.
  - **`tk-header` new attributes:** `aside-label` (default `"Details"`) and `aside-badge` (string; empty means no badge).
  - **`tk-header` new property:** `panels: PanelsState | null` (no attribute), set by the shell.
  - **Connecting:** `tk-header` dispatches `tk-header-connect` with detail `{ header: TkHeader }` (bubbling, composed) in `connectedCallback`, and `tk-header-disconnect` with the same detail in `disconnectedCallback`. The shell keeps a `Set` and assigns `header.panels` whenever state changes.
  - **Buttons:**
    - The left button keeps class `menu` and `aria-label=${menuLabel}`. It shows the menu icon on phone and in drawer mode, and the panel-left icon when docked. It dispatches `tk-toggle-panel {panel:"nav"}`, plus `tk-open-nav` when opening, for listeners outside the kit.
    - The right button has class `aside-toggle`, `aria-label=${asideLabel}`, the panel-right icon, and then `<span class="badge">` when `aside-badge` is set. It dispatches `tk-toggle-panel {panel:"aside"}`.
    - Both have `aria-expanded=${panels[p].open}` and render only when `panels[p].present`.
    - With `panels === null`, the header renders exactly today's markup: the ☰ text button on phones only.

- [ ] **Step 1: Write the failing tests** in `kit/e2e/panels.spec.ts`:
  - `header buttons toggle each panel and report aria-expanded`, on desktop:
    - Click `tk-header .aside-toggle`. It gets `aria-expanded="false"` and the aside column goes to 0.
    - Click again, and it is back with `"true"`.
    - Same for `tk-header .menu` with nav.
  - `phone: menu opens nav, panel button opens details, badge shows`:
    - `.aside-toggle` has the text `3/7`.
    - Clicking it opens the aside drawer and sets `aria-expanded="true"`.
  - `a header outside a shell has no panel buttons`:
    - Use a new demo page `demo/bare.html`: kit.css, kit.js and a lone `<tk-header aside-label="Details"><h1 slot="title">Bare</h1></tk-header>`.
    - `.aside-toggle` has count 0.
    - On desktop, `.menu` is hidden.
    - No console errors.
  - `no details content means no details button`: at `/?aside=0`, `.aside-toggle` has count 0.
- [ ] **Step 2: Check they fail.** Run the kit e2e command. Expected: FAIL. There's no `.aside-toggle`.
- [ ] **Step 3: Implement it as in the Interfaces block.** Add `demo/bare.html` to the build's copied files in `kit/scripts/build.ts`, following how `demo/index.html` is copied.
- [ ] **Step 4: Check they pass,** plus `npm test -w kit` and `npm run typecheck -w kit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message `feat(kit): header buttons and badge for the side panels`.

---

### Task 5: Kit docs, API check, published surface

**Files:**
- Modify: `kit/README.md`, `kit/test/dist.test.ts`

- [ ] **Step 1: Write the failing assertion.** In `dist.test.ts`, add `it("api.json lists the side panel API", ...)`. It checks that `attributes` includes `tk-shell:aside-label`, `tk-shell:store-key`, `tk-shell:aside-hidden`, `tk-header:aside-label` and `tk-header:aside-badge`, and that `events` includes `tk-panel-change`, `tk-toggle-panel` and `tk-sheet-toggle`.
- [ ] **Step 2: Run** `npm run build -w kit && npm test -w kit`.
  Expected: PASS, if Tasks 2–4 named things as specified. If it fails, fix the names in the source, not the test.
- [ ] **Step 3: Run** `npm run check-api -w kit`.
  Expected: exit 0. Nothing the live kit has was dropped.
- [ ] **Step 4: Write a "Side panels" section in `kit/README.md`.** It covers:
  - the two slots and what each is for;
  - the breakpoints rule, and the mid-width drawer;
  - every attribute, property, method and event above, with types;
  - `store-key`, and the default-hidden attribute;
  - the sheet rule;
  - the stacking order;
  - "never build a panel, drawer, scrim or toggle yourself";
  - a 10-line example with both panels.
- [ ] **Step 5: Commit** with the message `docs(kit): side panels API`.

---

### Task 6: pi-web progress panel on the kit's details panel

**Files:**
- Create: `app/src/components/pi-progress-panel.ts`
- Modify: `app/src/components/pi-app.ts`, `app/src/components/pi-session.ts`, `app/src/components/pi-header.ts`, `app/e2e/smoke.spec.ts`, look snapshots under `app/e2e/look.spec.ts-snapshots/`
- Delete: `app/src/components/pi-progress-view.ts`

**Interfaces:**
- Consumes: the shell and header API (Tasks 2–4) through the `@thatsit/kit` workspace import; `renderProgress`, `progressStyles` and `badgeLabel` from `app/src/render/progress.ts` (unchanged).
- Produces:
  - **`pi-progress-panel`:** properties `store: ProgressStore | null` and `selectedKey: string | null`.
    - It subscribes to the store's `change` event and re-renders.
    - It runs a 1s interval only while any subagent is `running`.
    - Its children emit `pi-open-child` (detail: key) and `pi-open-plan` (detail: path), bubbling and composed, through `renderProgress` opts.
  - **`pi-session`:**
    - Dispatches `pi-progress` with detail `{ store: ProgressStore | null }` (bubbling, composed) when its progress store is created or stopped, and when `view.empty` flips.
    - Gains public `openChild(key: string): void` and `openPlan(): void`, which are today's `onOpenChild` and `onOpenPlan` minus the progress-view state.
  - **`pi-header`:** passes `aside-label="Progress"` and `aside-badge=${badge ?? ""}` to `tk-header`, and removes its own `.badge` button and `pi-open-progress`.

- [ ] **Step 1: Rewrite the progress tests in `smoke.spec.ts`. They must fail against today's code.**
  - **Desktop column:**
    - `pi-session aside` becomes `tk-shell [slot=aside]`, with the same content assertions.
    - Replace `Progress button toHaveCount(0)` with: the Progress button has `aria-expanded="true"`; clicking it hides the column (`aria-expanded="false"`); clicking again shows it.
  - **"No progress, no column":** the Progress button has count 0 and `[slot=aside]` has count 0.
  - **Phone:**
    - `pi-progress-view` becomes the aside drawer: `tk-shell [slot=aside]` is in the viewport after a badge click.
    - Escape, the dimmed area, and Back each close it, and the URL stays `#/s/<id>`.
  - **"Plan sheet opens above"** keeps its assertions against the drawer.
  - **"Badge, row, thread, back"** keeps its assertions. After a row click the drawer is closed, and Back lands on the parent chat.
  - **New test `mid width: progress is a drawer beside the docked session list`:** at 1000×800, the session list is visible and the progress panel is reached only through the Progress button.
  - Run `npm run e2e -w app -- smoke`. Expected: FAIL on these tests.
- [ ] **Step 2: Implement `pi-progress-panel.ts`.**
  - It wraps `renderProgress(store.view, { now, selectedKey, openChild, openPlan })` in a `div` with `overflow-y: auto; overscroll-behavior: contain; padding-bottom: calc(16px + var(--safe-bottom))`.
  - It renders nothing when the store is null or its view is empty.
- [ ] **Step 3: Change `pi-session.ts`.**
  - Delete: `WIDE`, `wide`, `mq`, `progressOpen`, `onWide`, `openProgress`, `closeProgress`, `onPop` and the `popstate` listener, the column `aside` and its CSS, the `pi-progress-view` render and import, and the badge-focus code in `updated()`.
  - Remove the progress condition from the ticker.
  - The edge swipe now dispatches `tk-show-panel {panel:"aside"}` from the host.
  - Dispatch `pi-progress` as specified.
  - Keep `badgeLabel` for the header's `.badge`.
- [ ] **Step 4: Change `pi-app.ts`.**
  - **Shell:** `<tk-shell nav-label="Sessions" aside-label="Progress" store-key="pi-web:panels">`, with `${this.progress ? html`<pi-progress-panel slot="aside" .store=${this.progress} .selectedKey=${childKey}>` : nothing}`.
  - **State:** `progress` comes from `pi-progress` events.
  - **Forwarding:** on the panel, `@pi-open-child` calls `this.session()?.openChild(key)` and `@pi-open-plan` calls `.openPlan()`. `session()` queries `pi-session` in the render root.
  - **Back closes the drawer:**
    - On `tk-panel-change` with `{panel:"aside", docked:false, open:true}`: `history.pushState({ piProgress: true }, "")`.
    - On the same with `open:false`: if `history.state?.piProgress` and the close did not come from `popstate`, call `history.back()`.
    - On `popstate`, if the aside drawer is open, call `shell.hide("aside")`.
  - **Opening a child from the drawer:** set a `replacing` flag, call `hide("aside")` (which skips `history.back()` while the flag is set), then `location.replace(hrefFor({name:"subagent", id, key}))`, then clear the flag.
- [ ] **Step 5: Change `pi-header.ts`** as in the Interfaces block. Delete `pi-progress-view.ts`.
- [ ] **Step 6: Run the checks.**
  - Run `npm run typecheck -w app && npm test -w app && npm run e2e -w app`. Expected: PASS.
  - Then run `npm run e2e -w app -- look --update-snapshots`. Open each changed PNG and check that the only visual differences are the header's panel buttons and the progress column's border and width. Name each changed snapshot in the commit body.
- [ ] **Step 7: Commit** with the message `feat(app): progress panel on the kit's details panel`.

---

### Task 7: Template and skill tell apps to use the panels

**Files:**
- Modify: `~/workspace/app-template/README.md`, `~/workspace/app-template/AGENTS.md` (branch `docs/side-panels`), `skills/thatsit-app/SKILL.md` (pi-web)
- Test: `skills/thatsit-app/test/skill-md.test.ts` (the existing line-limit and subcommand tests)

- [ ] **Step 1: Update the app-template README.** The "App with navigation" bullet gains: details go in `<section slot="aside">` of `tk-shell`, with a link to the kit README's "Side panels" section.
- [ ] **Step 2: Update `AGENTS.md`.** Under **Code rules**, add: `- Side panels: put navigation in tk-shell's nav slot and details in its aside slot. Never build a panel, drawer, scrim or panel toggle yourself; the kit draws them.`
- [ ] **Step 3: Update `SKILL.md`.** In "Style rules", extend the kit components bullet with `tk-shell` `nav` and `aside` slots for side panels, never hand-built. The body must stay at 150 lines or fewer.
  - Run `npm test -w skills/thatsit-app`. Expected: PASS, 85 tests.
- [ ] **Step 4: Run** `cd ~/workspace/app-template && npm test`. Expected: PASS. AGENTS.md has no test, but the guardrails must still pass.
- [ ] **Step 5: Commit in each repo:**
  - app-template: `docs: point side panels at the kit`.
  - pi-web: `docs(thatsit-app): side panels come from the kit`.

---

## After the plan (not tasks)

- Michael reviews, merges `feat/kit-side-panels` locally (`--no-ff`) and says ship. Pushing `master` deploys the kit through `kit.yml`. The hub is then rebuilt and restarted for pi-web.
- Once kit.thatsit.app serves the new kit, give Michael the keeb prompt for a **new** pi session:
  `Replace keeb's hand-built insights pane with the kit's details panel (tk-shell aside slot, see the kit README "Side panels"). Keep keeb's start-closed rule and open-on-preview rule. Delete what the kit now does. One PR.`
