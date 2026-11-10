# Background bash, fast `pr`, latest PR in the panel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi stops blocking for minutes on CI. A general `bg_bash` tool runs long commands in the background and wakes pi when they exit. `pr` returns the PR link in seconds, and the side panel shows the latest PR and its preview.

**Architecture:**
- A new pi extension `pi-web/bg/` owns the background jobs. When a job exits it sends a `bg-bash-done` custom message with `triggerTurn`, and it publishes a `bg-jobs` status while any job runs.
- The hub reads that status to keep the session alive and to hold its "finished" push.
- The thatsit-app CLI splits "open the PR" from "wait for CI and the preview" and drops its redundant local checks.
- The guard steers pi onto that flow.
- The progress panel finds the latest PR in the conversation's messages.

**Tech Stack:** TypeScript (Node 26, `node --test` in guard/bg/skill/hub/shared; vitest in app), Lit, pi 1.0.2 extension API, typebox.

**Spec:** `docs/superpowers/specs/2026-11-10-async-bash-design.md`

## Global Constraints

- Never edit app repos under `~/workspace/apps` or the app template. Only pi-web (guard, bg, skill, hub, shared, app) changes.
- pi's bash `timeout` is in seconds. When it's omitted, no timeout applies.
- No `bg_wait`/blocking-wait tool.
- The status key is exactly `bg-jobs`. The custom message type is exactly `bg-bash-done`. The new CLI commands are exactly `pr-wait <dir>` and `gateway-pr-wait <dir>`.
- Tool descriptions and guard messages are guardrails for flash-next. Keep them short and imperative, with one clear instruction each.
- Run each package's tests with its own `npm test` from that package dir. Run `npm run typecheck` where the package has it.
- Commit on a feature branch `feat/async-bash`, never on master. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A job that exits while pi is mid-turn.** The `bg-bash-done` message must queue (`deliverAs: "followUp"`) and not be lost or interrupt the turn. Test it in Task 1.
2. **A command that writes a lot of output.** The done message carries only the tail and the full `RESULT {...}` line, even when the line comes before the tail. Test it in Task 1.
3. **`pr` run again on a branch that already has a PR.** It reuses and updates the PR and returns fast. The panel then shows the new run's status, not the old preview. Tests in Task 3 (reuse) and Task 7 (latest wins).
4. **The hub restarts or pi exits while `pr-wait` runs.** The panel shows "CI result lost", not "CI running…" forever. Test it in Task 7.
5. **pi tries to background `pr-wait` with `nohup`/`&`/`setsid` in `bash`, or puts a `timeout` on `pr`.** The guard blocks both with the new reasons. Test it in Task 4.

---

### Task 1: `bg` extension: `bg_bash`, `bg_status`, `bg_cancel`

**Files:**
- Create: `bg/package.json` (copy `guard/package.json`'s shape: name `@pi-web/bg`, `"keywords": ["pi-package"]`, `"pi": { "extensions": ["./index.ts"] }`, the same scripts and devDependencies), `bg/tsconfig.json` (copy guard's), `bg/jobs.ts`, `bg/index.ts`, `bg/README.md` (short: what the three tools do and what the done message looks like)
- Test: `bg/test/jobs.test.ts`, `bg/test/index.test.ts`
- Modify: `~/.pi/agent/settings.json` (add `"../../workspace/pi-web/bg"` next to the guard entry). This file is outside the repo, so don't commit it.

**Interfaces:**
- Produces (`bg/jobs.ts`):
  - `type JobState = "running" | "exited" | "cancelled"`
  - `interface Job { id: string; command: string; cwd: string; logPath: string; startedAt: number; state: JobState; exitCode: number | null; endedAt: number | null }`
  - `class Jobs { constructor(opts: { logDir: string; onExit: (job: Job) => void; now?: () => number }); start(command: string, cwd: string): Job; get(id: string): Job | undefined; list(): Job[]; running(): number; tail(id: string, lines: number): string; cancel(id: string): boolean; killAll(): void }`
  - `function doneText(job: Job, log: string, tailLines?: number): string`
  - `const DONE_TYPE = "bg-bash-done"`, `const STATUS_KEY = "bg-jobs"`
- Produces (`bg/index.ts`): `default function bg(pi: PiLike, opts?: { logDir?: string }): void`, which registers the three tools and the `session_shutdown` handler.

