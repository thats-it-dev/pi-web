# Kit side panels: navigation on the left, details on the right

Date: 2026-11-10 · Repo: `thats-it-dev/pi-web` (kit in `kit/`, app in `app/`) · Approved mockup: `https://spark-713a.tail9274fa.ts.net:8765/` (source: the scratchpad `mocks/index.html` of the 2026-11-10 session; screenshots worth keeping in the PR)

## Why

pi built keeb a collapsible insights pane on the right. Michael's verdict: it "looks out of place and slapped together". pi-web's sidebar is what he had in mind.

The cause is a gap in the kit. pi-web's sidebar is the kit's `tk-shell` (pi-web only supplies the session list as content), so it inherits the kit's look. The kit has nothing for a right-hand details panel and nothing that collapses on desktop, so pi hand-built one. It got its own widths (2.25rem rail, 19rem column), uppercase bold labels instead of the kit's lowercase `.label`, a rotated `›` character instead of an icon, a `--text` token that does not exist, and stacking levels that clash with `tk-sheet`. Every future app with a side panel would do the same.

The kit should own side panels completely: apps hand it content, the kit draws everything else, and a panel in any app looks like part of pi-web.

## Goals

1. **`tk-shell` gets an optional panel on each side.**
   - Left: navigation (the existing `nav` slot, unchanged in meaning).
   - Right: a details panel (new), for things like keeb's insights or pi-web's progress.
   - An app can use either, both, or neither. An app with only a right panel (keeb) has no left column and no menu button.
2. **Desktop: columns that push the page, and hide completely.**
   - Each panel is a column with a 1px `--line` divider, exactly as pi-web's sidebar is today.
   - A header button hides the panel entirely (no rail, no thin strip; Michael chose "collapsible to nothing") and shows it again. Hiding animates the column width.
   - Each panel's top row (the app's name or a section label, plus a hide button, as in the mockup) is **app content**, not drawn by the kit (my call). pi-sidebar already has its own top row, and a kit-drawn strip above it would double it. The kit supplies the pieces: the icon-button style, and a way for content to ask the shell to hide its panel (a bubbling event or method). This way the API gains no permanent label attributes.
   - The hidden/shown choice is remembered per app on desktop.
