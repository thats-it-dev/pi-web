# thatsit kit, Phase 1: extract the kit, refactor pi-web, publish kit.thatsit.app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move pi-web's generic UI layer into a new `kit/` workspace (`@thatsit/kit`). pi-web imports it from source with no visible change, and CI publishes a built copy to https://kit.thatsit.app.

**Architecture:** `kit/src` holds plain Lit + CSS source that pi-web imports through the npm workspace (Vite compiles it as part of pi-web). A separate kit build makes self-contained ES modules for other apps: `kit.js`, with Lit kept external and resolved to `./lit.js`, so a page has one copy of Lit. It also makes `kit.css` with the theme inlined, `.d.ts` types, `api.json` (the public API surface), a demo page and `_headers`. A GitHub Actions workflow builds, checks that nothing in the API was removed against the live `api.json`, and deploys with `cf`.

**Tech Stack:** Lit 3.3.3, Vite 8, TypeScript 5.9, Vitest 5, Playwright 1.64, GitHub Actions, Cloudflare `cf` CLI 1.0.0-beta.14.

**Spec:** `docs/superpowers/specs/2026-10-20-thatsit-apps-design.md` (section 1 and the one-time setup in section 5). Phases 2 to 4 (template, skill, spark/atproto) get their own plans once this lands, written against the kit interfaces defined here.

## Global Constraints

- pi-web must look and behave identically. Task 1's screenshot suite is the referee, and its snapshots must not be regenerated after Task 1.
- Element prefix `tk-`. Events `tk-toast`, `tk-close`, `tk-open-nav`.
- Kit API is additive-only: exports, element tags, CSS custom properties and published files are never removed or renamed.
- Exactly one copy of Lit per page. Built `kit.js` imports nothing except `./lit.js`.
- `https://pi.thatsit.app/theme/theme.css` keeps working (the existing `publishTheme` plugin stays).
- Tooling: `gh` and `cf`. The one exception is CI's upload step, `wrangler pages deploy --project-name thatsit-kit --branch <branch>` (cf beta.14 can't upload to Pages). Look up `cf` commands with `cf cli search "<task>"`, keeping queries free of names, domains and IDs.
- Pages project name `thatsit-kit`, production branch `master`, custom domain `kit.thatsit.app`.
- Secrets live only in GitHub org secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Never print them or commit them.
- Match the repo's style: tabs, `.ts` import extensions, comments that explain why, sparse.

## Review Focus

