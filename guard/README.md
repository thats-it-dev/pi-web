# @pi-web/guard

pi extension that turns the slow or unsafe habits a local model falls into on thatsit.app apps into
blocked tool calls with a one-line fix, and restarts a coding run that stops without a reply. Rules live
in `rules.ts` as pure functions; `index.ts` wires them to pi's `tool_call` and `agent_before_settle` events.

## Blocked tool calls

Only for commands that work in `~/workspace/apps/<name>` (a path in the command, or the session cwd).
Checked for `bash`, `ctx_execute` (shell and python) and `ctx_batch_execute`.

| Rule | Blocks | Use instead |
| --- | --- | --- |
| push | `git push` | the thatsit-app CLI's `pr` / `ship` |
| ci | `gh run list/watch/view` (not `--log-failed`), `gh pr checks`, `sleep` of 60 s or more | `pr-wait` / `gateway-pr-wait` / `ship` through `bg_bash` |
| e2e | the full e2e suite (`npm run e2e`, `playwright test` with no spec), only in apps with an `e2e:one` script | `npm run e2e:one -- e2e/x.spec.ts`, and `npm run verify` before a commit |
| worker-busy | `npm run verify`, `npm run e2e*`, `playwright test` while an async `worker` launched without `worktree: true` is still running in the app (its launch named the app, or its status.json's cwd or tool calls show it there; a worker that has not shown where it works yet holds every app) | wait for the worker's result, then run verify once; a worker that must run beside you gets `worktree: true` |
| rewrite | Python that writes files (`open(..., "w")`, `write_text`) in an app | the edit tool |
| discard | `git checkout <ref> -- <path>`, `git restore`, `git reset --hard`, only while the app has uncommitted changes | write the test first and run it red before the fix; `git show <ref>:<path>` to look at old code |

## Stalled turns

When a run that edited or wrote a file ends right after a tool result with a reply shorter than 250
characters that isn't a question, the guard adds a visible `pi-guard-nudge` message and continues once:
reply in chat if done, carry on if not, or ask. At most 2 nudges per user prompt.

## Open to-dos

When a run that did work (edited, wrote or used the `todo` tool) ends with a reply that isn't a question while the
session's to-do list still has items in progress or pending, the guard adds a visible `pi-guard-todos` message
listing them and continues: mark finished items completed, delete ones that no longer apply, or keep working.
At most 2 per user prompt. The list is read from the session branch, as rpiv-todo rebuilds it, so it survives
compaction. Replayed over all 88 sessions on the spark (2026-11-10), it fires 14 times in 3 sessions, each a
list pi left stale after finishing the work, and nowhere else.

## App changed, no PR

When a run edited or wrote files in an app (`~/workspace/apps/<name>`) and ended with a reply that isn't a
question, with no `pr`, `ship` or `gateway-pr` (through `bash` or `bg_bash`) after the last edit, and git says the app still has work to
publish (uncommitted changes, unpushed commits, or a branch never pushed), the guard adds a visible `pi-guard-pr`
message: branch if needed, commit, run `pr` itself, wait for CI with `pr-wait` through `bg_bash`, and never hand Michael commands to run.

None of these three nudges fires while a `bg_bash` job the run started has not sent its `bg-bash-done` message:
ending the turn is the plan then, and the done message starts the next one.
At most 2 per user prompt.

## pr timeouts and CI waits

A bash call that runs the skill's `pr` or `gateway-pr` with any timeout is blocked: those return as soon as the PR
is open, so a timeout means the model thinks it is waiting.

A bash call that runs `pr-wait`, `gateway-pr-wait` or `ship` is blocked outright, backgrounded or not: they wait on
CI, so they must go through the `bg_bash` tool, which wakes the agent with a bg-bash-done message when CI finishes.
`bg_bash` commands get the same shell checks as `bash`.

## Compaction summaries

i-have-adhd adds its rules as a message at session start and again after every compaction. pi's
summarizer read that message as the user's first request and made it the summary's goal, so the real
task could be lost. Before compaction the guard removes those messages (`REINJECTED_TYPES` in
`rules.ts`) from what pi summarizes; pi's own summarizer still writes the summary. This relies on pi
summarizing the same `preparation` object it passes to `session_before_compact` (true in pi 1.0.2).

## Long rewrites

A `write` over an existing app file of more than 80 lines (`OVERWRITE_LINES`) is blocked once per path and
the reason asks for small edits. Generation runs at about 34 tokens/s on the spark, so output is time: in
keeb's first guided-lesson run, rewrites of existing files and text copied inside edits cost about 15 of 81
minutes. Sending the same write again goes through, for a real rewrite.

## Where the numbers come from

Replaying the 6-day keeb session (Nov 3-8 2026, 2,600 model calls) through these rules: it would have
blocked 51 pushes, 65 CI polls (3.8 h of waiting), 99 full e2e runs and 64 Python rewrites, and nudged at
exactly the 7 turns that ended empty or mid-sentence, all of which Michael had to restart by hand. None
of the 53 real replies would have been nudged.

## Install

Listed in `~/.pi/agent/settings.json` `packages` as `../../workspace/pi-web/guard`.

## Scoped reviews

A `pr` or `gateway-pr` that changes code is blocked until a review the guard scoped has finished since Michael's last
message, or the app is exactly as the last review left it. Only a direct `subagent` call with agent `reviewer` counts;
on an app (an apps path or `/tmp/<name>-review.diff` in the task, or the session cwd), the guard rewrites that call:

- Blocked until `npm run verify` passed in the app after the last code edit (docs and Markdown edits don't count).
- The guard snapshots the working tree (uncommitted and untracked files included, in a throwaway index) and writes
  `/tmp/<name>-review.diff` itself: from the last review's snapshot, or from where the branch left main. Lockfiles,
  `dist` and source maps are left out. With nothing new since the last review the call is blocked.
- The task gets a header with the changed files, the base, "verify passed, don't check tests or config", and the
  budget. The call is forced to `async: false`, `cwd` = the app (so its AGENTS.md is project context) and
  `toolBudget` `{soft: 12, hard: 20, block: "*"}`; `context`, `model`, `thinking`, `tools`, `skill` overrides are dropped.
- A reviewer inside a workflow, chain or task list on an app is blocked.
- When the review returns without error and its reply holds a verdict (a `## Review` block with a finding or a merge
  verdict line, or `No issues found.`), the guard appends `[pi-guard] reviewed <dir> at <snapshot>` to its result:
  the PR gate and the next review's base read that mark from the session, so both survive a restart. A reply without
  a verdict (the reviewer stopped mid-review, or left its report in its reasoning, as the 35B did at thinking low on
  2026-11-12) gets a `review ended without a verdict` note instead and counts for nothing, so the PR stays blocked
  and the next review covers the same changes. An async review's reply is read from its run's session file when its
  pending mark is resolved; an unreadable transcript never counts.

The reviewer itself is `agents/reviewer.md`, symlinked to `~/.pi/agent/agents/reviewer.md`: read-only tools, diff
first, no test or config spelunking, and the same tool budget in its frontmatter.

