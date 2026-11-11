# Spark agent pair: harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pi harness can run a plan as the spec's contract: async guard-scoped reviews, worktree workers governed as their app, no nudges inside children, mode-aware superpowers notes, and the pi-subagents/worker config staged, all before any model is switched.

**Architecture:** Three code changes in `~/workspace/pi-web` (guard rules + guard wiring, superpowers extension) with node:test coverage, plus config files under `~/.pi/agent` that take effect only when plan 2 switches the model. Nothing here touches a model server or restarts pi-web's hub.

**Tech Stack:** TypeScript on Node 26 (`node --test`), pi extension API (`pi.on("tool_call" | "tool_result" | "agent_before_settle" | "resources_discover")`), pi-subagents 0.76 config.

**Spec:** `docs/superpowers/specs/2026-11-11-spark-agent-pair-design.md`

## Global Constraints

- Guard marks are text in tool results (`REVIEW_MARK = "[pi-guard] reviewed "`), so they survive restarts and compaction; new marks follow the same rule.
- The PR gate means "a completed review covers HEAD": a pending, running, failed or timed-out review never counts.
- A reviewer `model` is kept only when it names a model llama-swap reports as loaded; otherwise stripped, as today.
- The 2026-11-11 inline-only pi notes stay the default; the pair notes apply only when the pair is configured.
- Tests: `cd ~/workspace/pi-web/guard && npm test`, `cd ~/workspace/pi-web/superpowers && npm test`; typecheck with `npx tsc -p tsconfig.json` in each.
- Commit each task on `master` with a `fix(guard)` / `feat(guard)` / `feat(superpowers)` / `chore(pi)` prefix; do not push until the plan's last task.

## Review Focus

1. A scoped review launched async whose run dir vanishes (retention cleanup) before the PR: the gate must treat it as not reviewed, not crash the guard. Test in Task 3.
2. Two async reviews pending for the same app: `lastReview` must take the latest *completed* snapshot, never a pending one. Test in Task 3.
3. llama-swap down or slow when a reviewer call carries `model`: the guard strips `model` and never blocks the call on the lookup. Test in Task 4.
4. A command run from a worktree cwd with no app path in it (`npm test` in `~/workspace/apps/worktrees/cad/pi-worktree-x-0`): `appDir` must still return `~/workspace/apps/cad`. Test in Task 1.
5. A child session with `PI_SUBAGENT_CHILD` set still gets the blocking rules (push, discard, CI wait): only the nudges go. Test in Task 2.

---

### Task 1: Guard sees worktrees as their app

**Files:**
- Modify: `guard/rules.ts:23-34` (`appDir`)
- Test: `guard/test/rules.test.ts` (extend "appDir finds the app from the command or the cwd")

**Interfaces:**
- Produces: `appDir(command, cwd, home)` unchanged signature; `~/workspace/apps/worktrees/<app>/…` resolves to `~/workspace/apps/<app>` for both the command path and the cwd.

- [ ] **Step 1: Write the failing assertions** in the existing appDir test:

```ts
assert.equal(appDir("cd ~/workspace/apps/worktrees/cad/pi-worktree-ab12-0 && npm test", home, home), "/home/m/workspace/apps/cad");
assert.equal(appDir("npm test", "/home/m/workspace/apps/worktrees/cad/pi-worktree-ab12-0/src", home), "/home/m/workspace/apps/cad");
assert.equal(appDir("ls", "/home/m/workspace/apps/worktrees", home), undefined);
```

- [ ] **Step 2: Run** `cd ~/workspace/pi-web/guard && npm test -- --test-name-pattern appDir`. Expected: FAIL, first assertion returns `/home/m/workspace/apps/worktrees`.
- [ ] **Step 3: Implement** in `appDir`: after extracting the first segment, if it is `worktrees`, take the next segment as the app (undefined when there is none). Apply to both the command branch and the cwd branch.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npm test` and `npx tsc -p tsconfig.json`: all green.
- [ ] **Step 5: Commit** `git add guard && git commit -m "fix(guard): a pi-subagents worktree is governed as its app"`

### Task 2: No nudges inside a subagent child

**Files:**
- Modify: `guard/index.ts:214-226` (`agent_before_settle`)
- Test: `guard/test/index.test.ts`

**Interfaces:**
- Produces: `piGuard(pi, gitNeedsPr, env = process.env)` — third optional parameter so tests can set `PI_SUBAGENT_CHILD` without touching the real environment.

- [ ] **Step 1: Write the failing test:**

```ts
test("inside a subagent child the guard blocks but never nudges", () => {
	const h = load(() => true, { PI_SUBAGENT_CHILD: "1" });
	assert.equal(h.agent_before_settle({ outcome: "completed", context: { canContinue: false, contextMessages: stalled } }, { cwd: "/" }), undefined);
	assert.deepEqual(h.tool_call({ toolName: "bash", input: { command: "cd ~/workspace/apps/keeb && git push" } }, { cwd: "/" }), { block: true, reason: REASONS.push });
});
```

(Extend `load()` to pass the env through; check `REASONS.push` is the push reason's key in `rules.ts` and use the real one.)

- [ ] **Step 2: Run** `npm test -- --test-name-pattern "subagent child"`. Expected: FAIL, `agent_before_settle` returns a nudge entry.
- [ ] **Step 3: Implement:** `agent_before_settle` returns `undefined` first thing when `env.PI_SUBAGENT_CHILD` is set. `tool_call` and `tool_result` are unchanged.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "fix(guard): nudges are for the parent session, not subagent children"`