- [ ] **Step 1: Write the failing tests for `Jobs` (`bg/test/jobs.test.ts`)**
  - `start runs the command detached and onExit gets the exit code`: start `echo hi; exit 3`. Await an `onExit` promise and assert `exitCode === 3`, `state === "exited"`, and that the log file contains `hi`.
  - `ids count up per manager`: two starts give `bg-1` and `bg-2`.
  - `running counts only live jobs`: `sleep 5` → `running() === 1`. After `cancel(id)` returns true, onExit fires with `state === "cancelled"` and `running() === 0`.
  - `cancel kills the whole process group`: start `sleep 30 & sleep 30; wait` and cancel it. Assert onExit fires within 2 s.
  - `killAll stops every running job`.
  - `doneText includes the RESULT line even when it is not in the tail`: the log is a `RESULT {"ok":true,"pr":"https://x/pull/1"}` line followed by 200 filler lines. Assert the text contains the full RESULT line, `exited 0`, the job id, and at most 60 filler lines.
  - `doneText starts with "bg_bash job <id> exited <code>"`: Task 7 parses this first line, so assert it exactly.

- [ ] **Step 2: Run them and see them fail**
  Run: `cd bg && npm test`. Expected: FAIL, because `jobs.ts` doesn't exist yet.

- [ ] **Step 3: Implement `bg/jobs.ts`**
  `spawn("bash", ["-lc", command], { cwd, detached: true, stdio: ["ignore", fd, fd] })` with `fd` opened on `logDir/<id>.log`, then `child.unref()`. Cancel and killAll do `process.kill(-pid, "SIGTERM")`. In `doneText`, the first line is `bg_bash job ${id} exited ${exitCode}` (or `was cancelled`) plus `after <m>m <s>s: <command shortened to 120 chars>`. Then the last `RESULT ` line of the log, if there is one and it isn't already in the tail. Then the last `tailLines` (default 60) lines.

- [ ] **Step 4: Run them and see them pass**
  Run: `cd bg && npm test`. Expected: PASS.

- [ ] **Step 5: Write the failing extension tests (`bg/test/index.test.ts`)**
  Use a fake `pi` that records `registerTool`, `on`, and `sendMessage` calls (same pattern as `guard/test/index.test.ts`). The fake `ctx.ui.setStatus` records calls.
  - `registers bg_bash, bg_status, bg_cancel`.
  - `bg_bash returns at once with the job id and sets the bg-jobs status`: execute with `{ command: "sleep 0.2; echo done" }`. The result text matches `/started job bg-1/`, `details.id === "bg-1"`, and `setStatus` was called with `("bg-jobs", "1 background job")` before the result resolved.
  - `on exit it sends one bg-bash-done message that triggers a turn and queues as follow-up`: after exit, `sendMessage` was called once with `customType: "bg-bash-done"`, `display: true`, and content starting `bg_bash job bg-1 exited 0`. Options are `{ triggerTurn: true, deliverAs: "followUp" }`. `setStatus("bg-jobs", undefined)` was called.
  - `bg_status lists jobs with state and tail`; `bg_cancel stops a job and says so`; `bg_cancel of an unknown id is an error result`.
  - `session_shutdown kills running jobs and sends nothing`.

- [ ] **Step 6: Run them and see them fail**
  Run: `cd bg && npm test`. Expected: FAIL.

- [ ] **Step 7: Implement `bg/index.ts`**
  Import `Type` from `typebox` (as `bridge/index.ts` does). Parameters:
  - `bg_bash`: `{ command: string; cwd?: string }`. `cwd` defaults to `ctx.cwd`.
  - `bg_status`: `{ id?: string }`.
  - `bg_cancel`: `{ id: string }`.

  Keep the `ctx` from the latest `execute` so `onExit` can call `ctx.ui.setStatus`. The status text is `${n} background job${n === 1 ? "" : "s"}`, cleared when `n` hits 0. `logDir` defaults to `join(tmpdir(), "pi-bg", String(process.pid))`. Tool descriptions, verbatim:
  - `bg_bash`: "Run a long shell command in the background. Returns a job id at once; when the command exits you get a bg-bash-done message with its exit code and last lines of output, and a new turn starts. Use it for commands that wait on CI (pr-wait, gateway-pr-wait, ship). Do not poll; end your turn and wait for the message."
  - `bg_status`: "Show background jobs: state, run time and the last lines of output. Only when Michael asks."
  - `bg_cancel`: "Stop a background job by id."

