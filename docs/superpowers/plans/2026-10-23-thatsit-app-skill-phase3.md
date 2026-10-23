# thatsit-app pi Skill (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a pi-web chat, "build me an app that does X" ends with X live at `<name>.thatsit.app`, and "change Y" ends with a PR plus a working preview link, without pi ever merging.

**Architecture:** A pi skill at `pi-web/skills/thatsit-app/`, symlinked into `~/.pi/agent/skills/`. pi runs on local spark models, so every mechanical step goes into one deterministic CLI, `scripts/thatsit-app.ts`, with the subcommands `check`, `new`, `ship` and `pr`. `SKILL.md` tells the model when to call each one and how to write the app. The CLI shells out to `gh`, `cf`, `git` and `npm` through an injected `run` function, so tests drive it with canned outputs.

**Tech Stack:** Node >= 22.18 (`.ts` run by type stripping, erasable syntax only), `node:test`, `gh`, `cf` 1.0.0-beta.14, and the published template `thats-it-dev/app-template`.

**Spec:** `docs/superpowers/specs/2026-10-20-thatsit-apps-design.md` §4, plus Success §3–4.

## Global Constraints

- Apps live in the org `thats-it-dev`, are public, and are created with `gh repo create thats-it-dev/<name> --public --template thats-it-dev/app-template`.
- Local checkouts go in `~/workspace/apps/<name>` (Michael's call).
- Names match `/^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/`, the same rule as the template's `parseConfig`. Reserved names that are never used: `pi`, `kit`, `www`, `app`, `api`, `mail`, `app-template`.
- The zone is `thatsit.app`, and the custom domain is `<name>.thatsit.app`. The CNAME `<name>` → the project's `subdomain` from `cf pages create` output is always proxied. Never assume `<name>.pages.dev`; Cloudflare adds a suffix when that name is taken.
- Pages projects get production branch `main`. Every Cloudflare action goes through `cf`, and commands are found with `cf cli search "<task>"` using anonymous queries.
- pi pushes straight to `main` only for an app's first version. After that, every change is a PR, and pi never merges.
- Secrets are never printed, written to repos, or passed on command lines. The CLI relies on the existing `gh` and `cf` logins on the spark.
- The skill defaults to the template's **single-page** layout and uses the shell (`data-shell`, `tk-shell` and `tk-header`) only when the app needs navigation. Only kit components and tokens are allowed: no custom colors, fonts or radii.
- Atproto and spark backends are Phase 4 and out of scope here.
- Code style follows pi-web: tabs, double quotes, terse why-comments.

## Review Focus

1. **A partial failure in `new`** (for example, the repo is created but `cf pages create` fails). A rerun with `--resume` should finish the job without creating duplicates or failing on the name check. Test: each step is skipped when its resource already exists and matches.
2. **A name that's taken somewhere else**, such as an existing DNS record for `<name>.thatsit.app` or a repo of that name. `check` must refuse it and say where it's taken. Test: one case per source.
3. **A second `ship` to `main`.** This would break the "every change is a PR" rule. Test: `ship` refuses when `origin/main` has more commits than the template's initial commit plus the configure commit.
4. **A red CI run on a PR.** `pr` should print the failing step and the tail of its log rather than a stale preview link. Test: a failed run gives exit 1 and the failure text, and the URL from an older comment is not printed.
5. **A custom domain that's still pending.** `ship` waits a bounded time for `https://<name>.thatsit.app`, then reports the pages.dev URL and says the domain is still validating, instead of hanging. Test: a stubbed fetch that never returns 200 gives the fallback message within the timeout.

---

### Task 1: Fix the kit demo's light-DOM controls

The kit demo is the style reference the skill points pi at, and its light-DOM `.btn` and `.seg` are unstyled, because `sharedStyles` only applies inside shadow roots.

**Files:**
- Modify: `kit/demo/index.html`, `kit/e2e/demo.spec.ts`

- [ ] **Step 1: Add the failing test.** It checks that on the demo page, `button.btn:not(.ghost)` has the computed `background-color` of `--primary` and a non-zero `border-radius`.
- [ ] **Step 2: Fix the demo** by adopting the kit's `sharedStyles` on `document`, with `document.adoptedStyleSheets = [...document.adoptedStyleSheets, sharedStyles.styleSheet]` in the demo's module script. Add a one-line comment saying light DOM doesn't get `sharedStyles` otherwise. `kit.css` and the API surface stay unchanged.
- [ ] **Step 3: Run `npm run build -w kit && npm test -w kit` and the kit Playwright tests.** Expect a pass. Then commit.

### Task 2: The CLI's `check` and `new` subcommands

**Files:**
- Create: `skills/thatsit-app/package.json` (a workspace with `"test": "node --test --test-concurrency=1 test/*.test.ts"`, as in `hub/`), `skills/thatsit-app/scripts/thatsit-app.ts`, `skills/thatsit-app/scripts/lib/run.ts`, `skills/thatsit-app/scripts/lib/names.ts`, `skills/thatsit-app/scripts/lib/new-app.ts`, and `skills/thatsit-app/test/*.test.ts`
- Create: `skills/thatsit-app/tsconfig.json` (same compiler options as `kit/`, with `"types": ["node"]`, and a `typecheck` script)
- Modify: the root `package.json`: add `skills/thatsit-app` to `workspaces`, and to the root `test` and `typecheck` chains

**Interfaces:**
- Produces:
  - `type Run = (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>`
  - `realRun: Run`, which uses `execFile` and never throws on a non-zero exit
  - `checkName(name: string, run: Run): Promise<{ ok: true } | { ok: false; reason: string }>`, where `reason` names the source: "invalid name", "reserved", "GitHub repo exists", "Pages project exists" or "DNS record exists"
  - `newApp(opts: { name: string; title: string; description: string; color: string; resume: boolean; appsDir: string }, run: Run): Promise<{ dir: string; pagesSubdomain: string }>`
  - CLI usage: `thatsit-app check <name>` and `thatsit-app new <name> --title "..." --description "..." [--color "#RRGGBB"] [--resume]`. Each prints one final line as `RESULT <json>`, so pi can parse it reliably. Exit codes are 0 on success, 1 on failure (with a plain-English reason on stderr) and 2 for usage errors.

`newApp` runs these steps in order, and with `resume` it skips each one whose result already exists:
1. Name check (skipped with `resume`).
2. `gh repo create`.
3. `gh repo clone` into `<appsDir>/<name>`.
4. Write `app.config.json`, run `npm ci`, then `npm run icons`, then `git commit -m "Configure <name>"`. Not pushed.
5. `cf pages create --name <name> --production-branch main`, reading `subdomain` from the JSON.
6. `cf pages domains create <name> --name <name>.thatsit.app`.
7. `cf dns records create -z thatsit.app --body '{"type":"CNAME","name":"<name>","content":"<subdomain>","proxied":true}'`.

The default color is `#FFAA00`.

- [ ] **Step 1: Write the tests** using a fake `Run` that answers from a table and records calls:
  - each `checkName` refusal source, plus success;
  - `newApp` issues the seven steps in order, with exact arguments;
  - the CNAME content comes from `subdomain` (use a fixture `foo-930.pages.dev`);
  - with `resume`, when the repo, project, domain and record already exist, no create calls are made;
  - a failing step stops the run and its stderr shows up in the error.
- [ ] **Step 2: Run `npm test -w skills/thatsit-app`.** Expect a fail.
- [ ] **Step 3: Implement it.** `realRun` must not print `stdout` for `cf` calls that could echo credentials. These subcommands only call resource commands, never the auth or token ones.
- [ ] **Step 4: Run the tests and expect a pass.** Also run `node skills/thatsit-app/scripts/thatsit-app.ts check kit`, which must exit 1 with "reserved", and `check pi-web-test-zz9`, which must exit 0. Those two are real read-only calls. Then commit.

### Task 3: The CLI's `ship` and `pr` subcommands

**Files:**
- Create: `skills/thatsit-app/scripts/lib/ship.ts`, `skills/thatsit-app/scripts/lib/pr.ts`, `skills/thatsit-app/scripts/lib/wait.ts`, and tests

**Interfaces:**
- Consumes: `Run` from Task 2.
- Produces:
  - `ship(dir: string, run: Run, fetchStatus: (url: string) => Promise<number>, opts?: { domainTimeoutMs?: number }): Promise<{ url: string; pending: boolean }>`
  - `openPr(dir: string, opts: { title: string; body: string }, run: Run): Promise<{ pr: string; preview: string }>`
  - CLI usage: `thatsit-app ship <dir>` and `thatsit-app pr <dir> --title "..." --body "..."`. Both print `RESULT <json>`.

`ship` works like this:
- It refuses unless the branch is `main`, the tree is clean, and `origin/main` has exactly the template's initial commit (Review Focus 3).
- It runs `npm run typecheck`, `npm test` and `npm run e2e` locally, then `git push origin main`.
- It finds the run for HEAD's SHA with `gh run list --commit <sha> --json databaseId,status`, retrying for up to 60 s. Then it calls `gh run watch <id> --exit-status`.
- It polls `https://<name>.thatsit.app/` for a 200 for up to `domainTimeoutMs`, defaulting to 10 minutes. On timeout it returns the project's pages.dev URL with `pending: true` (Review Focus 5).

`openPr` works like this:
- It refuses on `main`, on a dirty tree, or with no commits ahead of `origin/main`.
- It runs the same local checks, then `git push -u origin HEAD` and `gh pr create --title --body`.
- It finds and watches the run for the head SHA. On failure, the error carries `gh run view <id> --log-failed` trimmed to the last 40 lines (Review Focus 4).
- It reads the comment containing `<!-- thatsit-preview -->` and checks that it names the head SHA's first 7 characters. A comment naming an older SHA counts as no preview yet: it retries for up to 60 s, then fails.

- [ ] **Step 1: Write the tests** with a fake `Run`, a fake `fetchStatus` and a short timeout:
  - each refusal;
  - the happy path with exact calls;
  - a red run giving an error with the log tail;
  - a stale comment SHA being rejected;
  - the domain timeout fallback.
- [ ] **Step 2: Run them.** Expect a fail. Implement the code, rerun and expect a pass, then commit.

### Task 4: SKILL.md and install

**Files:**
- Create: `skills/thatsit-app/SKILL.md`, `skills/thatsit-app/README.md` (for humans: install and what it does)
- Modify: pi-web `README.md` (one line pointing to the skill)

**Interfaces:**
- Consumes: the CLI from Tasks 2 and 3, called as `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts …`.

`SKILL.md` has frontmatter with `name: thatsit-app` and a `description` that says when to use it: building, deploying or changing a small web app or PWA on thatsit.app or `<name>.thatsit.app`. The body stays under ~150 lines, because local models need short, imperative steps. It covers:
- **New app, step by step.**
  1. Choose a short name and confirm it with Michael in one line.
  2. Run `check`.
  3. Run `new`.
  4. Write the app in `src/app-main.ts`, plus new files under `src/` if needed. Use the single-page layout by default, following the template README's "Layouts". Delete `e2e/starter.spec.ts` with the starter section, and add an e2e test for the app's main behavior in `e2e/`.
  5. Run `npm run typecheck && npm test && npm run e2e` until green.
  6. Run `ship`.
  7. Reply with the production link, or say the domain is still validating and give the pages.dev link.
- **Change**, step by step:
  1. In `~/workspace/apps/<name>`, run `git switch -c <short-branch>`.
  2. Make the edit, then run the tests.
  3. Commit.
  4. Run `pr`.
  5. Reply with the PR and preview links.

  Never merge, and never push `main`.
- **Style rules:**
  - Only kit components (`tk-sheet`, `tk-toasts`, `tk-header`, `tk-shell`), `sharedStyles` classes (`.btn`, `.ghost`, `.seg`, `.u`, `.label`, `.dot`, inputs) and the `var(--*)` tokens.
  - No hex colors, font families or `border-radius` values in app code.
  - The reference pages are https://kit.thatsit.app/ and https://kit.thatsit.app/kit.d.ts.
  - Lit is imported only from `https://kit.thatsit.app/lit.js`.
- **Failure handling:**
  - When `new` fails midway, fix the cause and rerun with `--resume`.
  - When `pr` reports a red run, read the log tail, fix it, commit and rerun `pr`; the comment is updated in place.
  - Never print or ask for tokens.

- [ ] **Step 1: Write the files,** then add a `node:test` check. It verifies that `SKILL.md` frontmatter parses with that name, that every CLI subcommand the skill names exists in `thatsit-app.ts`'s usage, and that the body is at most 150 lines.
- [ ] **Step 2: Install** with `ln -s ~/workspace/pi-web/skills/thatsit-app ~/.pi/agent/skills/thatsit-app`. Then run `pi --help` or a `pi -p --no-session "List your skills"` dry check to confirm pi lists `thatsit-app`. Record the command used.
- [ ] **Step 3: Run `npm test -w skills/thatsit-app`, then commit.**

### Task 5: Real end-to-end run (controller, not a subagent)

Michael approved a real run whose app is kept.

- [ ] **Step 1: Ask pi to build an app** on the spark, from `~/workspace/apps`: `pi -p "Build me a tip calculator app on thatsit.app: bill amount, tip percent (15/18/20/custom), number of people, per-person total. Call it tips."`. If pi's permission extension blocks print mode, stop and ask Michael to send the same message from pi-web instead.
- [ ] **Step 2: Verify the result.**
  - `https://tips.thatsit.app` serves the app, or the pages.dev link while the domain validates.
  - It shows no hex colors in `src/`.
  - The generic e2e tests pass against it with `BASE_URL`.
  - It was a single page.
- [ ] **Step 3: Ask for a change** with `pi -p "In the tips app, add a 'round up per person' toggle."`. Verify a PR exists with a preview link that works and shows the toggle, the link also appears in pi's reply, and `main` is untouched. Leave the PR open for Michael.
- [ ] **Step 4: Note what pi got wrong.** Feed real gaps back into `SKILL.md` through one more reviewed commit. Update the memory file `thatsit-app-deploy-skill`.
