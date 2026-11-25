# Harness measurement suite

The task set and logging harness for the measurement protocol in the 2026-11-24 harness review
(`~/reports/pi harness simplification review.md`). It answers one question with numbers: does a harness change
make the pi agent ship a web app faster, with fewer interventions and less rework, without lowering how often it
succeeds? The static per-request tax is already measured (see the "Harness Before and After" page); this measures
the end-to-end behaviour, which needs real runs.

## The 12 tasks (`tasks.ts`)

Three sizes, each with a judge-free oracle that passes or fails on its own:

- **Four one-line changes** on a frozen to-do app (`fixtures/`): a token swap, a copy change, a ghost button, and a
  deliberately-wrong unit test to fix. Oracle: an exact grep, or the test suite going green.
- **Four features** on the same app: a settings sheet, a stat tile, a persist toggle, a filter. Oracle: the app still
  builds and stays on the kit (`npm run guardrails` + `npm test`) **and** the feature's hallmark is present (a grep,
  so a no-op scores a fail, not a pass).
- **Two new apps** from the template: a tip splitter and a length converter. Same oracle shape.
- **Two keep-the-look refactors** on a frozen copy of the real website: tokenise the CSS colours, and dedupe the CSS.
  Oracle: `index.html`'s visible text and element structure are **identical** to the fixture (a redesign — the
  2026-11-24 failure — changes both), the refactor actually happened in `styles.css`, and the smoke test passes.

Every setup copies a committed tree into a throwaway `bench-<task>` dir (an app under `~/workspace/apps` for the app
tasks, a repo under `~/workspace` for the website tasks, so the real guard engages), runs, and is removed. Nothing
pushes, opens a PR, or touches a real app or the real website.

## Running it (`run.ts`)

The model must already be loaded in llama-swap; the runner never triggers a swap.

```
node bench/suite/run.ts --model inkling-2-mini --arm C --runs 3
node bench/suite/run.ts --model inkling-2-mini --arm C --task o2-copy-change,f1-settings-sheet --runs 1
```

Per task per run it records one row to `results/<arm>.jsonl`: wall-clock, timed-out, the oracle verdict and detail,
lint-violation count, and from the session file — assistant turns, tool calls by name, work vs harness turns,
input/output/reasoning tokens, cache-hit ratio, peak context, compactions, `ask_user_question` count, subagent
launches, and the models it ran on; and from the guard's logs over the run's window — blocks by reason key
(`pi-guard-blocks.jsonl`) and the fresh-request size and tool count (`pi-guard-prompts.jsonl`).

## The arms

An arm is a harness configuration. Comparing them means running the whole suite under each and labelling with `--arm`:

- **A** — the old harness (before the 2026-11-25 changes). Reconstructing it is manual: restore the 21-package
  `settings.json` and the removed checkouts. Headless `pi -p` is known to hang with the full old package set, so arm
  A may need the hub's RPC path or a partial reconstruction; note what you ran.
- **B** — the Remove list applied (the current 12-package `settings.json`).
- **C** — B plus the Add list (the guard as it stands now). B and C differ only in the guard commit, so toggle that.

pi reads `settings.json` per process, so switching arms is editing that file between suite runs; no restart.

## Reading it (`report.ts`)

```
node bench/suite/report.ts results/A.jsonl results/B.jsonl results/C.jsonl
```

Prints per-arm medians, a per-task pass-rate/wall grid, and last-vs-first deltas. The decision rule, which the report
leaves to you: a removal stays if it holds the pass rate and beats the baseline on wall-clock or tokens; an addition
stays if it lowers false-positive blocks, subagent rounds or lint violations without lowering the pass rate. Hand-tag
the blocks that were false positives by adding a `fpBlocks` count to a row (the block log has the reason key and a
command hash to judge each by); `report.ts` sums them.

## A stronger keep-the-look oracle

The keep-the-look oracle here is the offline floor: identical HTML text and structure plus the CSS refactor. The
report's stronger form is a pixel diff — `toHaveScreenshot` against a baseline captured from the fixture once. To add
it, render the finished dir with the bridge's static server (`bridge/static-server.ts`) and the template's Playwright,
and compare to a committed baseline PNG per task. It is left out here to keep the suite offline and dependency-free.

## Caveats

- Local Qwen-class models vary run to run (±2-3 points on Terminal-Bench), so three runs per task is the floor; single
  runs will not separate close configurations.
- The oracles measure "built it and kept it on the kit / kept the look", not subjective quality. That is deliberate:
  a judge-free oracle is reproducible, and the progress-mirage studies the review cites show an LLM judge is not one.
