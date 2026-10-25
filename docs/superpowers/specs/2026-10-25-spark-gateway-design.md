# Spark gateway for thatsit.app apps (Phase 4a)

Phase 4 of `2026-10-20-thatsit-apps-design.md`, spark half. The atproto half (4b) gets
its own design later (Michael, 2026-10-25).

## Intent

Some apps pi builds on thatsit.app need data that a static page can't hold: model and
GPU stats, pi sessions, or data the app saves for Michael. Today each such app would
need its own server. Instead there is **one shared gateway** on the spark that every app
talks to, reachable over the tailnet only. pi extends it by PR the same way it changes
apps, and Michael merges.

Success: pi can build "a page that shows which model is loaded and the GPU load" or
"a reading list that saves on the spark" with no new server, and an app PR that needs a
new gateway route has a working preview before anything is merged.

## Goals

- One gateway service, one `tailscale serve` entry, one place for CORS and auth.
- A built-in per-app key-value store, so simple saving apps need no backend code.
- Read-only built-in endpoints for system data (llama-swap models, GPU/memory, pi sessions).
- Per-app route modules for anything else, added by PR.
- Auto-deploy on merge, with rollback-by-default when tests fail.
- A preview gateway per open gateway PR, so app previews work before merge.
- Template + skill support: a gateway client, an "only works on the tailnet" state, and
  the two-PR flow (app PR + gateway PR).

## Non-goals

- Anything reachable from the public internet. No tunnel, no Cloudflare route.
- Actions on the spark: no shell, no process control, no loading/unloading models, no
  restarting services (Michael, 2026-10-25: "Read + app data only"). Later, case by case.
- Multi-user accounts. Tailnet identity of Michael's login is the only identity.
- atproto (Phase 4b).

## Anti-goals (failure even if it works)

- One app able to read or write another app's data.
- A website Michael visits (not a thatsit.app app) being able to use the gateway because
  his browser carries the ambient tailnet identity.
- A failed deploy taking the running gateway down.
- pi merging gateway PRs or deploying the gateway itself.
- Secrets or tokens in the gateway repo, app repos, or chat.

## Decisions Michael made (2026-10-25)

- **First use is generic:** "several of these" (models/GPU, pi sessions, a data store), so
  build the pattern, not one app.
- **One shared gateway** with one route section per app, not one service per app.
- **Repo:** `thats-it-dev/spark-gateway`, **private**. App repos stay public.
- **Deploy:** auto-pull on merge; tests must pass before restart, else the old version keeps running.
- **Scope of routes:** read system stats, read/write the app's own store. Nothing else.
- **Previews:** a preview gateway instance per open gateway PR, own tailnet address/path,
  own copy of data, removed when the PR closes; the app's PR preview points at it.
- **Stack (Claude's guesses, Michael confirmed):** Node/TypeScript like the hub, SQLite
  store, read-only built-ins for llama-swap and pi sessions.

## Design

### 1. The gateway service

- Node 24 + TypeScript run directly (`node --experimental-strip-types` style, as the hub
  does), `node:http`, `node:sqlite`. No framework (Claude's call: matches the hub).
- Runs as a systemd **user** service on the spark (like `pi-web-hub.service`), bound to
  `127.0.0.1` on a free port, exposed with `tailscale serve --https=<port>` on
  `spark-713a.tail9274fa.ts.net`. Ports in use today: 443→11000, 2283, 7878 (hub), 8787,
  9119. Builder picks a free one (e.g. 9443) and records it in the repo README.
- **Auth, copied from the hub (`pi-web/hub/src/auth.ts`):** every request must have
  `Host` (or `X-Forwarded-Host`) equal to the tailnet host:port, and
  `Tailscale-User-Login` equal to Michael's login. The identity header is ambient (any
  page in his browser could trigger it), so the **Origin check is what makes it safe**:
  - Production origin `https://<app>.thatsit.app` → app namespace `<app>`.
  - Preview origins `https://<branch>.<pages-subdomain>.pages.dev` and
    `https://<hash>.<pages-subdomain>.pages.dev` → app namespace `<app>`, where
    `<pages-subdomain>` is the Pages project's `subdomain` (it can differ from the name,
    e.g. `app-template-930`).
  - The origin→app map is generated from the apps that exist (builder's call how: a
    config file the skill updates via the gateway PR, or a lookup the gateway refreshes).
    Unknown origin → 403, no CORS headers.
  - An app may only call `/apps/<its-own-name>/...` and the read-only `/system/...`
    endpoints. `/apps/<other>/...` → 403. This is the cross-app isolation guarantee.
  - CORS: echo the allowed origin, `GET, POST, PUT, DELETE, OPTIONS`, header
    `content-type`, `vary: Origin`; preflight answered without auth side effects.
