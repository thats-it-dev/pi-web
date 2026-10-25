# Spark Gateway (Phase 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tailnet-only gateway on the spark that thatsit.app apps call for system stats and per-app saved data, extended by PR, auto-deployed on merge, with a preview instance per gateway PR; plus template and skill support.

**Architecture:** A Node service (`thats-it-dev/spark-gateway`, private) with no framework: origin-bound auth copied from the pi-web hub, a SQLite key-value store namespaced per app, read-only `/system/*` built-ins, and per-app route modules. A deployer run by a systemd timer pulls `main` into a new release, tests it, swaps a `current` symlink and restarts; the same deployer runs one preview instance per open PR on port `9500+N`. The app template gains an opt-in gateway client and CI that points PR previews at a gateway preview; the `thatsit-app` skill gains a gateway PR flow.

**Tech Stack:** Node 26 (type-stripping, `node:http`, `node:sqlite`, `node:test`), TypeScript 5.9 typecheck only, systemd user units, `tailscale serve`, `gh`, GitHub Actions. Template: Vite + Lit (existing).

**Spec:** `docs/superpowers/specs/2026-10-25-spark-gateway-design.md` (parent: `docs/superpowers/specs/2026-10-20-thatsit-apps-design.md`).

## Global Constraints

- Tailnet only. Nothing is exposed through Cloudflare or the public tunnel.
- Routes may read system stats and read/write **their own app's** store. No `child_process`, no raw fs, no process control in routes or built-ins beyond the fixed readers in Task 3.
- Every non-`OPTIONS`, non-`/health` request needs: `Host` or `X-Forwarded-Host` == configured hostname, `Tailscale-User-Login` == configured login, and an `Origin` that maps to an app in `apps.json`. Unknown origin → 403 with no CORS headers.
- An app may call only `/apps/<its-own-name>/...` and `/system/...`; `/apps/<other>/...` → 403.
- `/health` needs no auth at all (deviation from the spec's "Host/login" wording, Claude's call: the deployer health-checks it on `127.0.0.1` without the tailnet identity header; it returns only `{version, uptimeSeconds}`).
- Error bodies are `{ "error": "<message>" }`; every JSON response has `cache-control: no-store`; nothing echoes request headers back.
- Ids `^[A-Za-z0-9_-]{1,128}$`, collections `^[a-z0-9-]{1,64}$`, values are JSON objects, max 256 KiB per value, 50 MiB per app → 413.
- Production: tailnet `https://spark-713a.tail9274fa.ts.net:9443` → `127.0.0.1:19443`. Preview for PR #N: `:${9500+N}` → `127.0.0.1:${19500+N}`; N must be 1–499, otherwise no preview (comment says so).
- Paths on the spark: config `~/.config/spark-gateway/config.json` (`{ hostname, allowedLogin }`, mode 0600, never in the repo); everything else under `~/.local/share/spark-gateway/` (`releases/<sha>/`, `current` → symlink, `previews/<N>/`, `data/gateway.db`, `data/previews/<N>.db`, `backups/`, `deploy-state.json`).
- Only the existing `gh` login on the spark is used. No new tokens are created; if one turns out to be needed, stop and tell Michael.
- pi never merges and never touches `~/.local/share/spark-gateway/`.
- Tests: `node --test --test-concurrency=1 test/*.test.ts`; typecheck `tsc -p tsconfig.json`. Pinned versions as in pi-web hub: `typescript` 5.9.3, `@types/node` 26.6.5. No runtime dependencies.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A page on some non-thatsit.app site triggering a request with Michael's ambient tailnet identity → 403 (Task 1 test `foreign origin is refused`).
2. `Origin: https://evil.tips-abc.pages.dev.attacker.com` or `https://a.b.tips-abc.pages.dev` (lookalike or nested preview hosts) → refused; only one label before `<pagesSubdomain>.pages.dev` (Task 1 test `lookalike origins are refused`).
3. A merge that breaks `npm test`, or starts but fails `/health` → previous release keeps serving, commit status `failure` (Task 5 tests).
4. A preview write never lands in `data/gateway.db` (Task 6 test `preview writes stay in the snapshot`).
5. An app off the tailnet (fetch rejects) shows the tailnet-only state, not a blank page; an HTTP 4xx/5xx is an error, not "off the tailnet" (Task 7 tests).