- [ ] **Step 8: Run tests and typecheck**
  Run: `cd bg && npm test && npm run typecheck`. Expected: PASS, with no type errors.

- [ ] **Step 9: Register and commit**
  Add the bg path to `~/.pi/agent/settings.json`. Then:
  `git add bg && git commit -m "feat(bg): bg_bash runs long commands in the background and wakes pi when they exit"`

---

### Task 2: thatsit-app: drop the CLI's local checks

**Files:**
- Modify: `skills/thatsit-app/scripts/lib/pr.ts:5,77-79`, `skills/thatsit-app/scripts/lib/gateway.ts:7,96`, `skills/thatsit-app/scripts/lib/ship.ts:3,32`, `skills/thatsit-app/scripts/lib/wait.ts:39-59` (delete `APP_CHECKS` and `localChecks`; keep `LOG_TAIL_LINES` only if something else uses it)
- Test: `skills/thatsit-app/test/ship.test.ts:37-65`, `skills/thatsit-app/test/gateway.test.ts` (fake-run tables and the expected command lists)

**Interfaces:** none new. `localChecks` and `APP_CHECKS` disappear.

- [ ] **Step 1: Change the tests first**
  In `ship.test.ts`, the assertion at line 53 becomes `assert.deepEqual(npm, [])` ("ship runs no npm checks; CI does"). Do the same for any gateway-pr test that expects `npm run typecheck`/`npm test`. Remove `npm` entries from the fake-run tables if nothing hits them anymore.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd skills/thatsit-app && npm test`. Expected: FAIL on the npm assertions.
- [ ] **Step 3: Delete the `localChecks` calls and the two exports.** In `pr.ts`, also drop the now-wrong comment at line 77.
- [ ] **Step 4: Run tests and typecheck**
  Run: `cd skills/thatsit-app && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -am "feat(thatsit-app): drop local checks from pr, ship and gateway-pr; pi runs verify and CI runs them again"`

---

### Task 3: thatsit-app: `pr` returns at once, `pr-wait` and `gateway-pr-wait` wait

**Files:**
- Modify: `skills/thatsit-app/scripts/lib/pr.ts:59-127`, `skills/thatsit-app/scripts/lib/gateway.ts:79-135`, `skills/thatsit-app/scripts/thatsit-app.ts:16-41,68-104` (Args union, parseArgs, usage string, dispatch)
- Test: `skills/thatsit-app/test/gateway.test.ts:280-340` (the `openPr` tests), `skills/thatsit-app/test/cli.test.ts`. Add `skills/thatsit-app/test/pr.test.ts` for the plain (non-gateway) split.

**Interfaces:**
- Produces (`lib/pr.ts`):
  - `openPr(dir, o: { title: string; body: string; gatewayPr?: number }, run: Run, opts?: PrOpts): Promise<{ pr: string; number: number }>`. Everything up to and including `pushAndOpen`, nothing after.
  - `waitPr(dir: string, run: Run, opts?: PrOpts): Promise<{ pr: string; preview: string; gatewayPreview?: string }>`. Finds the branch's open PR with `openPrOf` and reads `gatewayPr` from its body's `Gateway: <GATEWAY_REPO>#N` line. Then it does today's watch + preview-comment loop for `headSha`. If there's no open PR, it throws `no open PR for this branch; run pr first`.
- Produces (`lib/gateway.ts`):
  - `gatewayPr(dir, o, run, opts?): Promise<{ pr: string; number: number }>`. Checks + push + open only.
  - `waitGatewayPr(dir: string, run: Run, opts?: GatewayPrOpts): Promise<{ pr: string; number: number; preview: string }>`. Finds the open PR with `openPrOf`, then runs today's 20-min CI + spark-status loop from that point on.
- Produces (CLI): `Args` gains `{ cmd: "pr-wait"; name: string }` and `{ cmd: "gateway-pr-wait"; name: string }`. The usage string gains `pr-wait <dir> | gateway-pr-wait <dir>`. Both print `RESULT {"ok":true,...}` like the rest.