- Errors are JSON `{ "error": "<message>" }` with a proper status; nothing echoes headers back.

### 2. Built-in endpoints

All `GET`, read-only, JSON, `cache-control: no-store`.

- `/system/models` — from llama-swap on `127.0.0.1:9000`: `/v1/models` (ids, status)
  merged with `/running` (which is loaded, state). Never expose the `cmd` field.
- `/system/gpu` — GPU name and utilization from `nvidia-smi`; the spark's GB10 reports
  memory as `[N/A]`, so memory comes from `/proc/meminfo` (unified memory). Builder's
  call on exact fields; document them.
- `/system/sessions` — recent pi sessions: id, name, cwd, last activity, and running
  state where known. Builder's call whether to read `~/.pi/agent/sessions` directly or
  call the hub's `/api/sessions` locally; never return message contents.
- `/health` — version (git SHA) and uptime, no auth beyond Host/login.

### 3. Per-app store

- One SQLite database for the production gateway; table keyed by `(app, collection, id)`
  with a JSON value and `updated_at`. Size limits (builder's call, e.g. 256 KB per value,
  50 MB per app) with a clear 413.
- Routes: `GET /apps/<app>/kv/<collection>` (list, paginated), `GET|PUT|DELETE
  /apps/<app>/kv/<collection>/<id>`. `<app>` comes from the URL and **must equal** the
  origin's app.
- Backups: a daily copy of the database file, keep 14 (builder's call on location under
  `~/.local/share/spark-gateway/`).

### 4. Per-app route modules

- `apps/<name>/routes.ts` in the gateway repo, registered under `/apps/<name>/`. A
  module gets a narrow context: its app's store, the read-only system data functions,
  and `fetch` limited to `127.0.0.1` services that the built-ins already use. It does not
  get `child_process`, raw fs, or other apps' stores (enforced by review and a test that
  greps modules for forbidden imports; Claude's call: a lint-style test is enough here,
  since Michael reviews every PR).
- Each module ships with tests run by the gateway's `npm test`.

### 5. Deploy on merge

- A systemd user timer (e.g. every minute) or webhook (builder's call; timer is simpler
  and needs no public ingress) checks `origin/main`. On a new SHA: fetch into a staging
  checkout, `npm ci`, `npm test`. Only if green: swap it in and restart the service, then
  check `/health` reports the new SHA. If tests fail or health check fails: keep or
  restore the previous version and record the failure where pi and Michael can see it
  (e.g. a commit status on the SHA via `gh`, plus the journal).
- Migrations: schema changes run at startup, additive only.

### 6. Preview gateways