---

## Repos and checkouts

- Gateway build checkout: `~/workspace/spark-gateway` (Tasks 1–6). pi's own checkout later is `~/workspace/apps/spark-gateway` (created by the CLI in Task 8).
- Template: `~/workspace/app-template`, branch `feat/gateway-client` (Task 7), shipped as a PR.
- Skill: pi-web worktree, branch `feat/gateway-skill` (Task 8).

### Task 0 (controller): create the gateway repo

- [ ] `gh repo create thats-it-dev/spark-gateway --private --description "Tailnet-only backend for thatsit.app apps"`; clone to `~/workspace/spark-gateway`; set clone-local git identity from `gh api user` (same rule as the skill: name||login, `<id>+<login>@users.noreply.github.com`); initial commit with `README.md`, `.gitignore` (`node_modules`, `*.db`), push `main`; create branch `feat/gateway` for Tasks 1–6.

### Task 1: Server skeleton, config, origin map, auth, CORS, /health

**Files:**
- Create: `package.json`, `tsconfig.json`, `apps.json` (`[]`), `src/main.ts`, `src/config.ts`, `src/origins.ts`, `src/auth.ts`, `src/http.ts`, `src/server.ts`
- Test: `test/origins.test.ts`, `test/auth.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces:
  - `type AppEntry = { name: string; pagesSubdomain: string }`
  - `loadApps(path: string): AppEntry[]` — validates names with the template's NAME rule `^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$` and `pagesSubdomain` with the same charset (≤63); throws on duplicates.
  - `appForOrigin(apps: AppEntry[], origin: string | undefined): string | undefined`
  - `type GatewayConfig = { port: number; hostname: string; allowedLogin: string; dbPath: string; appsPath: string; version: string }`; `loadConfig(env = process.env): GatewayConfig` — reads `~/.config/spark-gateway/config.json` (path overridable by `GATEWAY_CONFIG`), with `PORT`, `GATEWAY_HOSTNAME`, `GATEWAY_DB`, `GATEWAY_APPS`, `GATEWAY_VERSION` env overrides (previews use these). Exits with a clear message if hostname or login is missing.
  - `checkRequest(cfg, apps, headers): { ok: true; app: string } | { ok: false; status: 403; reason: string }`
  - `corsHeaders(origin: string): Record<string,string>` — `GET, POST, PUT, DELETE, OPTIONS`, `content-type`, max-age 600, `vary: Origin`.
  - `sendJson(res, status, body, cors)` (as hub), `readJson(req, maxBytes): Promise<unknown>` (413 on overflow, 400 on bad JSON).
  - `type Route = (req: GatewayRequest) => Promise<{ status: number; body: unknown } | undefined>` where `GatewayRequest = { method: string; path: string; query: URLSearchParams; app: string; body(): Promise<unknown> }`; `createServer(cfg, deps: { routes: Route[] }): http.Server` — tries routes in order, 404 `{error:"not found"}` if none answers.
- `apps.json` is re-read when its mtime changes (no restart needed when a merge only edits it, though the deployer restarts anyway).

- [ ] **Step 1: Write failing tests**
  - `origins.test.ts`, with apps `[{name:"tips",pagesSubdomain:"tips-abc"}]`: `https://tips.thatsit.app` → `"tips"`; `https://tips-abc.pages.dev` → `"tips"`; `https://feat-x.tips-abc.pages.dev` → `"tips"`; `https://1a2b3c4d.tips-abc.pages.dev` → `"tips"`; test `lookalike origins are refused`: `http://tips.thatsit.app`, `https://tips.thatsit.app:8443`, `https://a.b.tips-abc.pages.dev`, `https://x.tips-abc.pages.dev.attacker.com`, `https://tips.thatsit.app.attacker.com`, `https://other.thatsit.app`, `null`, `undefined` → `undefined`. `loadApps` rejects a duplicate name and a bad name.
  - `auth.test.ts`: right host+login+origin → `{ok:true, app:"tips"}`; `X-Forwarded-Host` accepted; wrong login, missing login, wrong host → 403; test `foreign origin is refused`: `Origin: https://example.com` → 403.
  - `server.test.ts` (real server on port 0): `OPTIONS` from a known origin → 204 with `access-control-allow-origin` echoed; `OPTIONS` from unknown origin → 403 and no `access-control-*` headers; `GET /health` with no headers → 200 `{version, uptimeSeconds}`; `GET /nope` authed → 404 JSON with `cache-control: no-store`; unauthed `GET /system/models` → 403 `{error}` with no CORS headers.
