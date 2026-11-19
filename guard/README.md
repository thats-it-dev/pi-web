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
| merge | `gh pr merge`, `gh pr close`, `gh api` on a PR's merge endpoint, in any directory | nothing: green CI ends the work; Michael merges (keeb #28 was merged by the orchestrator on 2026-11-16, five seconds after `pr-wait` came back green) |
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
message: branch if needed, commit, run `pr` itself, wait for CI with `pr-wait` through `bg_bash`, never hand Michael commands to run, and never merge: Michael merges. (The `bg` extension's `bg-bash-done` message for a green `pr-wait` says the same, so the rule is read at the moment it matters even when the skill was never loaded.)

## Merge handed to Michael

When a run ends on a reply that carries `gh pr merge` or `gh pr close` (inline or in a code block) or tells Michael to
merge ("only your merge remains", "merge it now"), the guard adds a visible `pi-guard-merge` message and continues once:
write the reply again without the command, give the PR and preview links, say whether CI is green. The merge *command*
was already blocked (see above); this is its text form. Why: in the website session of 2026-11-19 the guard blocked
`gh pr merge 2 --merge --admin`, the model wrote "Merging is yours, not mine", and seven minutes later its reply said
"Run this to ship the repo state: `gh pr merge 2 --merge`". The rule lived in the thatsit-app skill, which that
non-app repo never loaded, so it is also now in `~/.pi/agent/AGENTS.md` for every repo.

The same nudge covers any other git repo under `~/workspace`, keyed by the repo's git root: edited this run, no
`git push` or `gh pr create` naming it (by path or cwd) after the last edit, and work left to publish against its
`main` or `master`. Its text says to branch, commit, call the reviewer, then push and `gh pr create` itself.

## Checkout left on a merged branch

The first tool call of a session that works in an app (a shell command or edit path naming `~/workspace/apps/<name>`,
or a worker brief naming it) checks the checkout once: on a branch other than `main`, with a clean tree, and `gh` saying
that branch's PR is merged, the guard switches it to `main` (fast-forwarding when it can) before the call runs and adds a
`[pi-guard] … switched it to main` line to the call's result. A dirty tree, an open PR, `gh` failing, or a child session leave it alone.
Why: on 2026-11-16 keeb's checkout still sat on the merged accuracy-tracker branch; the worker's commit landed on it, and
moving it to a fresh branch cost a conflicted cherry-pick that dropped two spec items before they were restored.

None of these three nudges fires while a `bg_bash` job the run started has not sent its `bg-bash-done` message, or
an async `subagent` run it launched or revived has not sent its `subagent-notify` message: ending the turn is the plan
then, and the done message starts the next one.
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
- The task gets a header with the changed files, the base, "verify passed, don't check tests or config", the
  budget, and Michael's last message on the branch word for word, with the rule that every behavior he names must
  have a test in the diff that drives that input, or the verdict is BLOCK (a test asserting the behavior he called
  wrong is a BLOCK too). Why: on 2026-11-17 the keeb orchestrator's brief and reviewer task both dropped "space and
  enter switch layers instead of typing"; the worker wrote a test asserting space is the layer-1 switch, 432 tests
  passed, the review passed, PR #30 opened with the bug intact. The call is forced to `async: false`, `cwd` = the app (so its AGENTS.md is project context) and
  `toolBudget` `{soft: 12, hard: 20, block: "*"}`; `context`, `model`, `thinking`, `tools`, `skill` overrides are dropped.
- The app is the one named in the task (an apps path or `/tmp/<name>-review.diff`), else the call's own `cwd`, else the
  session cwd. A reviewer call the guard can't tie to an app gets `[pi-guard] this review is not scoped to an app …` on
  its launch result, because it will never count. Why: on 2026-11-16 the keeb orchestrator passed `cwd` = the app on
  every reviewer call and, from 00:51, a diff path relative to it; the guard read only the task and the session cwd, so
  eleven reviews in a row (ten of them "No issues found.") were never scoped, and `pr` stayed blocked for 2 h 48 min.
- A reviewer inside a workflow, chain or task list on an app is blocked.
- When the review returns without error and its reply holds a verdict (a `## Review` block with a finding or a merge
  verdict line, with or without a list dash and emphasis, or as a heading such as `## Merge verdict: OK` or
  `#### P1 — …`, or `No issues found.`), the guard appends `[pi-guard] reviewed <dir> at <snapshot>` to its result:
  the PR gate and the next review's base read that mark from the session, so both survive a restart. A reply without
  a verdict (the reviewer stopped mid-review, or left its report in its reasoning, as the 35B did at thinking low on
  2026-11-12) gets a `review ended without a verdict` note instead and counts for nothing, so the PR stays blocked
  and the next review covers the same changes. An async review's reply is read from its run's session file when its
  pending mark is resolved; an unreadable transcript never counts.
- A review whose reply says `Merge verdict: BLOCK` (or, with no verdict line, holds a P0 or P1 finding) counts for
  nothing: it never opens the gate and never becomes the next review's base, so the fix is reviewed together with the
  change it fixes. A sync BLOCK gets `[pi-guard] review blocked <dir> at <snapshot>` instead of the reviewed mark; an
  async one is read from its transcript. A second reviewer call on the same tree is blocked with the P0/P1 findings
  sent to the worker, or, if the orchestrator is sure a finding is wrong, to Michael. Why: on 2026-11-17 18:27 the keeb
  reviewer wrote `**Merge verdict: BLOCK**` with a P0, the orchestrator decided in its reasoning that the P0 was
  hypothetical, asked the reviewer to "re-verify" with its own counter-evidence, got "nothing changed since the last
  review, go on to pr" from the guard, and pushed.
- A design doc or plan (`docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md`) is reviewed too. A `pr` that
  adds or changes one is blocked until a scoped review ran, like a code PR. A reviewer call on a docs-only diff skips
  the verify and screen gates and gets a doc brief instead of the code one: check every claim about the code against
  the source it names, a plan against the spec it implements (goals without a task or test, interfaces that don't
  match, steps a worker can't follow as written), spec.md sections it renumbers, and Michael's request point by point.
  Why: on 2026-11-17 Michael asked flash to review the plan for PR #31; the guard demanded `npm run verify` for a
  Markdown diff, then briefed the reviewer to cite a test per named behavior in a diff with no code.
- When Michael's request names a file by path that exists (`~/workspace/keymaps/go60-36.json`), the brief makes
  that file the oracle, above `docs/spec.md` and above the tests: the reviewer opens it, picks ten entries the change
  reads, writes down what each means in its own format and checks that against the value the tests expect (or the
  fixture copied from the file). An expected value that repeats the code's output is a P1 and BLOCK; where the spec
  and the file disagree, the file wins. The doc brief checks every rule the document states about reading such a
  file against the file's entries. Why: keeb PR #31 (2026-11-17, flash): every test the reviewer cited passed, and
  their expected values were the code's own output (`7 · Sym` for a key that types `&`, all shifted symbols folded
  to the key underneath); the design doc stated the same rule and three reviews passed it. Running the file through
  the code was the only thing that showed it.
- When `pr` is blocked on the review gate, the reason ends with why: no scoped review since Michael's last message,
  the last one still running (wait for its message), ended BLOCK, ended without an accepted verdict, or failed. After three blocks
  with no new review in between, the reason opens with a stop order: tell Michael the PR is blocked and end the turn.
  Why: the same keeb session blocked `pr` 16 times while the orchestrator re-ran verify and the reviewer each time and
  finally reported that "the guard's LLM is looping".

The reviewer itself is `agents/reviewer.md`, symlinked to `~/.pi/agent/agents/reviewer.md`: read-only tools, diff
first, no test or config spelunking, and the same tool budget in its frontmatter.

### Any other repo under `~/workspace`

A git repo under `~/workspace` that is not an app gets the same gate at its own publish point: `git push` and
`gh pr create` are blocked until a scoped review finished since Michael's last message, or the tree is exactly as the
last review left it (`pi-guard` reason `reviewRepo`). A reviewer call is scoped by its `cwd` or a path in its task, with
the git root as the dir (a worktree is reviewed as itself), against the repo's `main` or `master`. Verify is required
only when the repo has a `verify` script, and there is no screen gate (the screenshot command is the app skill's). Why:
the website session of 2026-11-19 pushed a 77-file branch from `~/workspace/ref/worktrees/website-next` and opened its
PR with no review at all, because only apps were gated.

## Look at the screen

Verify proves the code runs; nothing in it shows what the app draws. The fret app (2026-11-13) shipped a fretboard
styled with invented `--tk-*` tokens: every colour and border resolved to nothing, verify stayed green and three
reviews passed the diff. So a review, a `pr` that changes UI files (`index.html`, `src/**`, `public/**.css`) and
every `ship` are blocked until the orchestrator has looked at the screen as the UI files are now:

- The skill's `thatsit-app.ts screenshot <dir> [--path /route] [--scheme light] [--click "<selector>"] [--upload <file> [--into "<selector>"]]` serves the
  working tree with the app's own Vite dev server and takes a phone-size picture with the app's own Playwright
  (about a second). `--click` presses the control that opens a dialog, menu or tab once the app has rendered, so a
  change inside one is pictured; the comparison text says so, because on 2026-11-14 21:32 a toggle alignment fix in
  the settings dialog passed the gate as "not visible in this screenshot".
  `--upload` sets a file on the app's file input after the click and closes any dialog left open, so the picture
  shows the app with Michael's data. When his request names a file by path and the command did not upload it, the
  result opens with a note asking for the picture again with `--upload <file>`; the mark records the file
  (`... with <file>`). Not a gate: an app that takes no file would never pass one. Why: keeb PR #31 pictured the
  default board, and the legend showing "9" where Michael's Sym layer types "(" was never seen.
- On that bash call the guard snapshots the tree; on its result it appends the picture itself as an image block,
  so the model sees the screen in the same turn, plus `[pi-guard] screen seen <dir> at <snapshot>`. A failed
  command, a `RESULT` without a file, or a picture over 2 MB leaves no mark.
- Between the picture and the mark come the things to compare it with: `docs/spec.md` as written (not the
  starter; cut at 8000 characters) and the last two pictures Michael sent on the branch, each with the words
  they came with (a reference look, or the broken screen he saw), then the comparison the orchestrator owes:
  what differs in elements, order and side, colours by role, labels and numbers. The pictures come from the
  session branch, so they survive compaction. Why: on 2026-11-13 22:08 the orchestrator checked a screenshot
  note by note, correctly, and passed a board with the nut on the wrong side and no degree numbers, because
  "looks right" was judged against its own idea and not the spec or the reference Michael had sent.
- The gate passes while no UI file differs between the last pictured snapshot and the working tree; briefs, docs
  and tests may change freely. A UI edit after the look needs a new picture.

## Workers and the request itself

- A `subagent` resume appends its message to the worker's session file, and a `stop` ends the run but leaves the
  message there, so the next resume reads it as open work: on 2026-11-14 the orchestrator sent "remove the dialog
  border", Michael's "the dialog border is ok" stopped that run within 45 s, and 29 minutes later the next resume
  on the same worker removed the border anyway. Now the first resume after a stop on that worker gets a
  `[pi-guard] Michael stopped your previous run ... which withdraws the follow-up it carried: "..."` line before its
  message. The chain of runs (launch, each revive) is read from the branch; a run that had finished before the stop
  withdraws nothing.
- Every provider request is digested into `~/.pi/agent/tmp/pi-guard-prompts.jsonl`: time, pid, model, a hash of
  the system text, a hash per message, the payload size, and the system prompt sections by length (from
  `before_agent_start`). With the server's cached-token count per request this says whether a cold prefill came
  from a changed system prompt or an earlier message, and which. Why: the fret session of 2026-11-14 paid for
  eight full prefills on the 27b, about 18 of its 55 orchestrator minutes, and the server log shows the miss but
  not its cause.

