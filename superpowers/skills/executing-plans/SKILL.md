---
name: executing-plans
description: Use when an approved plan under docs/superpowers/plans is to be implemented, task by task, in this session
---

# Executing Plans

The plan already did the thinking. Execute it exactly, prove each step with a
test you watched fail and then pass, and tick the plan as you go so the record
survives compaction.

## Setup

- Read the plan once, and the spec it names: the spec is the authority the
  plan argues from, and a conflict inside the plan resolves against it.
- Branch first: `git switch -c <short-kebab-name>` before the first commit
  (in an app under `~/workspace/apps`, the thatsit-app skill's flow does it).
  Never implement on `main` or `master`.
- Read the test-driven-development skill (next to this one) before Task 1.
  It governs every step below.

## The task loop

For each task, in plan order:

1. **Work the steps in order.** They are already RED → GREEN: write the test,
   run it and watch it fail, implement, run it and watch it pass, commit as the
   plan's commit step says. Every step with an `Expected:` line is compared
   against real output, never against what the diff looks like.
2. **Tick as you go.** Change each step's `- [ ]` to `- [x]` in the plan file
   with the edit tool as soon as the step is done, before the next step. Never
   tick a step you skipped or that failed.
3. **When output and plan disagree:** if the code is wrong, use the
   systematic-debugging skill; never patch the symptom to make the output
   match. If the plan is wrong (a step contradicts the spec, an interface from
   an earlier task does not match, a command cannot work), decide the smallest
   change that satisfies the spec, write `Ruling: <what> — <why>` under the
   task in the plan file, and continue.
4. **Keep going.** Don't check in between tasks. Four things stop you, and
   only these: a destructive or irreversible operation, a security-sensitive
   action, a push, merge, deploy or publish, and a plan so broken that every
   path forward is a guess. For those, stop and ask.

Narrate at most one short line between tool calls; the plan file and the tool
results carry the record. Long test output goes to a file you read the tail of.

## Finish

- After the last task: in an app under `~/workspace/apps`, run the thatsit-app
  skill's Review step (`subagent` with agent `reviewer`; the guard scopes the
  diff) and then its pr steps. Elsewhere, call `subagent` with agent `reviewer`
  on the branch and open the PR with `gh`.
- Fix the findings you confirm in one pass, each with a failing test first and
  a green suite after. A finding you decline is a ruling: note it in the plan.
- Open the PR, post its link, and end your turn. Michael merges.
- Your final message lists the rulings you made and the minors you deferred.
  It is the only place the decisions you took on his behalf reach him.