- [ ] **Step 2:** `npm test` → FAIL (modules missing).
- [ ] **Step 3:** Implement. Copy the hub's Host/login logic and its comment on why Origin is the safety check (`pi-web/hub/src/auth.ts`). Origin parsing: `new URL`, require `protocol === "https:"`, empty `port`, and host equal to `<name>.thatsit.app`, `<sub>.pages.dev`, or `<label>.<sub>.pages.dev` with `label` matching `^[a-z0-9-]{1,63}$`. `/health` and preflight skip the login check; preflight still requires a known origin. `src/main.ts` wires config, the routes from Tasks 2–4 (empty list for now) and listens on `127.0.0.1:${port}`.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `Gateway skeleton: origin-bound auth, CORS, health`.

### Task 2: Per-app key-value store

**Files:**
- Create: `src/store.ts`, `src/routes/kv.ts`
- Modify: `src/main.ts` (register kv route)
- Test: `test/store.test.ts`, `test/kv-route.test.ts`

**Interfaces:**
- Consumes: `Route`, `GatewayRequest` (Task 1).
- Produces:
  - `class Store { constructor(dbPath: string); get(app, collection, id): { value: object; updatedAt: string } | undefined; put(app, collection, id, value: object): { updatedAt: string }; delete(app, collection, id): boolean; list(app, collection, opts: { limit?: number; cursor?: string }): { items: { id: string; value: object; updatedAt: string }[]; cursor?: string }; appBytes(app): number; close(): void }` — table `kv(app, collection, id, value TEXT, updated_at TEXT, PRIMARY KEY(app, collection, id))`; schema created at open, additive only. List is newest `updated_at` first, ties by id; `limit` default 50, max 200; cursor is opaque (base64url of `updatedAt|id`).
  - `type AppStore = { get(collection, id); put(collection, id, value); delete(collection, id); list(collection, opts) }` and `store.forApp(app): AppStore` — the only handle route modules get (Task 4).
  - `kvRoute(store: Store): Route` handling `GET /apps/<app>/kv/<collection>`, `GET|PUT|DELETE /apps/<app>/kv/<collection>/<id>`.
  - `class StoreError extends Error { status: 400 | 413 }` thrown for bad ids, collections, non-object values and size limits; the server maps it to that status.
- Also: `GatewayRequest.app` vs URL `<app>` mismatch → 403 `{error:"this app may only use /apps/<own>/"}` — enforced in the server for every `/apps/*` path, before any route runs.

- [ ] **Step 1: Write failing tests**
  - `store.test.ts` (temp dir db): put/get roundtrip; `put` replaces and bumps `updatedAt`; `delete` returns true then false; list order newest-first and cursor paging over 5 items with limit 2 returns 2,2,1 and no cursor at the end; app isolation: `put("a",…)` invisible to `get("b",…)`; bad id `"../x"`, id of 129 chars, collection `"Notes"` → `StoreError` 400; value `[]`, `"x"`, `null` → 400; value over 256 KiB → 413; app over 50 MiB (set a tiny limit via constructor option `{ maxAppBytes }` in the test) → 413.
  - `kv-route.test.ts` (server + temp db, origin `https://tips.thatsit.app`): `PUT /apps/tips/kv/notes/n1` `{text:"hi"}` → 200 `{updatedAt}`; `GET` → 200 `{value:{text:"hi"},updatedAt}`; `GET` missing → 404; `DELETE` → 200 `{deleted:true}`; list → `{items, cursor?}`; `GET /apps/other/kv/notes` from tips origin → 403; malformed JSON body → 400.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement with `node:sqlite` `DatabaseSync`, prepared statements, WAL mode. Size check on the UTF-8 byte length of `JSON.stringify(value)`.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `Per-app key-value store`.

### Task 3: Read-only system built-ins

**Files:**
- Create: `src/system/models.ts`, `src/system/gpu.ts`, `src/system/sessions.ts`, `src/routes/system.ts`
- Modify: `src/main.ts`
- Test: `test/system.test.ts` (fixtures under `test/fixtures/`)