### Task 3: Async scoped reviews, marked on completion

**Files:**
- Modify: `guard/rules.ts:117-150` (`REVIEW_MARK`, `reviewMark`, `reviewedSinceUser`, `lastReview`)
- Modify: `guard/index.ts:121-160` (`scopeReview`) and `:195-206` (`tool_result`)
- Test: `guard/test/rules.test.ts`, `guard/test/index.test.ts`

**Interfaces:**
- Produces in `rules.ts`:
  - `export const REVIEW_PENDING_MARK = "[pi-guard] review pending "`
  - `export const reviewPendingMark = (dir: string, snap: string, runId: string) => \`${REVIEW_PENDING_MARK}${dir} at ${snap} run ${runId}\``
  - `export type RunState = (runId: string) => "complete" | "running" | "failed" | "missing"` — the default implementation reads `/tmp/pi-subagents-uid-${process.getuid()}/async-subagent-runs/${runId}/status.json` and maps its `state` field (`"complete"` as is; a missing file or unreadable JSON is `"missing"`; any other state is `"running"` unless it contains `fail`/`error`/`stopped`/`timeout`, then `"failed"`).
  - `reviewedSinceUser(branch, runState = defaultRunState)` and `lastReview(branch, dir, runState = defaultRunState)`: a finished mark counts as today; a pending mark counts only when `runState(runId) === "complete"`.
  - `export const asyncRunId = (resultText: string) => /Async: reviewer \[([0-9a-f-]{36})\]/.exec(resultText)?.[1]`
- Produces in `index.ts`: `scopeReview` no longer sets `input.async = false`; `tool_result` appends `reviewPendingMark` when `asyncRunId(text)` matches, else `reviewMark`.

- [ ] **Step 1: Write the failing rules tests:**

```ts
test("a pending review counts only once its run is complete, and the latest complete one sets the base", () => {
	const dir = "/home/m/workspace/apps/keeb";
	const res = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
	const branch = [{ type: "message", message: { role: "user", content: "go" } }, res(reviewPendingMark(dir, "aaaaaaa", "run-a")), res(reviewPendingMark(dir, "bbbbbbb", "run-b"))];
	const states: Record<string, ReturnType<RunState>> = { "run-a": "complete", "run-b": "running" };
	const runState: RunState = (id) => states[id] ?? "missing";
	assert.equal(reviewedSinceUser(branch, runState), true);
	assert.equal(lastReview(branch, dir, runState), "aaaaaaa");
	states["run-b"] = "complete";
	assert.equal(lastReview(branch, dir, runState), "bbbbbbb");
	assert.equal(reviewedSinceUser(branch, () => "missing"), false);
	assert.equal(reviewedSinceUser(branch, () => "failed"), false);
});

test("asyncRunId reads the run id from an async launch result", () => {
	assert.equal(asyncRunId("Run fan-out: 1/64 used\nAsync: reviewer [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]\n"), "0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b");
	assert.equal(asyncRunId("Async: worker [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]"), undefined);
});
```

- [ ] **Step 2: Run** `npm test -- --test-name-pattern "pending review|asyncRunId"`. Expected: FAIL, exports missing.
- [ ] **Step 3: Implement** the `rules.ts` interfaces above. `defaultRunState` lives in `rules.ts` with `readFileSync`; the uid root is a module constant so `index.ts` needs nothing new.
- [ ] **Step 4: Run** the pattern. Expected: PASS.
- [ ] **Step 5: Write the failing wiring test** in `index.test.ts`, next to the existing `scopeReview` tests (reuse their temp repo helper):

```ts
test("an async scoped review keeps async and gets a pending mark; a sync one gets the finished mark", () => {
	// arrange: verified app repo as in "scopeReview: blocks before verify…"; input { agent: "reviewer", task: "Review ~/workspace/apps/<name>", async: true }
	// act: h.tool_call(...) then h.tool_result({ toolCallId, toolName: "subagent", content: [{ type: "text", text: "Async: reviewer [0bdd2a04-7e76-4cca-8c02-1ad3fb71d86b]" }] })
	// assert: input.async === true; result text includes REVIEW_PENDING_MARK and "run 0bdd2a04-…"; a second call without async gets REVIEW_MARK
});
```

