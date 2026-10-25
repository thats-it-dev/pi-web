# thatsit-app skill

A pi skill that turns "build me an app that does X" into a live PWA at `https://<name>.thatsit.app`, and "change Y" into a pull request with a preview link. `SKILL.md` is what pi reads; this file is for people.

## What it does

- **New app:** pi picks a name and asks you to confirm it. The CLI checks the name is free (GitHub repo, Pages project, DNS record), creates the public repo `thats-it-dev/<name>` from `thats-it-dev/app-template`, clones it to `~/workspace/apps/<name>`, writes `app.config.json` and the icons, and creates the Cloudflare Pages project, the custom domain and the proxied CNAME. pi then writes the app (single-page layout, kit components and tokens only), runs the tests and ships: one push to `main`, then the CLI waits for the production deploy and for the domain to answer.
- **Change:** pi works on a branch and runs `pr`. The CLI runs the checks, pushes, opens or reuses the PR, waits for CI and prints the preview link from the sticky PR comment. pi never merges and never pushes `main` after the first version.
- **Spark data:** an app that needs the spark (model list, GPU, pi sessions, or a server-side store) goes through the tailnet-only spark gateway (private repo `thats-it-dev/spark-gateway`). The CLI checks out the gateway, registers the app in `apps.json`, and opens a gateway PR whose preview runs on the spark. See "Spark gateway" below.

## CLI

```
node scripts/thatsit-app.ts check <name>
node scripts/thatsit-app.ts new <name> --title "..." --description "..." [--color "#RRGGBB"] [--resume]
node scripts/thatsit-app.ts ship <dir>
node scripts/thatsit-app.ts pr <dir> --title "..." --body "..." [--gateway-pr <N>]
node scripts/thatsit-app.ts gateway-checkout
node scripts/thatsit-app.ts gateway-register <app>
node scripts/thatsit-app.ts gateway-pr <dir> --title "..." --body "..."
```

Each command ends with one `RESULT <json>` line. Exit 0 is success, 1 a failure (the reason is on stderr and in `RESULT`), 2 a usage error. `new --resume` finishes a half-done `new` without creating duplicates. It uses the existing `gh` and `cf` logins on the spark and never handles tokens itself; deploys use the org secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. `THATSIT_APPS_DIR` overrides `~/workspace/apps`.

## Spark gateway

pi reads this section (SKILL.md points here) before it builds an app that needs spark data. Use it only when the app has to read the spark or keep data on it; such an app works only on Michael's tailnet.

**Commands** (all print one `RESULT` line, like the others):