**Interfaces:**
- Produces (each takes injectable sources so tests use fixtures):
  - `getModels(fetchJson: (url: string) => Promise<unknown> = …): Promise<{ models: { id: string; status: string; loaded: boolean; state?: string }[] }>` — merges `http://127.0.0.1:9000/v1/models` (`data[].id`, `data[].status.value`) with `http://127.0.0.1:9000/running` (`running[].model`, `.state`). **Never** includes `cmd`, `proxy` or any other field. llama-swap down → 503 `{error:"llama-swap is not reachable"}`.
  - `getGpu(deps: { smi: () => Promise<string>; meminfo: () => Promise<string> }): Promise<{ gpus: { name: string; utilizationPercent: number | null }[]; memory: { totalBytes: number; availableBytes: number } }>` — `smi` runs `nvidia-smi --query-gpu=name,utilization.gpu --format=csv,noheader,nounits` via `execFile` with a 3 s timeout (the only process call in the codebase, fixed args); `[N/A]` → null; memory from `/proc/meminfo` `MemTotal`/`MemAvailable` (kB × 1024).
  - `getSessions(dir = ~/.pi/agent/sessions, limit = 20): Promise<{ sessions: { id: string; cwd: string; name?: string; model?: string; startedAt: string; lastActivityAt: string }[] }>` — for each `*.jsonl` in each subdirectory, newest mtime first: header line `{type:"session", id, timestamp, cwd}`, last `model_change.modelId`, last `session_info` name if present, `lastActivityAt` = file mtime. Reads at most the first line plus scans for those two record types; never returns message text.
  - `systemRoute(deps): Route` for `GET /system/models`, `/system/gpu`, `/system/sessions`.