- [ ] **Step 6: Run** it. Expected: FAIL (`input.async` is false; mark is the finished one).
- [ ] **Step 7: Implement** the `index.ts` changes; `tool_call`'s `reviewed` callback passes no custom `runState` (the default reads `/tmp`).
- [ ] **Step 8: Run** `npm test` and `npx tsc -p tsconfig.json`. Expected: green.
- [ ] **Step 9: Commit** `git commit -am "feat(guard): scoped reviews may run async; the PR gate counts them when the run completes"`

### Task 4: Reviewer `model` survives when the model is resident

**Files:**
- Modify: `guard/index.ts:121-160` (`scopeReview`), `guard/index.ts` default export (inject the lookup)
- Test: `guard/test/index.test.ts`

**Interfaces:**
- Produces: `export type Resident = () => string[]` — model ids llama-swap reports in `running` with `state === "ready"`; default `defaultResident()` runs `curl -s --max-time 2 http://127.0.0.1:9000/running` via `execFileSync` and returns `[]` on any failure.
- `scopeReview(input, branch, cwd, home, resident: Resident = defaultResident)`: keeps `input.model` when `String(input.model).replace(/^spark\//, "")` is in `resident()`; deletes it otherwise. `thinking`, `context`, `tools`, `skill`, `usageBudget` are still deleted.
- `piGuard(pi, gitNeedsPr, env, resident)` passes it through.

- [ ] **Step 1: Write the failing test:**

```ts
test("scopeReview keeps a resident model and strips any other, and a failed lookup strips", () => {
	// verified app repo as above
	const resident = () => ["qwen3.8-27b", "qwen3.6-35b-a3b-sglang"];
	const keep = { agent: "reviewer", task, model: "spark/qwen3.8-27b" };
	assert.ok(!("block" in (scopeReview(keep, branch, home, home, resident) ?? {})));
	assert.equal(keep.model, "spark/qwen3.8-27b");
	const strip = { agent: "reviewer", task, model: "spark/qwen3.8-flash-next" };
	scopeReview(strip, branch, home, home, resident);
	assert.equal(strip.model, undefined);
	const down = { agent: "reviewer", task, model: "spark/qwen3.8-27b" };
	assert.ok(!("block" in (scopeReview(down, branch, home, home, () => { throw new Error("ECONNREFUSED"); }) ?? {})));
	assert.equal(down.model, undefined);
});
```

(`scopeReview` mutates the input object it is given, as the existing tests rely on.)