- For each open gateway PR, the spark runs a preview instance of that PR's head: its own
  port or path on the tailnet host (builder's call), its own copy of the production
  database taken when the preview starts (so previews never write production data).
- The same deploy loop starts, updates and stops previews (on push to the PR, on
  close/merge). The preview's address is posted as a sticky PR comment on the gateway
  PR, like app previews.
- Preview instances accept the origins of the apps in the PR head's `apps.json`.
- **Preview data (Michael, 2026-10-25): a copy of real data**: a snapshot of production
  data for the apps the PR touches, taken when the preview starts. Preview writes never
  reach production; the snapshot is deleted with the preview.

### 7. Template and skill

- **Template (`app-template`):** add an optional `src/gateway.ts` client: base URL from
  build-time config (production gateway by default; overridden for an app PR whose
  preview should use a gateway preview), `get/put/del` helpers for the store, typed JSON
  errors. When the request fails at the network level (off the tailnet), show a clear
  kit-styled "This app only works on the tailnet" state instead of a broken page. The CSP
  in `_headers` allows the gateway origin(s) only for apps that use it.
- **How an app PR finds its gateway preview:** the app PR body names the gateway PR
  (e.g. `Gateway: thats-it-dev/spark-gateway#12`); the app's CI builds the preview with
  that preview gateway URL. Builder's call on mechanism, but it must not require secrets
  beyond the existing org ones (the gateway repo is private, so CI may need a read token;
  if so, flag it to Michael instead of creating one).
- **Skill (`thatsit-app`):** a "Needs spark data" section: use built-ins or the store
  when they fit (no gateway PR); otherwise write the route module + tests in a checkout
  of `spark-gateway`, open a gateway PR first, then the app PR pointing at it, and reply
  with both PR links and the app preview. The CLI gains the commands this needs
  (`gateway-pr` or similar); pi still never merges. The new-app flow registers the app's
  origins with the gateway (via a gateway PR) only when the app uses the gateway.

## Proof

- Real pi run: a small "spark status" app using `/system/models` and `/system/gpu`,
  shipped at `<name>.thatsit.app` and working on Michael's phone on the tailnet, showing
  the tailnet-only state off it.
- Real pi run: a change that needs a custom route, producing a gateway PR with a
  preview and an app PR whose preview works against it, before merge.
- Tests prove: wrong Origin → 403; app A calling `/apps/B/...` → 403; preview writes
  don't touch production data; a failing merge doesn't restart the service.

## Claude's calls after the builder check (2026-10-25)

- **Origin map lives in the gateway repo** as `apps.json`: `[{ name, pagesSubdomain }]`.
  The gateway derives the allowed origins from it (`https://<name>.thatsit.app`,
  `https://*.<pagesSubdomain>.pages.dev`). A preview gateway uses the `apps.json` in its
  own PR head, so a brand-new app's first gateway PR adds its entry and the app preview
  works against that preview gateway before merge.
- **Preview addressing is deterministic:** gateway PR #N is served at
  `https://spark-713a.tail9274fa.ts.net:<base+N>` (e.g. base 9500; builder picks a range
  that is free and documents it). The deploy loop adds and removes the `tailscale serve`
  entries itself: the spark's Tailscale `OperatorUser` is `michael`, so no sudo is
  needed. The app's CI derives the preview gateway URL from the PR number in the app PR
  body (`Gateway: thats-it-dev/spark-gateway#N`), so app CI needs **no** token for the
  private repo.
- **Credentials:** the deploy loop uses the spark's existing `gh` login (Michael's
  account) to list PRs, post commit statuses and sticky preview comments. No new token.
- **The gateway repo has its own GitHub Actions CI** (`npm test` on PRs and `main`). The
  spark runs a preview only for a PR head whose tests pass locally too.
- **Checkouts are separate:** pi works in `~/workspace/apps/spark-gateway` and pushes
  branches only through the CLI; the deploy loop uses its own directories under
  `~/.local/share/spark-gateway/` (production, staging, previews). pi never touches those.
- **Store API:** values are any JSON object; ids are `[A-Za-z0-9_-]{1,128}`, collections
  `[a-z0-9-]{1,64}`; list is newest-first with a `cursor`. Types live in the template's
  `src/gateway.ts`.

## Left to the builder

Port, timer vs webhook, origin map mechanism, preview addressing, exact system fields,
store limits, backup location, CLI command names. Each choice goes in the gateway README.
