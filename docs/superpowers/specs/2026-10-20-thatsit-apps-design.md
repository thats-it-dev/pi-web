# thatsit.app apps: pi builds and deploys PWAs that look like pi-web

Status: draft for Michael's review, 2026-10-20.

## Intent

Michael wants pi (the agent behind pi.thatsit.app) to build small web apps on request,
give each its own `<name>.thatsit.app` subdomain on Cloudflare Pages, and ship every
later change as a GitHub PR with a preview deployment link. Every app must look and feel
like pi-web: same fonts, colors, dark mode, buttons, sheets, toasts, header/sidebar
shell, and iOS viewport behavior. To make that cheap and consistent, pi-web's generic UI
layer becomes a shared kit that all apps import.

## Goals

- From a pi-web chat, "build me an app that does X" ends with X live at
  `<name>.thatsit.app`, installable as a PWA, visually indistinguishable in style from pi-web.
- Follow-up changes arrive as PRs on the app's repo with a working preview link that pi
  reports in chat and that is also posted on the PR.
- One shared kit, published at `https://kit.thatsit.app`, that apps import by URL.
- pi-web uses the same kit source, so pi-web and apps never drift apart.

## Non-goals

- Server-side code on Cloudflare (Pages Functions, D1, KV, Workers). Apps are static.
- A pi extension (custom tool or pi-web UI card) for deploying. A skill plus scripts is
  the first version; an extension may come later if a typed tool or link card is wanted.
- React or `@thatsit/ui`. The kit is Lit, matching pi-web.
- Public backends on the spark.

## Anti-goals (failure even if it "works")

- Apps that look like a generic template instead of pi-web.
- Any visible change to pi-web caused by extracting the kit.
- pi merging its own PRs or shipping to production after the first version.
- Cloudflare or GitHub tokens ending up in an app repo, a build artifact, or chat output.

## Decisions Michael made

- **Skill, not extension** (Claude recommended; Michael proceeded on it).
- **One GitHub repo per app**, owned by the **thats-it-dev** org, **public**. (The org is on
  GitHub Free; public repos can read org-level secrets.)
- **Match pi-web exactly**: share pi-web's own generic Lit components and styles, not just tokens.
- **Kit served from its own Pages site, kit.thatsit.app**, imported by URL. Accepted trade-off:
  a kit deploy changes every app at once (always-latest).
- **Kit source stays in pi-web** (a workspace next to `theme/`). pi-web bundles it from
  source, and CI publishes the same files to kit.thatsit.app.
- **Apps are static PWAs, always**: manifest, icons, service worker, theme-color.
- **Data, when needed, comes from** either (a) a service on the spark, reachable **over the
  tailnet only**, or (b) Bluesky/atproto via lexicons.
- **Tooling: `gh` and the new Cloudflare `cf` CLI** (`cf@1.0.0-beta.14`, installed on the
  spark) for projects, domains and DNS. **Exception (Michael, 2026-10-20):** cf beta.14 can't
  upload to classic Pages (`cf pages deploy` is a stub), so CI uploads with
  `wrangler pages deploy --project-name <name> --branch <branch>`. Wrangler is used for nothing else.
- **Deploys run in GitHub Actions** (wrangler upload, see above): push to `main` → production (app repos; pi-web and kit use `master`) at
  `<name>.thatsit.app`; each PR → preview deployment, link posted as a PR comment.
- **Scope**: all of it, in phases, each shippable: (1) kit + pi-web refactor + kit.thatsit.app,
  (2) app template, (3) pi skill, (4) spark client pattern and atproto module.
- **Autonomy**: pi creates the repo, Pages project and subdomain, and pushes the first
  version straight to `main`. After that every change is a PR; Michael merges.

## Design

### 1. The kit (`pi-web/kit`, package `@thatsit/kit`)

What moves out of `app/src` into the kit (generic layer only):