- `gateway-checkout` clones `thats-it-dev/spark-gateway` to `~/workspace/apps/spark-gateway` the first time (with the same clone-local git identity as `new`), then `git switch main`, `git pull --ff-only` and `npm ci`. It refuses a dirty checkout. `RESULT {"ok":true,"dir":...}`.
- `gateway-register <app>` adds `{ "name": "<app>", "pagesSubdomain": "<sub>" }` to `apps.json` (`<sub>` is the app's Pages subdomain without `.pages.dev`, read with `cf pages get`) and commits `Register <app>`. Started on `main`, it first creates the branch `register-<app>`; started on another branch, it commits there. It fails when the app has no Pages project or is already registered. `RESULT` has `dir`, `branch`, `name`, `pagesSubdomain`.
- `gateway-pr <dir> --title --body` refuses `main`, a dirty tree and any change outside `apps.json` and `apps/<app>/`, runs `npm run typecheck` and `npm test`, pushes, opens (or reuses the open) PR, waits for the GitHub `test` workflow, then for the spark's `spark-preview` commit status (20 minutes in all). `RESULT {"ok":true,"pr":...,"number":N,"preview":"https://spark-713a.tail9274fa.ts.net:<9500+N>"}`.
- `pr <dir> ... --gateway-pr <N>` adds the line `Gateway: thats-it-dev/spark-gateway#<N>` to the app PR body, so the app preview talks to gateway preview N, and adds `gatewayPreview` to `RESULT`. The app's `app.config.json` must have `"gateway": true`.

**In the app:** set `"gateway": true` in `app.config.json`. Import `kv` (`get`, `put`, `del`, `list`) and `system` (`models`, `gpu`, `sessions`) from `src/gateway.ts`. When a call throws `OffTailnetError`, render `<tk-tailnet-only>` (it fires `retry`) instead of the app; a `GatewayError` is a real error, show it with `toast`. In e2e, stub every gateway request with `page.route`; never let tests reach the spark.

**Case 1, the built-ins are enough** (`/system/models`, `/system/gpu`, `/system/sessions`, the app's store):

1. Write and test the app as usual (New app steps 1-6 or Change steps 1-4).
2. `gateway-checkout`, then `gateway-register <name>` if the app is not in `~/workspace/apps/spark-gateway/apps.json` yet.
3. `gateway-pr ~/workspace/apps/spark-gateway --title "Register <name>" --body "<what the app uses>"`.
4. New app: `ship` as usual. Change: `pr ... --gateway-pr <N>` with `number` from step 3.
5. Reply with the gateway `pr` and `preview`, and the app's `url` (or `pr` and `preview`). Say the app works for real once Michael merges the gateway PR.

If the app is already registered, skip steps 2-3 and run `pr` without `--gateway-pr`.

**Case 2, custom server logic:**

1. `gateway-checkout`. If the app is not registered, `gateway-register <name>` (that puts you on `register-<name>`); otherwise `cd ~/workspace/apps/spark-gateway && git switch -c <name>-<what>` before editing any file.
2. Write `~/workspace/apps/spark-gateway/apps/<name>/routes.ts` and `routes.test.ts` following `~/workspace/apps/spark-gateway/apps/README.md` exactly (single-line imports, the import allowlist, the banned words). Run `cd ~/workspace/apps/spark-gateway && npm run typecheck && npm test` until green, then commit.
3. `gateway-pr ~/workspace/apps/spark-gateway --title "..." --body "..."` first.
4. Then the app: New app steps (ship as usual), or Change steps with `pr ... --gateway-pr <N>`.
5. Reply with both PR links and both previews (`preview` from `gateway-pr`, `preview` and `gatewayPreview` from `pr`).

**Never:** edit anything under the gateway's `src/` (or anything outside `apps.json` and `apps/<name>/`), merge a PR, or touch `~/.local/share/spark-gateway` or `~/.config/spark-gateway`.

**When a gateway command fails:**

- `test run ... failed in` (GitHub CI) or `spark preview ... failed` (the spark's own run): the error ends with the failing test output. Fix the gateway files, commit, rerun `gateway-pr`; it updates the same PR.
- `gateway-pr only sends apps.json and apps/<app>/ changes`: restore the listed files to their `main` version (or delete the ones you added), commit, rerun.
- `is not using gateway preview #N` (app `pr`): the app preview was deployed before the Gateway line was in the PR body. Run `git commit --allow-empty -m "Use gateway preview #N"` in the app, then rerun the same `pr`.
- `is already registered`: skip `gateway-register`. `has no Pages project`: run `new` first.
- `No preview`, `did not report a preview` or `did not finish within`: give Michael the PR URL and stop.

## Install

pi loads skills from `~/.pi/agent/skills`, and `SKILL.md` calls the CLI by that path:

```bash
ln -s ~/workspace/pi-web/skills/thatsit-app ~/.pi/agent/skills/thatsit-app
```

To try it without installing: `pi --skill ~/workspace/pi-web/skills/thatsit-app`. The CLI paths in `SKILL.md` still point at `~/.pi/agent/skills`, so install before real use.

## Develop

```bash
npm test -w skills/thatsit-app       # unit tests with stubbed gh/cf, plus a SKILL.md check
npm run typecheck -w skills/thatsit-app
```