- [ ] **Step 1: Write failing tests** — fixtures copied from the spark (`/v1/models`, `/running` with a `cmd` field, `nvidia-smi` output `NVIDIA GB10, [N/A]`, a meminfo sample, a sessions dir with two session files containing a `message` record with text `SECRET-TEXT`). Assertions: models merged with `loaded:true` only for the running one and `JSON.stringify(result)` not containing `cmd`, `proxy` or `bash`; gpu `utilizationPercent: null` for `[N/A]` and memory bytes computed; sessions newest first, model from last `model_change`, and `JSON.stringify(result)` not containing `SECRET-TEXT`; route returns 503 JSON when `fetchJson` rejects.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npm test && npm run typecheck` PASS.
- [ ] **Step 5:** Commit `Read-only system endpoints`.

### Task 4: Per-app route modules

**Files:**
- Create: `src/modules.ts`, `apps/README.md` (how to write a module), `apps/example/routes.ts` + `apps/example/routes.test.ts` (example app `example`, not in `apps.json`, so unreachable in production), `test/modules.test.ts`, `test/forbidden-imports.test.ts`
- Modify: `src/main.ts`, `package.json` test script to also run `apps/*/*.test.ts`

**Interfaces:**
- Consumes: `AppStore` (Task 2), `getModels`/`getGpu`/`getSessions` (Task 3), `Route` (Task 1).
- Produces:
  - Module contract (in `apps/README.md`): `export default function routes(ctx: AppContext): AppRoute[]` where `type AppContext = { app: string; store: AppStore; system: { models(): …; gpu(): …; sessions(): … } }` and `type AppRoute = { method: "GET" | "POST" | "PUT" | "DELETE"; path: string /* relative, e.g. "/summary", ":param" segments allowed */; handle(req: { params: Record<string,string>; query: URLSearchParams; body(): Promise<unknown> }): Promise<{ status?: number; body: unknown }> }`.
  - `loadModules(appsDir: string, apps: AppEntry[], ctxFor: (app: string) => AppContext): Promise<Route>` — imports `apps/<name>/routes.ts` for each name in `apps.json` that has one, mounts at `/apps/<name>/<path>`; `/apps/<name>/kv/...` stays reserved for the store (a module path starting with `/kv` → load error). A module that throws at load → gateway logs it and serves the others; its paths answer 500 `{error:"module <name> failed to load"}`. A handler throw → 500 `{error:"internal error"}` (details only in the journal).
- `forbidden-imports.test.ts` scans `apps/**/*.ts` (excluding `*.test.ts`) and fails on imports of `node:child_process`, `child_process`, `node:fs`, `fs`, `node:fs/promises`, `node:net`, `node:worker_threads`, `node:vm`, `node:module`, and any import path containing `../` that leaves the module's own folder or reaches `src/store`/`src/system`, and on uses of `process.env`, `eval(`, `new Function(`, dynamic `import(`.

- [ ] **Step 1: Write failing tests** — `modules.test.ts`: with apps `[{name:"example",…}]` and the example module, `GET /apps/example/summary` returns the example's body; `:param` matching; a module whose path starts with `/kv` fails to load; a module that throws at import makes only its own paths 500; handler throw → 500 `{error:"internal error"}`; module for an app not in `apps.json` is not mounted. `forbidden-imports.test.ts` passes on the real tree and fails on a temp fixture importing `node:child_process` (test the scanner function `findForbidden(dir): string[]` directly).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `Per-app route modules`.

### Task 5: Production deployer

**Files:**
- Create: `src/deploy/main.ts` (entry for the timer), `src/deploy/production.ts`, `src/deploy/exec.ts`, `src/deploy/state.ts`, `src/backup.ts`, `systemd/spark-gateway.service`, `systemd/spark-gateway-deploy.service`, `systemd/spark-gateway-deploy.timer`, `systemd/spark-gateway-preview@.service`, `scripts/install.sh`
- Test: `test/deploy-production.test.ts`, `test/backup.test.ts`

**Interfaces:**
- Produces:
  - `type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>` (real one in `exec.ts`, stdin closed).
  - `deployProduction(deps: { exec: Exec; root: string; repo: string; fetchHealth: (port: number) => Promise<{ version: string } | undefined>; now: () => Date }): Promise<{ action: "none" | "deployed" | "failed"; sha?: string; reason?: string }>` — steps: `git ls-remote <repo> refs/heads/main` → sha; if sha equals `state.productionSha` or `state.failedSha` → `none`. Else `git clone --depth 1` into `releases/<sha>`, `npm ci`, `npm test` (timeout 10 min). Fail → status `failure`, record `failedSha`, keep `current`. Pass → point `current` at it atomically (`symlink` to temp + `rename`), `systemctl --user restart spark-gateway`, poll `fetchHealth(19443)` up to 30 s for `version === sha`. Health fail → point `current` back at the previous release, restart again, status `failure`. Success → status `success`, record `productionSha`, delete releases except current and previous.
  - Commit status: `gh api repos/thats-it-dev/spark-gateway/statuses/<sha> -f state=<pending|success|failure> -f context=spark-deploy -f description=<≤140 chars>`.
  - `backupDaily(db: string, dir: string, now: Date, keep = 14): string | undefined` — `VACUUM INTO backups/gateway-YYYY-MM-DD.db` once per day, prune to 14.
  - `deploy/main.ts`: runs `deployProduction`, then `backupDaily`, then `syncPreviews` (Task 6; a no-op stub here). Exits 0 even on a failed deploy (the timer keeps running); logs one line per action.
- systemd: `spark-gateway.service` runs `%h/.local/bin/node src/main.ts` in `WorkingDirectory=%h/.local/share/spark-gateway/current`, `Environment=PORT=19443 GATEWAY_VERSION=…` (version read from `current`'s `git rev-parse HEAD` at start by `main.ts` when `GATEWAY_VERSION` is unset), `Restart=always`, same PATH line as `pi-web-hub.service`. Timer: `OnUnitActiveSec=60s`, `OnBootSec=60s`. The deploy service runs `src/deploy/main.ts` **from `current`** (so the deployer updates itself). `scripts/install.sh` (run once by the controller in Task 9): creates dirs, writes config if missing (asks for nothing; reads hostname from `tailscale status --json` `.Self.DNSName` without trailing dot, port 9443, and login from the hub's existing config `~/.config/pi-web/config.json` `allowedLogin`), first release from the current checkout's `main`, links units, `systemctl --user daemon-reload && enable --now spark-gateway spark-gateway-deploy.timer`, `tailscale serve --bg --https=9443 http://127.0.0.1:19443`.

- [ ] **Step 1: Write failing tests** with a fake `Exec` recording calls and scripted results, and a temp `root`:
  - new sha, tests pass, health reports sha → `deployed`; `current` points at `releases/<sha>`; statuses `pending` then `success`; restart called once.
  - test `failing tests keep the old release`: `npm test` exit 1 → `failed`, `current` unchanged, no restart, status `failure`, and a second run with the same sha → `none` (no retry loop).
  - test `failed health rolls back`: health never reports sha → `current` back to previous, two restarts, status `failure`.
  - same sha as deployed → `none`, no clone.
  - only current + previous release dirs remain after a success.
  - `backup.test.ts`: one backup per day; 15 days → 14 files.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck; `systemd-analyze --user verify systemd/*.service systemd/*.timer` (template unit verified with an instance name) prints no errors.
- [ ] **Step 5:** Commit `Production deployer, backups and systemd units`.

### Task 6: Preview gateways

**Files:**
- Create: `src/deploy/previews.ts`, `src/deploy/snapshot.ts`
- Modify: `src/deploy/main.ts`
- Test: `test/deploy-previews.test.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `Exec`, state (Task 5), `Store`/schema (Task 2), `loadApps` (Task 1).
- Produces:
  - `syncPreviews(deps: { exec: Exec; root: string; repo: string; fetchHealth; prodDb: string }): Promise<{ started: number[]; updated: number[]; stopped: number[]; failed: number[] }>`:
    - `gh pr list -R thats-it-dev/spark-gateway --state open --json number,headRefOid` is the truth.
    - For an open PR #N (1–499) whose head differs from `state.previews[N].sha`: clone head into `previews/<N>/` (fresh), `npm ci`, `npm test`. Pass → (first start only) build the snapshot, `systemctl --user restart spark-gateway-preview@N`, health check on `19500+N`, `tailscale serve --bg --https=${9500+N} http://127.0.0.1:${19500+N}`, upsert a sticky comment containing `<!-- spark-preview -->` with the URL `https://spark-713a.tail9274fa.ts.net:${9500+N}` and the head sha, status `success` context `spark-preview`. Fail → status `failure`, comment says tests failed (with last 20 lines of output), previous preview instance (if any) keeps running.
    - PR #N ≥ 500 → comment `No preview: PR numbers above 499 have no preview port.` once.
    - PR no longer open → `systemctl --user stop spark-gateway-preview@N`, `tailscale serve --https=${9500+N} off`, delete `previews/<N>/` and `data/previews/<N>.db`, drop from state.
  - `snapshotFor(prodDb: string, out: string, apps: string[]): void` — new db with the Task 2 schema containing only rows whose `app` is in `apps`.
  - "Apps the PR touches" = names from `gh pr diff <N> --name-only` paths `apps/<name>/…` plus names whose entries differ between the PR head's `apps.json` and `main`'s.
- `spark-gateway-preview@.service`: `WorkingDirectory=%h/.local/share/spark-gateway/previews/%i`, env `PORT` from `scripts/preview-env.sh %i` or an `EnvironmentFile=%h/.local/share/spark-gateway/previews/%i.env` the deployer writes (`PORT=…`, `GATEWAY_HOSTNAME=spark-713a.tail9274fa.ts.net:<9500+N>`, `GATEWAY_DB=…/data/previews/<N>.db`, `GATEWAY_APPS=…/previews/<N>/apps.json`, `GATEWAY_VERSION=<sha>`). Use the EnvironmentFile (Claude's call: simpler, no script).

- [ ] **Step 1: Write failing tests** (fake `Exec`, temp root, real sqlite for snapshot):
  - new PR #7 passing → env file has `PORT=19507` and hostname `…:9507`; `tailscale serve --bg --https=9507 http://127.0.0.1:19507` called; comment body contains `<!-- spark-preview -->` and `https://spark-713a.tail9274fa.ts.net:9507`.
  - second run, same head → no calls except `gh pr list`.
  - new head failing tests → old instance not restarted, status `failure`.
  - PR closed → stop, `tailscale serve --https=9507 off`, dirs removed.
  - PR #612 → one "no preview" comment, never a second.
  - existing sticky comment is edited (`gh api … -X PATCH`), not duplicated.
  - `snapshot.test.ts`, test `preview writes stay in the snapshot`: prod db with rows for `tips` and `notes`; snapshot for `["tips"]` has only tips rows; a `Store` opened on the snapshot and written to leaves the prod db's row count and content unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `Preview gateway per PR`.
- [ ] **Step 6:** Add `.github/workflows/test.yml` (`node-version: 26`, matching the spark): `npm ci`, `npm run typecheck`, `npm test` on `pull_request` and push to `main`. Commit `CI: typecheck and test`.

### Task 7: Template gateway client (app-template PR)

**Files (in `~/workspace/app-template`, branch `feat/gateway-client`):**
- Create: `src/gateway.ts`, `src/tailnet-only.ts` (`<tk-tailnet-only>` element), `test/gateway.test.ts`, `scripts/gateway-url.ts`, `test/gateway-url.test.ts`, `e2e/gateway.spec.ts`
- Modify: `vite/config.ts` (optional `"gateway": true`), `vite/app-plugin.ts` (define `__GATEWAY_URL__`; append the gateway origin to `connect-src` in `dist/_headers` and the preview server headers only when `gateway` is true), `src/env.d.ts`, `.github/workflows/deploy.yml`, `README.md`, `test/config.test.ts`, `test/headers.test.ts`

**Interfaces:**
- Produces:
  - `app.config.json` optional `"gateway": true` (absent = false; anything else → config error).
  - Build env `GATEWAY_URL` (default `https://spark-713a.tail9274fa.ts.net:9443`); `__GATEWAY_URL__` is `""` when `gateway` is false.
  - `src/gateway.ts`: `class OffTailnetError extends Error`, `class GatewayError extends Error { status: number }`; `gatewayFetch(path: string, init?: RequestInit): Promise<unknown>` — prefixes `__GATEWAY_URL__`, sends `content-type: application/json` for bodies; a rejected `fetch` (TypeError) → `OffTailnetError`; non-2xx → `GatewayError` with `status` and the body's `error`. Helpers: `kv.get(collection, id)`, `kv.put(collection, id, value)`, `kv.del(collection, id)`, `kv.list(collection, { limit?, cursor? })` all under `/apps/${APP_NAME}/kv/…` (`__APP_NAME__` defined from `app.config.json` name), and `system.models()`, `system.gpu()`, `system.sessions()`.
  - `<tk-tailnet-only>`: kit-styled card (only `sharedStyles` classes and tokens) with heading `Only works on the tailnet` and text `Connect this device to Michael's tailnet, then` + a `.btn` `Try again` that dispatches `retry`.
  - `scripts/gateway-url.ts`: `gatewayUrlFor(prBody: string): string | undefined` — matches a line `Gateway: thats-it-dev/spark-gateway#<N>` (case-insensitive key), returns `https://spark-713a.tail9274fa.ts.net:${9500+N}` for 1 ≤ N ≤ 499, else undefined. CLI form prints the URL or nothing.
  - `deploy.yml`: on `pull_request`, before build, `GATEWAY_URL=$(node scripts/gateway-url.ts <<< "$PR_BODY")` with `PR_BODY: ${{ github.event.pull_request.body }}` passed through `env` (never interpolated into the script); exported only when non-empty. The sticky preview comment adds `Gateway preview: <url>` when set. App CI e2e never reaches the gateway: tests stub it with `page.route`.
- [ ] **Step 1: Write failing tests**: `gateway-url.test.ts` (`Gateway: thats-it-dev/spark-gateway#12` → `…:9512`; `#0`, `#500`, other repo, missing → undefined); `gateway.test.ts` with a stubbed `fetch`: TypeError → `OffTailnetError`, 403 `{error:"x"}` → `GatewayError` status 403 message `x` (Review Focus 5), `kv.put("notes","n1",{a:1})` → `PUT …/apps/<name>/kv/notes/n1`; `config.test.ts`: `gateway: "yes"` rejected; `headers.test.ts`: with `gateway:true` built `_headers` `connect-src` contains `https://spark-713a.tail9274fa.ts.net:9443` (or the `GATEWAY_URL` origin), without it unchanged; `e2e/gateway.spec.ts` (only when `gateway` is true, else `test.skip`): with `page.route` aborting gateway requests, an element using `<tk-tailnet-only>` is visible; README example verified by typecheck.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npm run typecheck && npm test && npm run e2e` PASS.
- [ ] **Step 5:** Commit; the controller pushes the branch and opens the PR (Michael merges).

### Task 8: Skill — gateway flow (pi-web, `skills/thatsit-app`)

**Files:**
- Create: `skills/thatsit-app/scripts/lib/gateway.ts`, `skills/thatsit-app/test/gateway.test.ts`
- Modify: `skills/thatsit-app/scripts/thatsit-app.ts` (subcommands), `skills/thatsit-app/scripts/lib/pr.ts` (optional `--gateway-pr <N>` adds the `Gateway:` line to the body), `skills/thatsit-app/SKILL.md`, `skills/thatsit-app/README.md`, `skills/thatsit-app/test/skill-md.test.ts`

**Interfaces:**
- Consumes: existing `run`, `wait`, `pr` helpers; `RESULT <json>` convention; exit codes 0/1/2.
- Produces:
  - `gateway-checkout`: ensures `~/workspace/apps/spark-gateway` exists (clone `thats-it-dev/spark-gateway`, set clone-local identity like `new`), `git switch main && git pull`. `RESULT {"ok":true,"dir":…}`.
  - `gateway-register <app>`: in that checkout on a branch `register-<app>`, adds `{name, pagesSubdomain}` to `apps.json` using `cf pages get <app>` `subdomain` (strip `.pages.dev`), commits `Register <app>`. Fails if the app has no Pages project or is already registered.
  - `gateway-pr <dir> --title --body`: like `pr` but for the gateway repo; waits for the GitHub `test` workflow and then for the `spark-preview` commit status on the head sha (bounded 20 min), returns `RESULT {"ok":true,"pr":<url>,"number":N,"preview":"https://…:95NN"}`; on `failure` returns the comment's test output tail.
  - `pr ... --gateway-pr <N>` → body gets `Gateway: thats-it-dev/spark-gateway#<N>`; `RESULT` adds `"gatewayPreview"`.
  - Template change: an app that uses the gateway sets `"gateway": true` in `app.config.json`.
- SKILL.md (body still ≤ 150 lines; move detail into README if needed) gains **Needs spark data**: (1) built-ins `/system/models|gpu|sessions` or the store are enough → set `"gateway": true`, use `kv`/`system` from `src/gateway.ts`, show `<tk-tailnet-only>` on `OffTailnetError`, stub the gateway in e2e with `page.route`; first version also runs `gateway-register` + `gateway-pr` and reports both links (the app works once Michael merges the gateway PR). (2) needs custom logic → write `apps/<app>/routes.ts` + test in the gateway checkout following `apps/README.md`, `gateway-pr` first, then the app change with `pr --gateway-pr <N>`; reply with both PR links and both previews. Never edit `src/` of the gateway, never merge, never touch `~/.local/share/spark-gateway`.
- `~/workspace/apps/.pi/extensions/pi-permission-system/config.json` needs no change (the checkout is under `~/workspace/apps`); confirm in a test run.
- [ ] **Step 1: Write failing tests** with the fake `run` used by existing tests: register derives `pagesSubdomain` `tips-abc` from `tips-abc.pages.dev`; register refuses a duplicate; `gateway-pr` maps a `spark-preview` success status + sticky comment to the preview URL and a `failure` to exit 1 with the tail; `pr --gateway-pr 12` puts `Gateway: thats-it-dev/spark-gateway#12` in the body; `skill-md.test.ts` asserts the new section names `gateway-pr`, `--gateway-pr`, `"gateway": true`, `tk-tailnet-only` and the never-merge line, and the body is ≤ 150 lines.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** skill tests + root `npm test` PASS.
- [ ] **Step 5:** Commit `thatsit-app: spark gateway flow`.

### Task 9 (controller): install and prove

- [ ] Michael merges the gateway branch PR and the template PR (ask; never merge).
- [ ] Run `scripts/install.sh` on the spark (shows Michael what it will change first: two systemd user units + timer, one `tailscale serve` entry on 9443). Check `https://spark-713a.tail9274fa.ts.net:9443/health` from the tailnet and that an unknown-origin request is 403.
- [ ] Proof 1 (real pi run, print mode from `~/workspace/apps` with `-a`): "a page that shows which model is loaded and the GPU load", called `spark-status`. Verify: the app ships, its gateway register PR has a preview, and after Michael merges it the app shows data on his phone on the tailnet and the tailnet-only card off it.
- [ ] Proof 2: a change needing a custom route (e.g. "show how long the loaded model has been running" or "save favorite models"), producing a gateway PR with a preview and an app PR whose preview works against it before merge.
- [ ] Feed lessons back into SKILL.md; update memory.