- [ ] **Step 1: Write and move the failing tests**
  - `pr.test.ts` → `openPr pushes, opens the PR and returns without watching CI`: the fake run records calls. Assert the result is `{ pr, number }` and no `gh run` / `gh api .../comments` call was made.
  - `pr.test.ts` → `openPr reuses an existing open PR`: Review Focus 3. The existing PR's number comes back, and there's no `gh pr create`.
  - `pr.test.ts` → `waitPr returns the preview for the head commit` (moved from today's openPr tests); `waitPr fails with "run pr first" when the branch has no open PR`.
  - `gateway.test.ts:280,326`: the `--gateway-pr` preview tests call `waitPr`. The PR body in the fake has the Gateway line. The assertions (gateway preview returned; "not using gateway preview" error) stay as they are.
  - `gateway.test.ts` → `gateway-pr returns right after opening`; `waitGatewayPr returns the spark preview` / `fails on a spark failure` (moved from today's gatewayPr wait tests).
  - `cli.test.ts` → `parseArgs pr-wait and gateway-pr-wait` (missing dir → null).
- [ ] **Step 2: Run them and see them fail**
  Run: `cd skills/thatsit-app && npm test`. Expected: FAIL.
- [ ] **Step 3: Split `openPr`/`waitPr` and `gatewayPr`/`waitGatewayPr`, and wire up the CLI.** Keep the existing error messages word for word. One exception: the "rerun the same pr" hint in the gateway-preview error becomes "then rerun pr and pr-wait".
- [ ] **Step 4: Run tests and typecheck**
  Run: `cd skills/thatsit-app && npm test && npm run typecheck`. Expected: PASS. `skill-md.test.ts` "every subcommand SKILL.md runs is in the CLI usage" still passes.
- [ ] **Step 5: Commit**
  `git commit -am "feat(thatsit-app): pr and gateway-pr return the PR at once; pr-wait and gateway-pr-wait wait for CI"`

---

### Task 4: guard: no timeouts on `pr`, waits only through `bg_bash`

**Files:**
- Modify: `guard/rules.ts:13` (`REASONS`), `guard/rules.ts:140-161` (`codeOf`, `SKILL_PUSH`, `PR_TIMEOUT_S`, `checkToolCall`), `guard/rules.ts:~296` (PR nudge text), `guard/README.md:40-50`
- Test: `guard/test/rules.test.ts:188-226`

**Interfaces:**
- Consumes: the command names from Task 3, and the tool name `bg_bash` with input `{ command, cwd? }` from Task 1.
- Produces: `REASONS.prTimeout` (new text) and `REASONS.waitInBackground`. `PR_TIMEOUT_S` is deleted.

Reason texts, verbatim:
- `prTimeout`: "Blocked: `pr` and `gateway-pr` return as soon as the PR is open. Run the same command again with no timeout."
- `waitInBackground`: "Blocked: `pr-wait`, `gateway-pr-wait` and `ship` wait on CI. Run the same command with the bg_bash tool, tell Michael the PR link, then end your turn; a bg-bash-done message wakes you when CI finishes."

- [ ] **Step 1: Replace the 2400 tests with failing ones**
  - `pr and gateway-pr with any bash timeout are blocked; without one they pass`: timeouts `[30, 600, 2400]` → `REASONS.prTimeout`; no timeout → `undefined`.
  - `pr-wait, gateway-pr-wait and ship in bash are blocked, with or without a timeout`: → `REASONS.waitInBackground`.
  - `backgrounding them in bash is blocked too`: `nohup … pr-wait …`, `… ship … &`, `setsid … gateway-pr-wait …` → `waitInBackground`. Review Focus 5.
  - `bg_bash may run pr-wait, gateway-pr-wait and ship`: → `undefined`.
  - `bg_bash commands get the same shell checks as bash`: `checkToolCall("bg_bash", { command: "cd ~/workspace/apps/x && git push" }, env())` → `REASONS.push`.
  - The PR nudge test (line ~226) now asserts the text does **not** match `/2400|timeout/`, and does match `/pr-wait/` and `/bg_bash/`.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd guard && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `codeOf` treats `bg_bash` like `bash`.
  - In `checkToolCall`, for `bash` only:
    - a timeout on a `/thatsit-app\.ts\s+(?:pr|gateway-pr)\b(?!-wait)/` command → `prTimeout`;
    - any `/thatsit-app\.ts\s+(?:pr-wait|gateway-pr-wait|ship)\b/` command → `waitInBackground`.
  - The PR nudge's "(bash timeout 2400)" becomes "(run pr, then run pr-wait with bg_bash)", and its listed commands are adjusted to match.
  - In the README, replace the 2400s paragraph with the two new rules.
- [ ] **Step 4: Run tests and typecheck**
  Run: `cd guard && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -am "feat(guard): no timeouts on pr; CI waits go through bg_bash"`

---

### Task 5: SKILL.md: the new flow

**Files:**
- Modify: `skills/thatsit-app/SKILL.md` (line 12 and every step that runs `ship`, `pr` or `gateway-pr`)
- Test: `skills/thatsit-app/test/skill-md.test.ts`

- [ ] **Step 1: Write the failing test**
  `SKILL.md sends CI waits through bg_bash and sets no timeouts`: the body doesn't match `/2400|timeout \d/`. It matches `/bg_bash/`, `/pr-wait/`, `/gateway-pr-wait/` and `/bg-bash-done/`.
- [ ] **Step 2: Run it and see it fail**
  Run: `cd skills/thatsit-app && npm test`. Expected: FAIL.
- [ ] **Step 3: Rewrite.** The flow in imperative lines:
  1. `pr` (no timeout) prints `RESULT` with `pr`. Tell Michael the PR link.
  2. Run `pr-wait` with the `bg_bash` tool and end the turn.
  3. When the `bg-bash-done` message arrives, `exited 0` means posting the preview link from `RESULT`. Anything else means fixing the cause, committing, then `pr` and `pr-wait` again.
  4. `ship` and `gateway-pr-wait` work the same way through `bg_bash`.
  5. Never set a bash timeout on these commands, and never `sleep`/poll.

  Keep the "body stays short" test passing. If it doesn't, cut elsewhere.
- [ ] **Step 4: Run tests**
  Run: `cd skills/thatsit-app && npm test`. Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -am "docs(thatsit-app skill): pr returns at once; wait for CI with bg_bash"`

---

### Task 6: Hub: no closing a session that has jobs, no push until they're done

**Files:**
- Modify: `hub/src/handle.ts:13-32` (SessionHandle), `hub/src/rpc-handle.ts` (implement), `hub/src/bridge-handle.ts` (implement, always false), `hub/src/registry.ts:169-171` (`isIdle`), `hub/src/turns.ts:40-44`
- Test: `hub/test/registry.test.ts`, `hub/test/turns.test.ts`, `hub/test/rpc-handle.test.ts`

**Interfaces:**
- Consumes: the `bg-jobs` status from Task 1, which arrives as an `extension_ui_request` `setStatus` (`rpc-handle.ts:436`).
- Produces: `SessionHandle.hasBackgroundJobs(): boolean`. For rpc it's `Boolean(this.statuses["bg-jobs"])`; for bridge it's `false`.

- [ ] **Step 1: Write the failing tests**
  - rpc-handle: `a bg-jobs status marks the handle as having background jobs; clearing it unmarks`.
  - registry: `reap leaves an idle session with background jobs alone`; `makeRoom never picks a session with background jobs` (with all others busy → 503).
  - turns: `a run that ends while background jobs run sends no outcome`; `the run that ends after they finish sends finished`. Fake handles get `hasBackgroundJobs`.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd hub && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  `isIdle` adds `&& !h.hasBackgroundJobs()`. In `turns.ts`, `t.running` is still reset on idle, but `onOutcome` is skipped while `h.hasBackgroundJobs()`. Update every fake handle in hub tests to include the new method.
- [ ] **Step 4: Run tests and typecheck**
  Run: `cd hub && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -am "feat(hub): keep sessions with background jobs alive and hold their push until the jobs finish"`

---

### Task 7: Side panel: the latest PR

**Files:**
- Modify: `shared/src/progress.ts` (`Progress`, `deriveProgress` opts), `app/src/render/progress.ts` (new section, rendered before subagents), `app/src/lib/progress-store.ts:105`, `hub/src/progress-routes.ts:71` (pass the new opt)
- Test: `shared/test/progress.test.ts`, `app/src/lib/progress-store.test.ts`, plus a render test next to the existing progress render tests if there are any

**Interfaces:**
- Consumes: a bash/bg_bash toolCall `arguments.command`; toolResult text holding `RESULT {...}`; bg_bash toolResult `details.id`; a `custom` message with `customType: "bg-bash-done"` whose first content line is `bg_bash job <id> exited <code>` (Task 1).
- Produces:
  - `type PrCi = "running" | "passed" | "failed" | "lost" | "none"`
  - `interface LatestPr { url: string; number: number | null; title: string | null; ci: PrCi; preview: string | null; gatewayPreview: string | null; reason: string | null }`
  - `Progress` gains `pr: LatestPr | null`
  - `deriveProgress(conv, opts: { live: boolean; bgRunning?: boolean })`

Derivation rules:
- The latest bash toolResult for a `thatsit-app.ts (pr|gateway-pr) ` command (not `-wait`) whose `RESULT` has `ok: true` and `pr` sets `url` and `number`. `title` comes from that call's `--title "..."` argument.
- The latest `bg_bash` call after it whose command contains `pr-wait` or `gateway-pr-wait`:
  - no such call → `ci: "none"`;
  - a matching `bg-bash-done` by job id, exit 0 → `passed`, with `preview`/`gatewayPreview` taken from its `RESULT`;
  - exit ≠ 0 → `failed`, with `reason` = the first line of `RESULT.reason`, or else the first output line;
  - no done message and `live && bgRunning !== false` → `running`;
  - otherwise → `lost`.
- A newer `pr` result resets `ci` to whatever that PR's own wait job says. An older preview never shows next to a newer push.
- `ship` results are ignored.

- [ ] **Step 1: Write the failing shared tests (`shared/test/progress.test.ts`)**
  - `no PR in the session → pr is null`.
  - `pr result alone → url, number, title, ci "none"`.
  - `pr then a running pr-wait job → ci "running"`.
  - `done exit 0 → ci "passed" with preview, and gatewayPreview when RESULT has it`.
  - `done exit 1 → ci "failed" with the reason's first line`.
  - `pr-wait with no done message and the session not live → "lost"`; `live but bgRunning false → "lost"` (Review Focus 4).
  - `a second pr after a passed preview → the new PR's state, preview null until its own wait passes` (Review Focus 3).
  - `ship results do not create a PR`.
- [ ] **Step 2: Run them and see them fail**
  Run: `cd shared && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement `deriveProgress`'s `pr`.**
- [ ] **Step 4: Run them and see them pass**
  Run: `cd shared && npm test`. Expected: PASS.
- [ ] **Step 5: Render and wire**
  - `prSection(view)` renders nothing when `pr` is null. Otherwise it renders `<section>` with heading `pr`, then:
    - a link row: `#<number> · <title>` to `url`, with `target="_blank" rel="noopener"`;
    - then by `ci`:
      - `passed`: a `preview` link row (plus a `gateway preview` row when that's present);
      - `running`: "CI running…";
      - `failed`: "CI failed: <reason>";
      - `lost`: "CI result lost";
      - `none`: nothing.
  - Reuse the existing section/row classes from `progressStyles`, with no new colors.
  - The store passes `bgRunning: Boolean(snapshot.statuses?.["bg-jobs"])`, and the hub route passes `bgRunning: h?.hasBackgroundJobs()`.
  - Add a store test: `progress pr goes from running to lost when the bg-jobs status disappears without a done message`.
- [ ] **Step 6: Run tests and typecheck for app, shared and hub**
  Run: `cd app && npm test && npm run typecheck; cd ../shared && npm test; cd ../hub && npm test`. Expected: PASS.
- [ ] **Step 7: Commit**
  `git commit -am "feat(progress): the latest PR and its preview in the side panel"`

---

### Task 8: A live run, then rollout

- [ ] **Step 1: Check the full suite**
  Run every package's `npm test` and `npm run typecheck` (bg, guard, skills/thatsit-app, hub, shared, app). Expected: all PASS.
- [ ] **Step 2: Check pi-web shows a turn started by the extension**
  Don't use `pi -p` for this: print mode exits after one turn, and `session_shutdown` kills the job. Start a headless session through the dev hub/e2e harness (`app/e2e/hub-for-e2e.ts`) and pin the model to `spark/qwen3.8-flash-next`, because without it pi falls back to 27b. Ask the session to `bg_bash` `sleep 5; echo 'RESULT {"ok":true}'`. Then check three things:
  - the turn ends with the `bg-jobs` status set and no push;
  - the bg-bash-done turn streams into the open session;
  - a push goes out after that turn.

  If the extension-started turn doesn't appear, fix the hub's RPC event handling here, with a test.
- [ ] **Step 3: Ask Michael, then finish**
  Ask Michael before restarting the hub, because a restart kills headless sessions. Once he agrees, finish the branch with superpowers:finishing-a-development-branch: merge to master and restart the hub. Then run one real PR on a test app: `pr` returns in seconds, the panel shows "CI running…", pi wakes up with the preview, and one push arrives.