- Theme: `theme/theme.css` + fonts (keep `theme/` as is and have the kit include it, or
  fold it in, builder's call). `https://pi.thatsit.app/theme/theme.css` must keep working,
  since its README tells others to link it.
- App tokens from `app/src/styles/global.css` (`--panel`, `--line`, `--overlay`,
  `--radius`, `--sidebar-w`, `--safe-bottom`, base `html/body` rules). pi-web-specific rules
  such as the `pi-app` positioning stay in pi-web or become a generic shell rule.
- `app/src/styles/shared.ts` (`sharedStyles`: `.btn`, `.ghost`, `.seg`, `.u`, `.label`, `.dot`, inputs, focus, reduced motion).
- `components/pi-sheet.ts`, `components/pi-toasts.ts` + `lib/toast.ts`.
- The header and sidebar layout shell, made generic. Today's `pi-header`/`pi-sidebar` are
  bound to `SessionStore`; extract the layout (sticky header, tuck-on-scroll, mobile
  menu button, 280 px sidebar/drawer at the 899 px breakpoint) into generic elements,
  and have pi-web's versions compose them.
- `lib/viewport.ts` (iOS visible-area sizing, `--app-top`/`--app-h`, `data-keyboard`).
- `public/theme-init.js` (applies `data-theme` before first paint).

Element names are the builder's call. Keep pi-web's existing `pi-*` tags working in
pi-web. A neutral prefix for kit elements is suggested.

Publishing:

- Build the kit as ES modules plus CSS, and publish `.d.ts` types on kit.thatsit.app too.
  The template fetches the types at build/dev time (Claude's call), so apps never need
  pi-web checked out.
- **Kit API policy (Claude's call):** exported elements, attributes, CSS custom properties and
  module paths are additive-only. A breaking change means a new name, never a changed one.
  `kit.yml` runs a check that compares the published `.d.ts`/token list with the previous
  deploy and fails on removals.
- **Exactly one copy of Lit per page.** The kit must expose Lit (for example a
  `kit.thatsit.app/lit.js` re-export) so apps import Lit from the kit rather than bundling
  a second copy. The mechanism (import map or bare URL imports) is the builder's call.
- `_headers` on the kit site: `Access-Control-Allow-Origin: *` for modules, CSS and fonts;
  sensible caching (short max-age plus revalidation, since it's always-latest).
- A `kit.thatsit.app/README` or demo page showing every component, used by pi as reference.
- New workflow `pi-web/.github/workflows/kit.yml`: on push to `master` touching `kit/` or
  `theme/`, build and run `cf pages deploy` to the `kit` Pages project (custom domain
  kit.thatsit.app). This is pi-web's only Actions workflow. pi-web's own deploy stays on
  Cloudflare's Git integration as it is today (README "Deploy"). The repo reads the
  org-level CI secrets like the app repos (Claude's call).

pi-web refactor: pi-web imports the kit from the workspace (no URL import) and must look
and behave identically. Verify with the existing tests/typecheck/e2e and before/after
screenshots at phone and desktop widths, in light and dark.

### 2. App template (`thats-it-dev/app-template`, a GitHub template repo)

- Vite + Lit + TypeScript; imports the kit by URL from kit.thatsit.app.
- A starter screen that already uses the kit shell, header, a sheet, toasts and buttons, so
  a new app looks right before pi writes any feature code.
- PWA: `manifest.webmanifest`, icons (generated per app like pi-web's `scripts/make-icons.mjs`),
  `apple-touch-icon`, light/dark `theme-color` meta, `sw.js` modeled on pi-web's. The service
  worker must cache the cross-origin kit files so an installed app opens offline.
- `_headers` (CSP allowing kit.thatsit.app and, when used, the spark tailnet host and atproto hosts).
- `.github/workflows/deploy.yml` using `cf` (installed from npm in CI):
  - push to `main` → production deploy of the `<name>` Pages project;
  - `pull_request` → preview deploy, then `gh` posts (or updates one existing) PR comment
    with the preview URL.
  - Secrets: org-level `CLOUDFLARE_API_TOKEN` (Pages edit only) and `CLOUDFLARE_ACCOUNT_ID`.
- Optional pieces the skill adds only when needed:
  - **atproto**: browser OAuth (`@atproto/oauth-client-browser`), `client-metadata.json`
    served from the app's own origin, lexicon types generated in-repo. Login must work on
    PR previews too (Claude's call): CI writes `client-metadata.json` for the deploy's
    stable branch alias URL (`<branch>.<name>.pages.dev`), so each preview is its own
    valid client_id. The skill reports that alias URL as the preview link.
  - **spark**: a small fetch client for a configured tailnet URL. It shows a clear "only
    works on the tailnet" state when the request fails.

### 3. Spark backends (tailnet only)

- Spark services that apps use are exposed with `tailscale serve` (HTTPS on the `ts.net`
  name), never through the public tunnel. Same stance as the watch API: tailnet identity only.
- Each such service must answer CORS for `https://<name>.thatsit.app` and that project's
  `*.pages.dev` preview origins.
- This path is already proven: pi.thatsit.app is public on Pages and calls the hub at its
  `ts.net` address (`hub/src/config.ts`). Copy the hub's CORS/preflight handling as the
  pattern for spark services. Don't redesign it.
- v1 builds the client pattern into the template, not a specific spark service.

### 4. The pi skill (`thatsit-app`)

Lives in the pi-web repo at `skills/thatsit-app/` (Claude's call), symlinked into
`~/.pi/agent/skills/`. It contains `SKILL.md` plus scripts.

- **New app**: choose a short name and check it's free (Pages project list and the
  thatsit.app DNS zone). Then `gh repo create thats-it-dev/<name> --template
  thats-it-dev/app-template`, `cf pages create <name>`, and attach the custom domain
  `<name>.thatsit.app` (creating the DNS record if `cf` doesn't do it). Build the first
  version, push to `main`, wait for the workflow, and report the production link in chat.
- **Change**: branch, commit, open a PR with `gh`, wait for the deploy check, report
  the preview link in chat. Never merge.
- **Style rules**: use kit components and tokens; no custom colors or fonts outside the
  tokens; nothing that would look out of place next to pi-web. Point at the kit demo page.
- **Discovering `cf` commands**: `cf cli search "<task>"`, then `<cmd> --help`. Keep search
  queries free of names, domains and IDs (the CLI asks for this).
- Secrets are never printed or written into repos.

### 5. One-time setup (Michael, with pi's help)

- Cloudflare API token(s): one for the spark's `cf` (Pages edit, DNS edit on the
  thatsit.app zone), one for CI (Pages edit). `cf auth login` or a profile on the spark.
- Org secrets on thats-it-dev for the CI token and account ID (public repos can read them on Free).
  `pull_request` workflows get the secrets for same-repo branches, which is how pi works;
  fork PRs get no deploy (fine).
- Create the `kit` Pages project + kit.thatsit.app domain; create `app-template` and mark it a template.

## Success

1. pi-web looks and behaves unchanged after the kit extraction.
2. kit.thatsit.app serves the kit; a blank template app deployed from it matches pi-web side by side.
3. Asking pi for a new app yields a working PWA at `<name>.thatsit.app` in one session.
4. Asking for a change yields a PR with a preview link that works and appears in chat and on the PR.

## Left to the builder

Kit element names and file layout; exact build tooling for the kit; how apps resolve Lit
from the kit; caching values; the template's starter screen; how the skill waits for CI;
whether `theme/` folds into `kit/`.
