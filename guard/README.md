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
| ci | `gh run list/watch/view` (not `--log-failed`), `gh pr checks`, `sleep` of 60 s or more | `pr` / `ship`, which wait for CI |
| e2e | the full e2e suite (`npm run e2e`, `playwright test` with no spec), only in apps with an `e2e:one` script | `npm run e2e:one -- e2e/x.spec.ts`, and `npm run verify` before a commit |
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
question, with no `pr`, `ship` or `gateway-pr` after the last edit, and git says the app still has work to
publish (uncommitted changes, unpushed commits, or a branch never pushed), the guard adds a visible `pi-guard-pr`
message: branch if needed, commit, run `pr` itself with a 2400 s timeout, and never hand Michael commands to run.
At most 2 per user prompt.

## pr and ship timeouts

A bash call that runs the skill's `pr`, `ship` or `gateway-pr` with a timeout under 2400 s is blocked: those wait
for CI (usually 3-6 min) and print progress while they do, and a short cap kills them mid-wait.

## Where the numbers come from

Replaying the 6-day keeb session (Nov 3-8 2026, 2,600 model calls) through these rules: it would have
blocked 51 pushes, 65 CI polls (3.8 h of waiting), 99 full e2e runs and 64 Python rewrites, and nudged at
exactly the 7 turns that ended empty or mid-sentence, all of which Michael had to restart by hand. None
of the 53 real replies would have been nudged.

## Install

Listed in `~/.pi/agent/settings.json` `packages` as `../../workspace/pi-web/guard`.