1. **Forced theme against the system setting.** With the system in light mode and the stored preference set to dark, the page must render dark (this exercises theme-init's `data-key`). Test in Task 1/5: `look.spec.ts` "forced dark".
2. **Drawer closes on a link to the page already open.** No hash change happens, so a hashchange listener alone misses it. The existing e2e phone test covers this through `pi-app .layout`, and tk-shell must keep the `.layout` and `.nav-open` class names. Also covered by the Task 4 kit demo test.
3. **Header stays sticky after it's wrapped.** The `tk-header` inside `pi-header` only sticks if `pi-header` is `display: contents`. Test in Task 5: computed `position` is `sticky` and the header's top stays at 0 after scrolling.
4. **API check against an unreachable kit site.** A 404 (first deploy) passes; a network error or 5xx fails the job rather than silently passing. Test in Task 3.
5. **Fonts loaded cross-origin.** Another app's page loading `kit.css` needs CORS on `/fonts/*`. Test in Task 3: `_headers` grants `Access-Control-Allow-Origin: *` on `/*`.

---

### Task 1: Pin pi-web's current look with screenshot tests

**Files:**
- Create: `app/e2e/look.spec.ts`
- Create (generated): `app/e2e/look.spec.ts-snapshots/*.png`

**Interfaces:** Produces the visual referee that Tasks 5 and 6 must pass without updating snapshots.

- [ ] **Step 1: Write `look.spec.ts` on the current code.** Run it under both existing Playwright projects (desktop, phone), in both `colorScheme` values (`page.emulateMedia`). Use `toHaveScreenshot(name, { fullPage: false, maxDiffPixels: 50, mask })`, masking `pi-sidebar .ago` and `pi-header .l2`. Cases:
  - `home`: `/`, the empty state.
  - `settings`: `/#/settings`.
  - `drawer` (phone only): home, click "Open sessions", screenshot with the drawer open.
  - `session-sheet`: start a session (copy `startSession` from `smoke.spec.ts`), send "hi", wait for "Hello world", click "Session stats", then screenshot with the sheet open.
  - `toast`: home, then `page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-toast", { detail: { message: "Saved", level: "warning" } })))`, then screenshot. (Task 5 changes only the event name in this trigger.)
  - `forced dark`: emulate light, `addInitScript` sets `localStorage["pi-web:theme"]="dark"`, then screenshot `/#/settings`. It must equal the dark `settings` snapshot (assert by reusing the same snapshot name).
- [ ] **Step 2: Generate the baselines.** Run `cd app && npx playwright test e2e/look.spec.ts --update-snapshots`, then run again without the flag. Expected: all pass twice in a row (not flaky).
- [ ] **Step 3: Run the existing suites.** `npm test` and `npm run e2e -w app`. Expected: PASS.
- [ ] **Step 4: Commit** `test(app): screenshot suite pinning pi-web's look before the kit extraction`.

### Task 2: Create the `kit` workspace with the shared styles, toast and viewport

**Files:**
- Create: `kit/package.json`, `kit/tsconfig.json`, `kit/README.md`
- Create: `kit/src/kit.css`, `kit/src/styles.ts`, `kit/src/toast.ts`, `kit/src/viewport.ts`, `kit/src/theme-init.js`, `kit/src/index.ts`
- Move: `app/src/lib/viewport.test.ts` → `kit/src/viewport.test.ts`; create `kit/src/toast.test.ts`
- Modify: root `package.json` (add `"kit"` to `workspaces` after `"theme"`; add `npm run test -w kit` and `npm run typecheck -w kit` to the `test` and `typecheck` scripts)

**Interfaces:**
- Produces (from `@thatsit/kit`, `kit/src/index.ts`):
  - `sharedStyles: CSSResult`, the exact contents of today's `app/src/styles/shared.ts`.
  - `type ToastLevel = "info" | "warning" | "error"`, `interface ToastDetail { message: string; level: ToastLevel }`, `const TOAST_EVENT = "tk-toast"`, `toast(message: string, level?: ToastLevel): void` (dispatches `TOAST_EVENT` on `window`).
  - `viewportState`, `fullHeight`, `trackViewport`, `ViewportInput`, `ViewportState`: today's `lib/viewport.ts`, unchanged.
- Package exports: `"."` → `./src/index.ts`, `"./kit.css"` → `./src/kit.css`, `"./theme-init.js"` → `./src/theme-init.js`. Dependencies: `lit` `3.3.3`, `@thatsit/theme` `*`. `"private": true`.
- `kit.css` = `@import "@thatsit/theme/theme.css";` followed by today's `app/src/styles/global.css` minus its own `@import` and minus the `pi-app { … }` rule.
- `theme-init.js` = today's `app/public/theme-init.js`, except the storage key comes from `document.currentScript.dataset.key`, with `"thatsit:theme"` as the default.

- [ ] **Step 1: Write the failing test** `kit/src/toast.test.ts`. `toast("hi")` dispatches one `tk-toast` event with detail `{ message: "hi", level: "info" }`, and `toast("x", "error")` gives `level: "error"`. Stub `window` with an `EventTarget` (the environment is node, as in the app).
- [ ] **Step 2: Run** `npm test -w kit`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the files above, moving code verbatim, and move `viewport.test.ts` with its module. Vitest config is `test: { environment: "node", include: ["src/**/*.test.ts"] }`.
- [ ] **Step 4: Run** `npm install`, `npm test -w kit`, `npm run typecheck -w kit`. Expected: PASS, and the viewport tests pass unchanged.
- [ ] **Step 5: Commit** `feat(kit): shared styles, tokens, toast, viewport and theme-init as @thatsit/kit`.

(pi-web still uses its own copies until Task 5, so its build is untouched.)

### Task 3: Kit build for other apps, API surface and check

**Files:**
- Create: `kit/vite.config.ts`, `kit/src/lit.ts`, `kit/tsconfig.build.json`
- Create: `kit/scripts/build.ts`, `kit/scripts/surface.ts`, `kit/scripts/check-api.ts`
- Create: `kit/public/_headers`
- Test: `kit/scripts/surface.test.ts`, `kit/test/dist.test.ts`

**Interfaces:**
- `kit/src/lit.ts`: `export * from "lit"; export * from "lit/directives/unsafe-html.js";` (pi-web uses only that directive. More can be added later, since additions are allowed.)
- `interface ApiSurface { exports: string[]; elements: string[]; cssProps: string[]; files: string[] }` (each sorted).
- `surface.ts` exports `diffSurface(prev: ApiSurface, next: ApiSurface): string[]`, returning removed entries as `"<field>:<name>"` with additions ignored, and `collectSurface(distDir: string): Promise<ApiSurface>`. Exports come from the TypeScript compiler API (`checker.getExportsOfModule` on `src/index.ts`). Elements come from `customElements.define("…")` across `src`. CSS props are the `--name:` definitions in `dist/kit.css`. Files are the paths under `dist` (posix, relative).
- `check-api.ts <url>`: fetch `<url>/api.json`. On 404, print "no published surface; first deploy" and exit 0. On any other non-200 or a network error, exit 1. Otherwise exit 1 listing the `diffSurface` output if it isn't empty.
- `build.ts` writes into `kit/dist`: `kit.js` and `lit.js` (Vite library build, two entries, ES format; `lit`, `lit/*` external with `output.paths` mapping them to `./lit.js` in `kit.js`; `lit.js` bundles Lit), `kit.css` (the `@import` line replaced by the contents of `theme.css`), `fonts/` (copied from `@thatsit/theme`), `theme-init.js`, `types/` + `kit.d.ts` (`tsc -p tsconfig.build.json`, declaration-only with `rewriteRelativeImportExtensions`; `kit.d.ts` = `export * from "./types/index.js";`), `_headers`, `index.html` (from Task 4; skip if absent), and finally `api.json` from `collectSurface`.
- Scripts in `kit/package.json`: `"build": "node scripts/build.ts"`, `"check-api": "node scripts/check-api.ts https://kit.thatsit.app"`. `_headers`:
  ```
  /*
    Access-Control-Allow-Origin: *
    Cache-Control: public, max-age=300, must-revalidate
  /fonts/*
    Cache-Control: public, max-age=86400
  ```

- [ ] **Step 1: Write the failing tests.**
  - `surface.test.ts`: `diffSurface` of identical surfaces → `[]`; next missing export `toast` → `["exports:toast"]`; next gaining an element → `[]`; next missing `--panel` → `["cssProps:--panel"]`.
  - `dist.test.ts` (skips with a clear message if `dist/` is missing): the files `kit.js lit.js kit.css kit.d.ts theme-init.js api.json _headers fonts/Inter.ttf` exist. Every `import`/`from` specifier in `kit.js` is `"./lit.js"`. `kit.js` doesn't contain `class ReactiveElement` (Lit lives only in `lit.js`). `kit.css` contains no `@import` and defines `--primary` and `--panel`. `_headers` grants `Access-Control-Allow-Origin: *` under `/*`. `api.json.exports` includes `sharedStyles`, `toast`, `trackViewport`.
  - `check-api` behavior: unit-test its fetch handling by exporting `checkApi(url, fetchFn): Promise<{ ok: boolean; message: string }>`. 404 → ok; 503 → not ok; a thrown network error → not ok; a surface with a removal → not ok and the message names it.
- [ ] **Step 2: Run** `npm test -w kit`. Expected: FAIL.
- [ ] **Step 3: Implement** the scripts and config above.
- [ ] **Step 4: Run** `npm run build -w kit && npm test -w kit`. Expected: PASS, with dist tests running (not skipped).
- [ ] **Step 5:** add `kit/dist/` to `.gitignore`, then **commit** `feat(kit): standalone build, API surface and additive-only check`.

### Task 4: Kit components: `tk-sheet`, `tk-toasts`, `tk-header`, `tk-shell`, plus demo page

**Files:**
- Create: `kit/src/tk-sheet.ts`, `kit/src/tk-toasts.ts`, `kit/src/tk-header.ts`, `kit/src/tk-shell.ts`, `kit/demo/index.html`
- Modify: `kit/src/index.ts` (export the classes; importing the index defines all four elements), `kit/scripts/build.ts` (copy `demo/index.html` to `dist/index.html`)
- Test: `kit/e2e/demo.spec.ts`, `kit/playwright.config.ts`

**Interfaces (every visual rule is copied from the pi-web source named):**
- `TkSheet` `<tk-sheet open heading="…">`, from `pi-sheet.ts` unchanged except that its close event is `tk-close` (bubbles, composed).
- `TkToasts` `<tk-toasts>`, from `pi-toasts.ts`, listening for `TOAST_EVENT`. The stack's bottom offset is `var(--tk-toast-bottom, calc(96px + env(safe-area-inset-bottom)))`.
- `TkHeader` `<tk-header ?tucked menu-label="…">`. It takes the `:host`, `header`, `.l1`, `.menu`, `h1` and phone/tucked rules from `pi-header.ts`, with `h1` styling applied as `::slotted(h1)`. Markup: `<header><div class="l1"><button class="menu" aria-label=${menuLabel}>☰</button><slot name="title"></slot></div><slot></slot></header>`. The menu click dispatches `tk-open-nav` (bubbles, composed). Property `menuLabel` (attribute `menu-label`) defaults to `"Open menu"`. `tucked` is reflected.
- `TkShell` `<tk-shell nav-label="…">` with `<slot name="nav">` and a default slot. It takes `.layout`, `.sidebar`, `.main`, `.overlay` and the phone drawer rules from `pi-app.ts`, and must keep the class names `.layout` and `.nav-open` (the existing e2e depends on them). The sidebar is `<aside class="sidebar" aria-label=${navLabel}>` around the nav slot. The main area is a `<main class="main">` around the default slot. `navOpen` is a public property. It opens on `tk-open-nav` from anywhere inside it, and closes on overlay click, on `hashchange`, and on a click whose `composedPath()` includes an `HTMLAnchorElement` inside the nav slot.
- `demo/index.html` loads `./kit.css`, `./theme-init.js` and `<script type="module">import "./kit.js"</script>`. It shows a tk-shell with a nav slot of links (`#a`, `#b`, and one `href=""` pointing at the current page), a tk-header with an h1 title, `.btn`, `.btn.ghost`, `.seg`, `.label`, `.u`, `.dot` samples, an input, a button that opens a tk-sheet, and one that calls `toast`.

- [ ] **Step 1: Write the failing test.** `kit/e2e/demo.spec.ts` runs against `npx vite preview --outDir dist --port 5180` (webServer in `kit/playwright.config.ts`, projects desktop + phone like the app's). No console errors on load; `customElements.get("tk-shell")` is defined. Phone: click the header menu → `.layout` has `nav-open`; click the current-page link → no `nav-open`; open again, click the overlay → closed. Open the sheet, press Escape → the dialog is gone. Click toast → `role=status` contains the message.
- [ ] **Step 2: Run** `npm run build -w kit && npx playwright test -c kit/playwright.config.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the elements and the demo.
- [ ] **Step 4: Run** the same command. Expected: PASS. `npm test -w kit` still passes, and `api.json.elements` lists all four tags.
- [ ] **Step 5: Commit** `feat(kit): tk-sheet, tk-toasts, tk-header, tk-shell and demo page`.

### Task 5: pi-web uses the kit

**Files:**
- Modify: `app/package.json` (add `"@thatsit/kit": "*"`)
- Modify: `app/src/styles/global.css` (becomes `@import "@thatsit/kit/kit.css";` plus the `pi-app` rule)
- Delete: `app/src/styles/shared.ts`, `app/src/lib/toast.ts`, `app/src/lib/viewport.ts`, `app/src/components/pi-sheet.ts`, `app/src/components/pi-toasts.ts`, `app/public/theme-init.js`
- Modify: every importer of the deleted modules (`grep -rln "styles/shared.ts\|lib/toast.ts\|lib/viewport.ts" app/src`) to import from `@thatsit/kit`
- Modify: `app/src/components/pi-session.ts` (`pi-sheet` → `tk-sheet`, `@pi-close` → `@tk-close`)
- Modify: `app/src/components/pi-header.ts` (render `<tk-header ?tucked menu-label="Open sessions"><h1 slot="title">…</h1>…l2 + state…</tk-header>`; set `:host { display: contents }`; keep only the `.l2`, `.meter`, `.state` rules; the `tucked` property is passed through)
- Modify: `app/src/components/pi-app.ts` (render `<tk-shell nav-label="Sessions"><pi-sidebar slot="nav" …></pi-sidebar>…main…</tk-shell><tk-toasts>`; drop its layout CSS, `navOpen`, `onSidebarClick` and the nav part of `onHash`; the empty-state menu button dispatches `tk-open-nav`)
- Modify: `app/vite.config.ts` (`publishTheme` also serves `/theme-init.js` from `@thatsit/kit/theme-init.js` in dev and copies it to `dist/theme-init.js` in `writeBundle`)
- Modify: `app/index.html` (`<script src="/theme-init.js" data-key="pi-web:theme"></script>`)
- Modify: `app/e2e/look.spec.ts` (only the toast trigger's event name, `pi-toast` → `tk-toast`), and add the sticky-header test

**Interfaces:** Consumes everything Tasks 2 and 4 produce. pi-web's `pi-*` tags other than `pi-sheet` and `pi-toasts` keep their names.

- [ ] **Step 1: Write the failing test.** Add to `look.spec.ts`, "header stays pinned" (phone): start a session, send "hi" three times, then `getComputedStyle` of `pi-header >> tk-header` has `position: sticky`, and after scrolling the session's `.scroll` element up by 1px, its bounding-box top is 0.
- [ ] **Step 2: Run** `npx playwright test e2e/look.spec.ts -c app/playwright.config.ts`. Expected: FAIL (no `tk-header` yet).
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Verify.** Run `npm test`, `npm run typecheck`, `npm run build -w app`, and `cd app && npx playwright test` (smoke + look, without `--update-snapshots`). Expected: all PASS with existing snapshots unchanged. Then check `app/dist/theme-init.js` exists, `app/dist/theme/theme.css` still exists, and `git status` shows no `.png` changes.
- [ ] **Step 5: Commit** `refactor(app): build pi-web on @thatsit/kit`.

### Task 6: Publish kit.thatsit.app

**Files:**
- Create: `.github/workflows/kit.yml`
- Modify: `kit/README.md` (how to use the kit by URL, the API policy, the exact deploy command)
- Possibly create: `kit/cloudflare.config.ts` (only if `cf pages deploy` reads the project from it; see Step 2)

**Interfaces:** Produces https://kit.thatsit.app/{kit.js, lit.js, kit.css, kit.d.ts, types/, theme-init.js, fonts/, api.json, index.html}, which phase 2's template imports.

- [ ] **Step 1 (Michael, one-time):** `cf auth login` on the spark. Create a Cloudflare API token with "Cloudflare Pages: Edit" for CI. Then `gh secret set CLOUDFLARE_API_TOKEN --org thats-it-dev --visibility all` and `gh secret set CLOUDFLARE_ACCOUNT_ID --org thats-it-dev --visibility all`.
- [ ] **Step 2: Create the project and learn the deploy command.** `cf pages create --name thatsit-kit --production-branch master`. Then work out how `cf pages deploy kit/dist` selects the project and branch (`cf pages deploy --help`, `cf schema pages deploy`, the cf docs). Run one real deploy from the spark and confirm the `*.pages.dev` URL serves `api.json`. Record the exact command in `kit/README.md`.
- [ ] **Step 3: Attach the domain.** `cf pages domains create` for `kit.thatsit.app` on `thatsit-kit` (add the DNS CNAME in the thatsit.app zone if cf doesn't). Verify `curl -sI https://kit.thatsit.app/kit.css` gives 200 and `access-control-allow-origin: *`.
- [ ] **Step 4: Write `kit.yml`.** It runs on `push` to `master` with paths `kit/**`, `theme/**`, `.github/workflows/kit.yml`, plus `workflow_dispatch`. One ubuntu job: checkout, setup-node 24 with npm cache, `npm ci`, `npm test -w kit`, `npm run build -w kit`, `npm run check-api -w kit`, then the deploy command from Step 2 via `npx cf@1.0.0-beta.14`. Env: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from secrets. `concurrency: kit-deploy`.
- [ ] **Step 5: Verify in CI.** Push to master (with Michael's go-ahead), then `gh run watch` the workflow. Expected: green, and `curl -s https://kit.thatsit.app/api.json` lists the four `tk-` elements. Check that pi.thatsit.app's own Cloudflare Git-integration deploy also succeeds and the site looks unchanged.
- [ ] **Step 6: Commit** `ci(kit): publish @thatsit/kit to kit.thatsit.app with cf`. Steps 4 and 5 can share a commit if the workflow had to be fixed after the first run.
