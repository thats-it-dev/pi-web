# Background bash, a fast `pr`, and PR links in the side panel

Date: 2026-11-10. Status: approved by Michael in chat.

## Why

In the keeb "daily time goal" session (2026-11-10, PR #20) pi kept running `thatsit-app.ts pr` with a 40-minute bash
timeout, and Michael said so twice, the second time angrily. That wasn't the model's choice. pi-web's guard
(`guard/rules.ts`, `PR_TIMEOUT_S = 2400`, added in bee1c79) blocks `pr`/`ship`/`gateway-pr` whenever the timeout is under
2400s. `SKILL.md:12` and the guard's end-of-turn PR nudge both say "timeout 2400" too. pi's attempts to get around
it (no timeout, `nohup`, handing the job to a subagent) were all blocked or failed.

The root problem is that `pr` blocks for CI (3-20 min) even though the PR link exists within seconds. Michael: "I don't
know why you needed to wait for CI, the URL was available on the PR." Only the preview link needs CI, because CI posts
it as a PR comment after it deploys.

## Goals

1. pi never sets a timeout on `pr`, `ship` or `gateway-pr`, and never sits blocked for minutes waiting on CI.
2. **General async tool calls:** a `bg_bash` tool pi can use for any long command. It returns right away, and pi
   gets a message that starts a new turn when the command exits.
3. `pr` returns the PR link as soon as the PR exists. CI and the preview are handled in the background, and pi
   **always** wakes up when they finish: it posts the preview link if CI passed, or starts fixing if CI failed.
4. The progress side panel shows the **latest PR only**: its link, then its preview link, with CI status until the
   preview is there.

## Non-goals

- No list of every PR in the session, and no list of running background jobs in the panel (Michael picked "latest PR only").
- No `bg_wait`/blocking-wait tool. A wait would bring the blocking back.
- Jobs don't survive pi itself stopping or the hub restarting. Losing them then is fine.
- No changes to app repos (`~/workspace/apps/*`) or the app template's CI.

## Anti-goals (a failure even if it technically works)

- pi still sits in a foreground call for minutes waiting on CI, through any path.
- A guard rule that again pushes pi toward one specific long timeout.
- A finished background job whose result never reaches pi, so it fails silently.

## Design

### 1. `bg_bash` extension (new, in pi-web)

A new pi extension package in the pi-web repo, `pi-web/bg/`, built the same way as `guard/` (`pi-package`,
`pi.extensions`), and added to `~/.pi/agent/settings.json` next to the guard.

Tools:

- **`bg_bash({ command, cwd? })`** starts `bash -lc <command>` detached (its own process group), with stdout and stderr going to a
  log file under the session's temp dir. It returns right away with `{ id, logPath }` and a short line ("started job
  bg-3; you'll get a message when it exits"). Several jobs can run at once.
- **`bg_status({ id? })`** returns each job's state (running / exited N), how long it has run, and the last ~40 lines of its log.
- **`bg_cancel({ id })`** kills the job's process group.

When a job exits, the extension calls
`pi.sendMessage({ customType: "bg-bash-done", content, display: true, details: { id, command, exitCode, durationMs, tail } }, { triggerTurn: true, deliverAs: "followUp" })`.
`content` is a short text giving the job id, the command (shortened), the exit code and the last ~60 lines of output.
If the command printed a `RESULT {...}` line, it's included in full, so pi copies URLs from it the same way it does now.
If pi is busy, `followUp` queues the message until the current turn ends. If pi is idle, `triggerTurn` starts a turn.

On `session_shutdown`, the extension kills all running jobs.

**The hub must not close a session while it has running jobs** (my call, so results aren't lost silently).
`hub/src/registry.ts` `reap()` closes headless sessions that have been idle for longer than `idleMinutes` (20). Its
headless-limit check (around line 194) also closes the least recently active idle session. Both must skip a session that
has a running `bg_bash` job. How the hub learns about running jobs is left to the builder. One option: the extension
publishes a job count through a status that the RPC bridge already forwards. The registry's `isIdle` has to take
it into account.

**Push notifications (Michael's call):** while a session has running jobs, the hub doesn't send its "finished"
push when a turn ends (`hub/src/turns.ts` / `notifier.ts`). Only the turn that ends with no jobs running sends one.
It uses the same signal as the reaper.

The exact signature for `sendMessage`/`triggerTurn` is in pi 1.0.2's `dist/core/extensions/types.d.ts`
(lines 330-335 and 1221-1231). The builder has to confirm one thing in the real pi-web hub: a turn started by an extension while the
session is idle shows up live in the app. Check the hub's RPC event handling. If it doesn't show up, fixing that is in scope.

### 2. `thatsit-app.ts`: `pr` stops waiting, new `pr-wait`

- **`pr <dir> --title --body [--gateway-pr N]`** pushes and opens or updates the PR as it does now, then prints
  `RESULT {"ok":true,"pr":"<url>","number":N}` and exits within seconds. **It no longer runs the local checks** (`localChecks`
  / `APP_CHECKS`: typecheck, test, lint, e2e) and no longer waits for CI or the preview. Michael's call: a PR may
  exist briefly before its checks pass.
- **`pr-wait <dir>`** (new) runs the local checks that `pr` used to run, then does what `pr` did after the PR existed:
  it waits for CI and the preview comment for the branch's current head commit (including the gateway-preview check). It prints `RESULT {"ok":true,"pr":...,"preview":...[,"gatewayPreview":...]}`
  or exits 1 with the reason (CI failure with the failing job, or a timeout). It keeps its own internal time limits,
  which are fine because they live inside the command, not in bash. It prints progress lines as it does now.
- **`gateway-pr` is split the same way** (my call): `gateway-pr` opens the gateway PR and returns
  `{pr, number}` right away; the new `gateway-pr-wait <dir>` does the rest (CI + the spark preview, with its 20-min budget) and prints
  `{pr, number, preview}`.
- `ship` doesn't change internally. It runs through `bg_bash` too.
- Split `lib/pr.ts`'s `openPr` into the open part and the wait part. Keep the existing tests passing, split along with
  it.

### 3. Guard and skill

- `guard/rules.ts`: remove `PR_TIMEOUT_S` and the `prTimeout` reason. New rules for the `bash` tool:
  - `pr` with **any** `timeout` set → blocked. The reason says: "pr returns in seconds; run it without a timeout."
  - `pr` and `gateway-pr` are allowed in `bash` (they're fast now).
  - `pr-wait`, `gateway-pr-wait` or `ship` run through `bash` at all → blocked. The reason says: "run it with bg_bash; you'll get a
    message when CI finishes." `bg_bash` running these commands is allowed.
  - Running these commands with `nohup`, `&` or `setsid` through `bash` is still blocked (same reason), so `bg_bash`
    is the only way to background them.
- The PR nudge (`rules.ts` ~296) drops "(bash timeout 2400)" and describes the new flow: run `pr`, then `bg_bash pr-wait`.
- `SKILL.md`: rewrite line 12 and every other place that mentions waiting on CI. `pr` returns the PR link right away;
  tell Michael the PR link, then start `pr-wait` with `bg_bash` (it runs the local checks and then waits for CI). When the `bg-bash-done` message comes in, post the preview
  link from `RESULT`, or fix the failure and push again (`pr` then `pr-wait`). Same for `ship`/`gateway-pr`. Never set
  a bash timeout on these commands.
- Update the guard README and tests.

### 4. Side panel: latest PR

Add a "PR" section to the progress panel (`shared/src/progress.ts` → `Progress`, rendered in `app/src/render/progress.ts`).
It is derived from the session's messages like the rest of the panel:

- the latest successful `pr`/`gateway-pr` result (`RESULT` with `pr`) gives the PR link and number. `ship` opens no PR
  and doesn't appear in the panel (my call). With `pr --gateway-pr N`, the app's PR is the one shown, and the
  gateway preview is shown next to its preview;
- a `bg_bash` job whose command contains `pr-wait`/`gateway-pr-wait` for that PR's app dir → status "CI running…";
- the matching `bg-bash-done` message: `RESULT` has `preview` → show the preview link (and the gateway preview, if any); exit ≠ 0 → "CI
  failed" with the first line of the reason;
- a wait job with no `bg-bash-done` whose session isn't live anymore (pi exited, the hub restarted) → "CI result
  lost". Never show "CI running…" for a job that can't finish.

The section shows only the latest PR: a PR link (`#N` + title if available), then either the preview link or the status. It's hidden when the
session has no PR. Links open in a new tab. Use kit styles like the existing sections.

## Constraints

- Only pi's harness, skill, kit and pi-web change. App code under `~/workspace/apps` is never edited.
- Bash timeouts in pi are in seconds, and when omitted no default timeout applies.
- Model: flash-next. The tool descriptions and guard messages are the guardrails. Keep them short and unambiguous.

## Left to the builder

- How exactly the job logs and process groups are managed. The tail lengths (~40/~60 lines) can be tuned.
- The exact wording of the tool descriptions and messages, as long as it follows the rules above.
- How the PR's title gets into the panel (from the `pr` call's `--title` argument is fine).

## Rollout

Tests (guard, thatsit-app lib, shared progress, bg extension) plus one real run: in a test app, a pi session runs `pr` →
`bg_bash pr-wait`, pi wakes up with the preview link, and the panel shows it. Then restart the hub (on master).