- [ ] **Step 2: Run** `npm test -- --test-name-pattern "resident model"`. Expected: FAIL, model stripped.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npm test`, `npx tsc -p tsconfig.json`. Expected: green.
- [ ] **Step 5: Commit** `git commit -am "feat(guard): a reviewer may name a model that is already loaded"`

### Task 5: Mode-aware superpowers notes

**Files:**
- Modify: `superpowers/index.ts` (`PI_NOTES`, `forPi`, `buildManualSkills`, `resources_discover`)
- Test: `superpowers/test/index.test.ts`

**Interfaces:**
- Produces: `export function pairMode(settings: unknown): boolean` — true when `defaultModel` ends with `qwen3.8-27b` and `subagents.defaultModel` ends with `qwen3.6-35b-a3b-sglang`.
- `export const PI_NOTES_PAIR: Record<string, string>` with entries for `writing-plans` and `executing-plans`.
- `forPi(name, md, notes = PI_NOTES)`; `buildManualSkills(src, out, exclude, supportOnly, notes = PI_NOTES)`; `resources_discover` reads `~/.pi/agent/settings.json` and passes `PI_NOTES_PAIR` when `pairMode` is true.

Note text (exact, so the model gets one contract):

- `writing-plans` pair note: "> **In pi (agent pair):** plans run with superpowers:executing-plans by the orchestrator, with subagents for scouting, writing and review as that skill's pi note describes. Don't ask which execution approach to use. Mark tasks that don't depend on each other's files or interfaces with a line `**Parallel group:** <letter>` right under the task heading; tasks in one group run as parallel workers in worktrees. A task without the line runs alone."
- `executing-plans` pair note: the seven rules of the spec's "Plan execution" section, as a numbered list, in this order: prefetch scouts for N+1 (2, async, read-only, ≤ 2k tokens each), brief contents, write (async single worker per task; a parallel group = one async single per task with `worktree: true`, merged in plan order, verify after each merge; worktree workers run typecheck and unit tests only), gate (verify → async scoped reviewer → start N+1), fix (queue to the boundary except a P1 on a file the current task edits), final (review on `spark/qwen3.8-27b`, one fix pass, thatsit-app pr steps, never finishing-a-development-branch), runaways (deadline + checkpoint; resume or finish inline).

- [ ] **Step 1: Write the failing tests:**

```ts
test("pairMode reads the pair from settings", () => {
	assert.equal(pairMode({ defaultModel: "spark/qwen3.8-27b", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), true);
	assert.equal(pairMode({ defaultModel: "flash-auto", subagents: { defaultModel: "spark/qwen3.6-35b-a3b-sglang" } }), false);
	assert.equal(pairMode(undefined), false);
});

test("the pair notes replace the inline-only ones", () => {
	const md = "---\nname: executing-plans\n---\nbody";
	assert.match(forPi("executing-plans", md, PI_NOTES_PAIR), /Parallel group|async single worker/);
	assert.doesNotMatch(forPi("executing-plans", md, PI_NOTES_PAIR), /never dispatch a `worker` subagent/);
	assert.match(forPi("writing-plans", md.replace("executing-plans", "writing-plans"), PI_NOTES_PAIR), /\*\*Parallel group:\*\* <letter>/);
});
```

- [ ] **Step 2: Run** `cd ~/workspace/pi-web/superpowers && npm test`. Expected: FAIL, exports missing.
- [ ] **Step 3: Implement** as in Interfaces; `resources_discover` reads settings with a try/catch (no settings → inline notes).
- [ ] **Step 4: Run** `npm test` and `npx tsc -p tsconfig.json`. Expected: green, including the real-install test.
- [ ] **Step 5: Commit** `git commit -am "feat(superpowers): pair-mode pi notes for writing-plans and executing-plans"`

### Task 6: pi-side config staged (inert until plan 2 switches the model)

**Files:**
- Create: `~/.pi/agent/extensions/subagent/config.json`
- Create: `~/.pi/agent/extensions/subagent/setup-worktree.mjs`
- Modify: `~/.pi/agent/agents/worker.md` (frontmatter)
- Modify: `~/.pi/agent/models.json` (spark `qwen3.8-27b` and `qwen3.6-35b-a3b-sglang` entries)

**Interfaces:**
- `config.json`: `{ "parallel": { "maxTasks": 8, "concurrency": 6 }, "timeoutMs": 2700000, "checkpointBeforeDeadlineMs": 300000, "worktreeSetupHook": "~/.pi/agent/extensions/subagent/setup-worktree.mjs", "worktreeSetupHookTimeoutMs": 30000 }`
- `setup-worktree.mjs`: reads the stdin JSON (`repoRoot`, `worktreePath`), symlinks `${repoRoot}/node_modules` to `${worktreePath}/node_modules` when the source exists, prints `{"syntheticPaths":["node_modules"]}`; exits non-zero with a message on any other error.
- `worker.md` frontmatter gains `acceptance: {"level":"none","reason":"the orchestrator's verify and guard-scoped reviewer are the gate"}`.
- `models.json`: the `qwen3.8-27b` entry gains `"thinkingLevelMap": {"minimal":"low","low":"low","medium":"medium","high":"xhigh","xhigh":"xhigh","max":"xhigh"}` and the flash-next `compat` block verbatim (`thinkingFormat: chat-template`, `chatTemplateKwargs` with `enable_thinking` and `reasoning_effort`); the 35B entry gains `compat` with `thinkingFormat: chat-template` and `chatTemplateKwargs: { "enable_thinking": { "$var": "thinking.enabled" } }` only (its template has no effort levels).

- [ ] **Step 1: Write the hook and a check:** run `echo '{"repoRoot":"'$PWD'/a","worktreePath":"'$PWD'/b"}' | node ~/.pi/agent/extensions/subagent/setup-worktree.mjs` from a scratch dir with `a/node_modules` present and `b` empty. Expected: prints `{"syntheticPaths":["node_modules"]}` and `b/node_modules` is a symlink to `a/node_modules`.
- [ ] **Step 2: Write `config.json`** and validate: `node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.pi/agent/extensions/subagent/config.json","utf8"))'`.
- [ ] **Step 3: Edit `models.json` and `worker.md`**; validate both parse: the JSON as in step 2; the frontmatter with `node -e` splitting on `---` and `JSON.parse` of the `acceptance:` value.
- [ ] **Step 4: Confirm nothing changed for the running setup:** `grep -c flash-auto ~/.pi/agent/settings.json` still reports the package and default model (plan 2 switches them).
- [ ] **Step 5: Commit** in pi-web only a note: append a "Config staged 2026-11-11" line to the spec's "Builder-check answers" section listing the four files, then `git commit -am "docs(superpowers): pair config staged under ~/.pi/agent"` and `git push`.
