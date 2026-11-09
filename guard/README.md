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

## Stalled turns

When a run that edited or wrote a file ends right after a tool result with a reply shorter than 250
characters that isn't a question, the guard adds a visible `pi-guard-nudge` message and continues once:
reply in chat if done, carry on if not, or ask. At most 2 nudges per user prompt.

## Where the numbers come from

Replaying the 6-day keeb session (Nov 3-8 2026, 2,600 model calls) through these rules: it would have
blocked 51 pushes, 65 CI polls (3.8 h of waiting), 99 full e2e runs and 64 Python rewrites, and nudged at
exactly the 7 turns that ended empty or mid-sentence, all of which Michael had to restart by hand. None
of the 53 real replies would have been nudged.

## Install

Listed in `~/.pi/agent/settings.json` `packages` as `../../workspace/pi-web/guard`.
