# Review gate: one gate, tied to the tree, two rounds

**Status:** agreed with Michael 2026-11-25 (Keep/Merge #2 of the 2026-11-24 harness review, `~/reports/pi harness simplification review.md`); built the same day in `guard/`.

## Problem

The review gate had grown into about fifteen state-carrying rules, several patching earlier ones: a review counted
"since Michael's last message"; a BLOCK shut the gate; a ship override reopened it on his words; a stop order fired
after three blocked `pr` calls; a second review of the same tree was refused. Each rule came from one incident
(keeb 2026-11-16, 11-17, 11-22, 11-23). On the website session of 2026-11-24 the pre-PR chain ran review → BLOCK →
fix → BLOCK → fix → CLEAN → push for 21 minutes after Michael had said "Perfect", and a guard nudge then started
another 22-minute chain for a dead-code deletion.

## The gate

`pr` / `gateway-pr` in an app, `git push` / `gh pr create` in any other repo under `~/workspace`, when the change
touches code or a design doc, is allowed when **either**:

1. **The tree is reviewed.** The working tree (uncommitted and untracked files included, lockfiles and build output
   left out) is exactly the snapshot a scoped review covered, and that review did not end BLOCK (`upToDate`).
2. **Two rounds ended BLOCK.** Two scoped reviews of the repo ended BLOCK on different trees since the last publish
   (`blockedRounds >= REVIEW_ROUNDS`, 2). The second BLOCK's result says the gate is open (`REVIEW_ROUNDS_OPEN`);
   the PR body lists the open P0/P1 findings and Michael decides at the PR.

Nothing else opens it. In particular Michael's messages neither open nor shut it: "ship it" after one BLOCK costs one
more round at most, and a new request on an unchanged, reviewed tree needs no new review. An edit after a counted
review, a P2 fix included, needs a review of the new tree (the diff covers only what changed since).

Before a reviewer call, unchanged: verify green when the repo has a `verify` script, a screenshot newer than the last
UI edit in an app, and no second review of a tree whose review ended BLOCK (`reviewBlockedSame`): change the tree
first, or tell Michael which finding is wrong.

## What went

- `reviewedSinceUser` (a review counted for the rest of the turn; his next message shut the gate).
- `shipOverride` (his ship order after a review opened the gate).
- The stop order after three blocked `pr` calls (the rounds cap bounds the loop instead).
- `reviewGap`'s message-relative reasons; it now explains the tree: no scoped review yet, tree changed since the last
  counted review, last review running / BLOCK round n of 2 / no verdict / failed.

## Why these choices

- **Tree, not messages** (Cognition 2026, Anthropic best practices, the 11-23 sixth-review loop): a gate that checks an
  artifact has no false positives from wording, and the orchestrator can reason about it ("is the tree as reviewed?").
- **A cap, not an override**: the override keyed on Michael's words and patched the gate; the cap bounds any loop
  without reading anyone's intent, and still puts the decision where it belongs, at the PR.
- **Strict on post-review edits**: fixing "OK with notes" after the review and shipping unreviewed is how slips
  happened; the cost is one short incremental review.

## Measure

Per the review's protocol: reviewer rounds per PR, blocked `pr` calls per PR, time from "Perfect" to PR opened, on
the next five app PRs, against the 11-23 and 11-24 sessions (5 and 2 BLOCK rounds; 21 and 22 minutes of post-approval
review).
