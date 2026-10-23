# thatsit.app App Template (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public GitHub template repo, `thats-it-dev/app-template`. A new app made from it looks like pi-web, installs and opens offline as a PWA, deploys `main` to production, and comments a preview link on every PR.

**Architecture:** Vite + Lit + TypeScript. Source imports the kit and Lit by absolute URL (`https://kit.thatsit.app/kit.js`, `.../lit.js`). Vite leaves those imports external in both dev and build. TypeScript resolves them through `paths` to `.d.ts` files fetched from the kit into a git-ignored `.kit/`. One `app.config.json` holds everything per-app (name, title, description, icon color). A small Vite plugin turns it into the HTML placeholders, the manifest and the inlined touch icon.

**Tech Stack:** Vite 8.3.4, Lit 3.3.3 (types only), TypeScript 5.9.3, Vitest, Playwright, Node >= 22.18 (scripts are `.ts` run by type stripping), GitHub Actions, `wrangler@4.149.0 pages deploy` (upload only).

**Spec:** `docs/superpowers/specs/2026-10-20-thatsit-apps-design.md` §2, plus §5's "create app-template and mark it a template".

## Global Constraints

- The repo lives at `~/workspace/app-template` and its default branch is `main`. It is pushed to `thats-it-dev/app-template` (public) and marked as a template only in Task 5.
- Kit and Lit are imported **only** by URL: `https://kit.thatsit.app/kit.js` and `https://kit.thatsit.app/lit.js`. Never `import ... from "lit"`. The `lit` devDependency (3.3.3, the kit's version) exists only so the fetched types resolve.
- Page chrome comes from the kit: `<link rel="stylesheet" href="https://kit.thatsit.app/kit.css">`, the classic script `<script src="https://kit.thatsit.app/theme-init.js" data-key="app:theme">` and `<html data-shell>`. No colors, fonts or radii outside the kit tokens. The only exception is the icon color in `app.config.json`.
- Use the spike-verified tsconfig shape: `moduleResolution: "bundler"`, `allowImportingTsExtensions: true`, `useDefineForClassFields: false`, `strict: true`, `noEmit: true`, and `paths` mapping `https://kit.thatsit.app/kit.js` to `./.kit/kit.d.ts` and `https://kit.thatsit.app/lit.js` to `./.kit/types/lit.d.ts`. The published kit `.d.ts` files import `./x.ts`, which TypeScript resolves to `x.d.ts`. Don't rewrite them.
- CI secrets are the org-level `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. They are never echoed and never written to files.
- The upload is `npx wrangler@4.149.0 pages deploy dist --project-name "$NAME" --branch "$BRANCH"`. Every other Cloudflare action goes through `cf`.
- Match the code style of pi-web's `app/` and `kit/`: tabs, double quotes, terse comments that say why.
- Out of scope here: the atproto and spark modules (Phase 4) and the per-app CSP additions for them; the skill (Phase 3) adds those when an app needs them.

## Review Focus

1. **Kit unreachable on first visit.** Without the kit the page has no styling, so the starter shows a plain "Couldn't load the kit" line instead of a blank screen. Test: an e2e test with kit.thatsit.app routed to abort expects that text.
2. **Second copy of Lit.** If a dependency or a bare `"lit"` import sneaks in, two Lits load and styles break subtly. Test: an e2e test asserting `globalThis.litElementVersions.length === 1`, and a unit test asserting the built JS contains no `lit-html` source.
3. **CSP blocks the kit or the service worker.** `_headers` is only enforced on Pages, so a mistake would only show in production. Test: `vite preview` serves the `/*` headers parsed from `public/_headers`, and an e2e test fails on any `securitypolicyviolation`.
4. **Offline after install.** The kit is cross-origin, so a naive service worker caches nothing. Test: an e2e test loads the page, waits for the service worker to control it, goes offline, reloads, and expects the starter screen with kit styles.
5. **Branch names that aren't URL-safe.** For example `feat/Foo_bar`: the preview alias URL comes from wrangler's output and is never built by hand. Test: a unit test parsing real wrangler output, with and without an alias line.

---

### Task 1: Scaffold, app config and kit types

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `app.config.json`, `vite/config.ts`, `scripts/kit-types.ts`, `src/main.ts` (placeholder), `test/config.test.ts`, `test/kit-types.test.ts`, `vitest.config.ts`

**Interfaces:**
- Produces:
  - `type AppConfig = { name: string; title: string; description: string; color: string }`
  - `parseConfig(raw: unknown): AppConfig`, which throws `Error` with a message naming the bad field
  - `loadConfig(path?: string): AppConfig`, defaulting to `app.config.json` at the repo root
  - `collectTypes(fetchText: (path: string) => Promise<string>, entry?: string): Promise<Map<string, string>>`, where `entry` defaults to `"kit.d.ts"`. The CLI (`node scripts/kit-types.ts`) writes the map into `.kit/`.
  - npm scripts: `kit-types`, `typecheck` (with `pretypecheck: kit-types`), `test`, `dev` (with `predev: kit-types`), `build` (`tsc` then `vite build`, with `prebuild: kit-types`), `preview`, `e2e`, `icons`

- [ ] **Step 1: Write the config tests** in `test/config.test.ts`:
  - `parseConfig({name:"app-template",title:"App template",description:"Starter",color:"#FFAA00"})` round-trips.
  - It rejects a `name` of `"App"`, `"-x"`, `"x-"`, `"a_b"` and a 31-character string. The name rule is `/^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/`, the same as the Pages project and the subdomain.
  - It rejects an empty `title`, and a `color` that isn't `#RRGGBB`.
  - `loadConfig()` on the committed `app.config.json` returns `name: "app-template"`.
- [ ] **Step 2: Write the kit-types tests** in `test/kit-types.test.ts`, with a fake `fetchText` backed by a map:
  - Following `export * from "./types/index.js"` in `kit.d.ts`, then `"./styles.ts"` and `"./lit.ts"` from `types/index.d.ts`, collects exactly `kit.d.ts`, `types/index.d.ts`, `types/styles.d.ts` and `types/lit.d.ts`. A specifier ending `.js` or `.ts` maps to `.d.ts`, resolved relative to the importing file.
  - Bare specifiers (`"lit"`) are not followed.
  - A cycle terminates.
  - A rejected fetch propagates.
- [ ] **Step 3: Run `npx vitest run`.** Expect both files to fail because the modules are missing.
- [ ] **Step 4: Implement `vite/config.ts` and `scripts/kit-types.ts`.** The CLI fetches `https://kit.thatsit.app/<path>` with global `fetch`, writes atomically into `.kit/` (into `.kit.tmp`, then rename) and exits 0. If the fetch fails and `.kit/kit.d.ts` already exists, it warns ("using cached kit types") and exits 0; with no cache it exits 1.
- [ ] **Step 5: Add the placeholder `src/main.ts`** importing `toast` from `https://kit.thatsit.app/kit.js` and `html` from `https://kit.thatsit.app/lit.js`, and using both. Add an `@ts-expect-error` line on a non-existent kit export, so a broken `paths` mapping fails typecheck.
- [ ] **Step 6: Run `npm install && npm test && npm run typecheck`.** Expect all to pass and `.kit/types/tk-shell.d.ts` to exist.
- [ ] **Step 7: Commit.** Run `git init -b main` first; the commit message is "Scaffold app template: config, kit types".

### Task 2: Vite plugin, HTML, manifest, icons, headers

**Files:**
- Create: `vite/app-plugin.ts`, `vite/headers.ts`, `vite.config.ts`, `index.html`, `scripts/make-icons.ts`, `public/_headers`, `public/icons/*`, `public/apple-touch-icon.png`, `public/apple-touch-icon-precomposed.png`, `test/manifest.test.ts`, `test/headers.test.ts`, `test/build.test.ts`

**Interfaces:**
- Consumes: `loadConfig()` from Task 1.
- Produces:
  - `manifestFor(c: AppConfig): object`, with the same fields as pi-web's `app/public/manifest.webmanifest`: `id "/"`, `start_url "/"`, `scope "/"`, `display "standalone"`, `name`/`short_name` from `title`/`name`, `background_color` and `theme_color` set to `"#171717"`, and the same four icons without `?v=2`.
  - `parseHeaders(text: string): Record<string, Record<string, string>>`, which parses Cloudflare `_headers` (path lines, indented `Name: value` lines, `#` comments).
  - `thatsitApp(): Plugin[]`, which:
    - replaces `%APP_TITLE%`, `%APP_DESCRIPTION%` and `%APP_NAME%` in `index.html`;
    - inlines `public/apple-touch-icon.png` as a data URI at `__APPLE_TOUCH_ICON__` (copy pi-web's reason comment);
    - emits `manifest.webmanifest` at build and serves it in dev;
    - sets `preview.headers` from `parseHeaders(public/_headers)["/*"]`;
    - defines `__APP_TITLE__` for app code.
  - The `icons` script writes pi-web's icon set (same sizes, file names and radii as `app/scripts/make-icons.mjs`) with the dot in `config.color`. Port that file to `.ts` and read the config.

- [ ] **Step 1: Write the tests.**
  - `test/manifest.test.ts` checks that `manifestFor` maps the config fields and lists 4 icons, one of them maskable.
  - `test/headers.test.ts` checks that `parseHeaders` on the committed `public/_headers` gives `/*` a `Content-Security-Policy` containing each of:
    - `default-src 'self'`
    - `script-src 'self' https://kit.thatsit.app`
    - `style-src 'self' 'unsafe-inline' https://kit.thatsit.app`
    - `font-src https://kit.thatsit.app`
    - `img-src 'self' data: blob:`
    - `connect-src 'self' https://kit.thatsit.app`
    - `manifest-src 'self'`
    - `worker-src 'self'`
    - `base-uri 'none'`
    - `form-action 'none'`

    It also handles comments and multiple path blocks.
  - `test/build.test.ts` runs `vite build` once in `beforeAll` and checks:
    - `dist/manifest.webmanifest` parses and contains `title`;
    - `dist/index.html` contains no `%APP_` and no `__APPLE_TOUCH_ICON__`, and contains `data:image/png;base64,`, `https://kit.thatsit.app/kit.css` and `data-key="app:theme"`;
    - no file in `dist/assets/*.js` contains `lit-html` or `LitElement.prototype` source (Review Focus 2).
- [ ] **Step 2: Run `npx vitest run`.** Expect failures.
- [ ] **Step 3: Implement the plugin, `index.html`, `public/_headers` and `scripts/make-icons.ts`, then run `npm run icons`.**
  - `index.html` mirrors pi-web's `app/index.html` head: viewport with `viewport-fit=cover, interactive-widget=resizes-content`, light/dark `theme-color` `#f1f1f1`/`#171717`, the apple meta tags with title `%APP_TITLE%`, manifest link, icon links, touch-icon placeholder, the kit CSS link and theme-init.
  - Its body is `<app-main></app-main>` plus `/src/main.ts`.
  - `_headers` has the CSP above, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`, on `/*`.
- [ ] **Step 4: Run `npm test && npm run build`.** Expect a pass.
- [ ] **Step 5: Commit** with the message "App plugin: html, manifest, icons, headers".

### Task 3: Starter screen, service worker, e2e

**Files:**
- Create: `src/app-main.ts`, `public/sw.js`, `playwright.config.ts`, `e2e/app.spec.ts`
- Modify: `src/main.ts` (replace the placeholder)

**Interfaces:**
- Consumes: from the kit, `TkShell`, `TkHeader`, `TkSheet`, `TkToasts`, `sharedStyles`, `toast`, `trackViewport` (their attributes are `nav-label`, `menu-label`, `heading`, `open`; events `tk-close` and `tk-open-nav`). Also `__APP_TITLE__` from Task 2.
- Produces: `<app-main>` and the service worker cache name `"app-v1"`. The Phase 3 skill replaces the starter's `<section>` content and keeps the shell.

- [ ] **Step 1: Write the e2e tests** in `e2e/app.spec.ts`. Playwright's `webServer` runs `npm run build && npx vite preview --port 4317 --strictPort` on Chromium, at a 390×844 phone viewport and a 1280×800 desktop viewport. A `beforeEach` adds a `securitypolicyviolation` listener that records violations, and every test asserts the record is empty (Review Focus 3).
  - `renders the kit shell`: `tk-shell`, `tk-header` with the title "App template", a `.btn` "Open sheet" opening `tk-sheet` (whose `open` property becomes true, then false after `tk-close`), and a toast appearing after "Show toast".
  - `loads one Lit`: `globalThis.litElementVersions.length === 1`.
  - `matches the kit look`: the computed `background-color`, `font-family`, `border-radius` and `color` of the starter's primary `.btn`, and of `body`, equal those on `https://kit.thatsit.app/` (the kit demo page) at the same viewport and color scheme. Run it for `colorScheme: "light"` and `"dark"`.
  - `works offline after first load`: wait for `navigator.serviceWorker.controller`, call `context.setOffline(true)`, reload, then expect `tk-header` and the computed body font to include `Inter` (Review Focus 4).
  - `explains a missing kit`: `page.route("https://kit.thatsit.app/**", r => r.abort())` on a fresh context, then expect the text "Couldn't load the kit" (Review Focus 1).
- [ ] **Step 2: Run `npx playwright test`.** Expect failures.
- [ ] **Step 3: Implement `src/main.ts`.** It dynamically imports the kit and `./app-main.ts`. If that import fails, it replaces the body with a single `<p>` saying "Couldn't load the kit. Check your connection and reload." A static import can't be caught, so this is the reason for the dynamic import. On success it calls `trackViewport()`, and in `import.meta.env.PROD` it registers `/sw.js`.
- [ ] **Step 4: Implement `src/app-main.ts`.** The `LitElement` `app-main` mirrors pi-web's `pi-app` render (`app/src/components/pi-app.ts`, around line 83) and `kit/demo/index.html`:
  - `<tk-shell nav-label="Pages">` with a `nav` slot holding one `.u.on` link, "Home";
  - `<tk-header menu-label="Open menu">` with `__APP_TITLE__` in the `title` slot;
  - a `<section>` with one paragraph, "This app was made from the thatsit.app template.", plus "Open sheet" (`.btn`) and "Show toast" (`.btn.ghost`) buttons;
  - `<tk-sheet heading="Sheet">` and `<tk-toasts>`.

  Its styles are `sharedStyles` plus layout only (padding, gap, grid), with no colors.
- [ ] **Step 5: Implement `public/sw.js`.** It is pi-web's `app/public/sw.js` without push and notifications, with these changes:
  - `CACHE = "app-v1"`.
  - `SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"]`.
  - At install it also caches `KIT = ["kit.css", "kit.js", "lit.js", "theme-init.js"]` from `https://kit.thatsit.app/`, as `new Request(url, { mode: "cors" })`.
  - Requests to `https://kit.thatsit.app` are network first with a cached fallback, and every ok response is cached; this covers the fonts that `kit.css` pulls in.
  - Other cross-origin requests aren't touched. The rest stays as in pi-web: navigation, `/assets/` cache first, others network first.

  The header comment explains why the kit is network first (it's always-latest) and why the requests use CORS mode (an opaque response can't be checked with `res.ok`).
- [ ] **Step 6: Run `npm test && npx playwright test`.** Expect all to pass at both viewports and in both color schemes.
- [ ] **Step 7: Commit** with the message "Starter screen and offline service worker".

### Task 4: Deploy workflow and README

**Files:**
- Create: `scripts/preview-url.ts`, `test/preview-url.test.ts`, `.github/workflows/deploy.yml`, `README.md`

**Interfaces:**
- Produces: `previewUrl(output: string): string | null`, which returns the `Deployment alias URL:` link if present, else the `Take a peek over at` link, else `null`. The CLI reads stdin and prints the URL; with no URL it exits 1.

- [ ] **Step 1: Write the tests.** They use the real production output (`✨ Deployment complete! Take a peek over at https://45c4626d.thatsit-kit.pages.dev`), which gives the hash URL. The same output followed by `✨ Deployment alias URL: https://feat-foo-bar.app-template.pages.dev` gives the alias. Unrelated text gives `null`. Wrangler's emoji and ANSI color codes don't break parsing.
- [ ] **Step 2: Run them.** Expect a fail. Implement the parser, then rerun. Expect a pass.
- [ ] **Step 3: Write `.github/workflows/deploy.yml`.**
  - It runs on `push: branches [main]`, `pull_request`, and `workflow_dispatch`.
  - Permissions are `contents: read` and `pull-requests: write`. Concurrency is `deploy-${{ github.ref }}` with `cancel-in-progress: true` for PRs only.
  - Steps: checkout, setup-node 24 with npm cache, `npm ci`, `npm run typecheck`, `npm test`, `npx playwright install --with-deps chromium`, `npm run e2e`.
  - Then `NAME=$(node -p "require('./app.config.json').name")`, and the deploy with `--branch main` on push or `--branch "$HEAD_REF"` on PRs. `HEAD_REF` is passed through env; `${{ }}` is never interpolated into `run:`. The deploy uses `tee`, then `previewUrl` writes `url` to `$GITHUB_OUTPUT` and to the job summary.
  - For PRs only, the job edits the existing comment containing `<!-- thatsit-preview -->`, or creates one if none exists, using `gh api`. The comment body is "Preview: <url>" plus the commit short SHA.
  - When `CLOUDFLARE_API_TOKEN` is empty (a fork PR), the deploy and comment steps are skipped. A job-level `env` plus `if: env.CLOUDFLARE_API_TOKEN != ''` does this.
- [ ] **Step 4: Lint the workflow.** If `actionlint` is installed, run it. Otherwise run `npx --yes action-validator@0.6.0 .github/workflows/deploy.yml`. Expect no errors.
- [ ] **Step 5: Write `README.md`.** In about 40 lines it covers:
  - what the template is;
  - a new app: edit `app.config.json`, run `npm run icons`, and replace the `<section>` in `src/app-main.ts`;
  - the rules: kit only by URL, no custom colors or fonts, see https://kit.thatsit.app/;
  - how deploys and previews work;
  - the one-time setup per app: `cf pages create <name>` with production branch `main`, then attach the custom domain and the proxied CNAME, as was done for kit.thatsit.app.
- [ ] **Step 6: Run `npm test`, then commit** with the message "Deploy workflow with PR preview comments".

### Task 5: Publish and prove it end to end (controller, not a subagent)

These steps have outward-facing side effects. Michael approved them by approving this plan.

- [ ] **Step 1: Create the Pages project** `app-template` with production branch `main`, using `cf pages create`. It has no custom domain; `app-template.pages.dev` is the template's own live demo.
- [ ] **Step 2: Create and push the repo:** `gh repo create thats-it-dev/app-template --public --source ~/workspace/app-template --push`, then `gh repo edit thats-it-dev/app-template --template`.
- [ ] **Step 3: Watch the `main` run** with `gh run watch --exit-status`, then check `https://app-template.pages.dev`: it returns 200, carries the CSP header, and its `kit.js` script resolves.
- [ ] **Step 4: Open a throwaway PR** on branch `test/preview-comment` that changes the starter paragraph. Wait for its run, check that a single comment with a working alias URL is posted, push one more commit, and check that the same comment was edited rather than duplicated. Then close the PR and delete the branch.
- [ ] **Step 5: Run the side-by-side check from spec §Success 2.** Run the e2e `matches the kit look` test against `https://app-template.pages.dev` by setting `BASE_URL`; `playwright.config.ts` must honor it.
- [ ] **Step 6: Record the results** in the memory file `thatsit-app-deploy-skill`. Phase 3 (the pi skill) starts from there.