3. **Phone: both panels are drawers.**
   - Both start hidden. The menu button slides navigation in from the left; the panel button slides details in from the right. The page behind dims (`--overlay`).
   - Tapping the dimmed area or pressing Escape closes the drawer. Only one drawer is open at a time.
   - Following a link in the navigation drawer closes it (today's behaviour, kept).
4. **The header owns the buttons.**
   - `tk-header` shows the panel buttons in fixed places: navigation at the left edge, details at the right edge (after the `actions` slot). Icons: Lucide `panel-left` / `panel-right` on desktop, `menu` (☰ as an SVG icon) for navigation on phones, `panel-right` for details on phones. Same icon-button style as `tk-sheet`'s close button.
   - Each button has `aria-expanded` showing whether its panel is open, and an `aria-label` the app can set (`menu-label` exists; add one for the details button).
   - A button only appears when the shell actually has that panel.
   - The details button can carry a small count badge set by the app (pi-web's to-do count `3/7` today, keeb's count pill). The badge style moves into the kit.
5. **Accessibility fixes the kit is missing today** (keeb got these right, the kit did not):
   - A closed drawer cannot be reached with Tab (`inert`, and `visibility: hidden` once the slide-out ends).
   - Escape closes an open drawer.
   - `aria-expanded` on the toggle buttons.
   - Opening a drawer on a phone moves focus into it; closing returns focus to the button that opened it. While a drawer is open, the rest of the page is inert.
6. **Look: kit tokens only.**
   - Widths: `--sidebar-w` (existing, 280px) for navigation, a new `--aside-w` token (300px, pi-web's current progress column) for details.
   - Colours, font and labels from the theme and `sharedStyles`: lowercase `.label` for section headings inside panels, pi-web's selected-row style (`--panel` background, `--primary` left border) for selected items.
   - Shadows on drawers use `--shadow-color`, not literal rgba.
   - Motion: 0.25s ease for slides and column widths; `prefers-reduced-motion` turns it off (already in `sharedStyles`).
   - Document the stacking order (overlay 10, drawers 20, header 5, sheet scrim 30 and panel 31) so apps stop inventing their own.
7. **Adoption, all in this project:**
   - **pi-web's left sidebar** moves to the new shell behaviour (it already uses `tk-shell`, so it mostly comes for free: desktop hide button, Escape, inert drawer).
   - **pi-web's progress panel** moves onto the kit's right panel, replacing its own 300px column, its own 1200px JS breakpoint and its own full-screen phone view (`pi-progress-view`).
   - **keeb**, through a short prompt for pi (Michael's rule: I never edit app code; pi does). keeb swaps its hand-built pane for the kit's right panel. keeb is a single-page app today with no `tk-shell`.
   - **Template and skill docs**: app-template's README and `AGENTS.md`, and the thatsit-app skill, show the two panels and say never to build a side panel by hand.
   - **The kit demo** (`kit/demo/index.html`, live at kit.thatsit.app) shows both panels, like the mockup.

## Non-goals

- A thin collapsed rail or icon strip on desktop.
- Resizable or draggable panel widths.
- Moving pi-web's session list content, or keeb's insights content, into the kit. Content stays in the apps; the kit only draws the frame.
- Panels at the top or bottom, or more than one panel per side.
- Changing `tk-sheet`'s look or behaviour. Reusing its icon-button style and adding an event for the sheets-over-drawers rule is fine.

## Anti-goals (fail even if it works)

- **Breaking live apps.** The kit is loaded by URL from kit.thatsit.app by every app, so a kit deploy reaches pi-web, keeb, tips and every other app immediately, with no app release. The API is additive-only (README, enforced by `npm run check-api`): no export, tag, attribute, event, slot, CSS custom property or file is removed or renamed. `nav` slot, `nav-label`, `menu-label`, `tucked` and `tk-open-nav` keep working as they do today. An app that changes nothing must still look and work right after the kit deploys.
- **Looks bolted on.** A panel in keeb must look like it belongs with pi-web's sidebar. No hand-tuned sizes, no new fonts or weights, no colours outside the tokens.
- **A drawer you can tab into while it is closed**, or a panel button whose `aria-expanded` lies.
- **Squeezing the page.** On a mid-width screen with both panels open, the main area must not be crushed (see the breakpoint rule below).

## How it behaves (decided)

- **Breakpoints.** Phone is `max-width: 899px`, as today.
  - With only one panel, that panel is a column from 900px up.
  - With both panels, navigation is a column from 900px up, and details is a column only from 1200px up (pi-web's current progress breakpoint). Between 900 and 1199px, details is a right-hand drawer like on phones, opened by the same header button. This is my call, so the main area never drops below roughly 600px at 900px wide.
- **State.**
  - The shell owns open/hidden state. It also exposes it: reflected attributes for the desktop hidden state, properties for the drawer state, and a bubbling, composed event whenever a panel opens or closes, so apps can react (pi-web's edge swipe, keeb's own logic).
  - Apps can open, close or toggle each panel themselves (pi-web opens details from its edge swipe).
  - Desktop hidden state persists in `localStorage` under a key the app sets on the shell. With no key set, nothing is stored. Phones ignore stored state and always start with both drawers closed.
  - Resizing from phone width to desktop width closes any open drawer.
- **Empty details panel.** When the right-hand slot has no content, or the app marks it empty, there is no column, no drawer and no header button. pi-web relies on this: its progress panel only appears when a session has progress.
- **Defaults.** On desktop, both panels start shown unless stored state says otherwise. An app can declare a panel hidden by default (an attribute on the shell; my call). keeb needs this: its pane starts closed in production and open on preview hosts, and both rules stay keeb's.
- **Sheets over drawers.** A `tk-sheet` opened while a drawer is open must be fully usable (clickable, focusable, with its own focus handling). Escape closes the topmost layer first: the sheet, then the drawer on the next press. pi-web hits this all the time: "open plan" from the progress drawer, and a "pi needs an answer" dialog can arrive at any moment. The builder picks the mechanism, for example the shell lifting its inert/trap while a sheet is open. An additive change to `tk-sheet` (such as an open/close event) is allowed for this (my call; the non-goal below means no breaking or visual changes).

## Adoption details

- **pi-web left sidebar:** keep `pi-sidebar` as is. Check that the hash-change and link-click closing still works, and that tapping the current row closes the drawer (`app/e2e/smoke.spec.ts:197-207`).
- **pi-web progress panel** (`app/src/components/pi-session.ts`, `pi-progress-view.ts`, `pi-header.ts`):
  - The progress sections render into the shell's right-hand slot. `tk-shell` lives in `pi-app`, so the progress element must be a light-DOM child of `tk-shell` there, bound to the current session's progress.
  - The kit's details button and badge replace the header's own progress badge.
  - Keep pi-web-specific behaviour on top of the kit:
    - the swipe from the right edge (24px) opens the details drawer;
    - the browser Back button closes it (today it pushes a history entry);
    - selecting a subagent opens its thread in the main area.
  - `pi-progress-view` (the full-screen phone view) is retired once the drawer does its job. Its tests move to the drawer.
- **keeb** (done by pi, not by me): after the kit deploys, I write Michael a brief prompt in the style of the earlier ones, roughly: "Replace keeb's hand-built insights pane with the kit's right-hand panel in tk-shell (see kit.thatsit.app). Delete what the kit now does. One PR." keeb's own rules stay: the stored open/closed preference moves to the kit's key, and preview hosts defaulting to open can stay as keeb logic if the kit API allows it.
- **Template + skill:**
  - app-template README "App with navigation" gains the details panel.
  - `AGENTS.md` code rules: "Side panels: use `tk-shell`'s `nav` and details slots; never build a panel, drawer, scrim or toggle yourself."
  - The thatsit-app skill's Style rules list the new slot. `SKILL.md` must stay at 150 lines or fewer, so trim to fit.

## Constraints

- Lit components with shadow DOM. Shared CSS comes from `sharedStyles`, because shadow DOM does not inherit page CSS. One copy of Lit, loaded by URL.
- iOS: safe-area insets on the drawers. Drawers sit under `env(safe-area-inset-top)` like today's nav, with the bottom inset on scrolling content. `trackViewport` and `--app-h` keep working.
- `tk-header` is often wrapped in another component's shadow root (`pi-header` uses `display: contents`), so the header cannot find the shell by walking the DOM. Header and shell talk through bubbling composed events plus a state broadcast the header can hear. The builder picks the mechanism.
- Kit CI (`.github/workflows/kit.yml`) builds, tests, runs `check-api` and deploys on pushes to `master`. Nothing deploys until Michael says ship.
- Michael's process: work on a branch, commit with his identity flags, merge locally with `--no-ff`, push only when he says ship.

## Left to the builder

- Exact names of the new slot, attributes, properties, event and storage-key attribute (keep them in the existing `tk-` / kebab-case style and list them in the kit README).
- How the header learns which panels exist and their state.
- Whether the icon-button and badge styles become `sharedStyles` classes or stay inside `tk-header`. Anything public counts as API forever.
- Test split between kit unit tests (`kit/test`) and kit e2e (`kit/e2e`, against the demo). The e2e must cover:
  - both panels on desktop, hide and show, with remembered state;
  - the phone drawers, Escape and scrim closing, Tab not reaching a closed drawer, and focus moving in and back;
  - the 900–1199px case with both panels;
  - an app with no details content.
