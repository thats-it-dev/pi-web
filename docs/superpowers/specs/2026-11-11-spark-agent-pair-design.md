# Spark agent pair: 27b orchestrator, 35B-A3B subagents

**Date:** 2026-11-11. **Status:** design, awaiting Michael's approval.

## Intent

One app's plan (the cad plan was the trigger) lands sooner on the wall clock, by using the
GB10's spare capacity for parallel subagents instead of one 34 tok/s stream. Today pi runs
`qwen3.8-flash-next` whose 74.9 GiB of weights leave a 559k-token KV pool: room for one
worker beside the orchestrator, and that worker starts cold. The 2026-11-11 cad session
(13 h, 1,233 turns) showed 14 of 20 worker subagents timing out, ~95% of their time in
decode, and the orchestrator redoing tasks inline faster. The hardware is bandwidth-bound,
so one stream uses about a third of what batching gets; the win is many streams, not a
faster one.

## Decisions (Michael's, 2026-11-11)

1. Goal: a single plan finishes sooner. Not multi-app throughput, not overnight runs.
2. `qwen3.8-27b` replaces flash-next as pi's model, to free the memory subagents need.
3. Subagents run on `qwen3.6-35b-a3b-sglang` (Qwen3.6-35B-A3B NVFP4 + DFlash2). Bonsai 2
   is out: on this box it's 33 tok/s and ~60 SWE-bench Verified against the MoE's measured
   120 tok/s and 73.4.
4. Task N+1 may start before task N's review lands; findings come back as a fix step.
5. Independent plan tasks may run as parallel workers in worktrees.
6. Throughput over responsiveness: run as many workers as memory allows; a sluggish chat
   while a plan runs is accepted.

## Goals

- Critical path per plan task under ~40 min (cad baseline: ~73 min with subagents, ~45 min
  inline), measured on a replay of cad Tasks 2–4.
- No task starts cold: its brief carries the file excerpts, seams and test names it needs.
- The per-task gate stays: `npm run verify` green, guard-scoped reviewer, commit.

## Non-goals

- Bonsai 2, a second llama.cpp engine, or any new model download beyond the 35B checkpoint.
- Changing flash-next's serving; it simply isn't loaded while the pair is.
- Multi-Spark, pi-web UI changes beyond what the model switch forces.

## Anti-goals (failure even if it "works")

- An OOM, a hung box or a reboot. Measured free memory after both engines boot must stay
  ≥ 10 GB (the 35B study saw swap and a frozen box past that).
- Two workers editing the same files, or a worker opening a PR (the thatsit-app PR flow is
  the orchestrator's).
- A mid-plan swap back to flash-next. Flash and the pair are in exclusive llama-swap groups;
  one request to a flash model unloads both engines and costs 4 min plus every warm cache.
- Losing the guard's scoped review (it writes the incremental diff and budgets the reviewer).

## Constraints and measured facts

| Fact | Value | Source |
|---|---|---|
| GB10 memory visible to sglang | 121.6 GiB, ~273 GB/s, unified | `~/Qwen3.6-35b-SGLang-DGX-Spark/numbers.md` |
| flash-next weights / KV pool | 74.9 GiB / 559k tokens | vLLM boot log, 2026-11-10 |
| 27b weights | ~15 GB NVFP4 + BF16 lm_head (23 GB dir); DFlash2 draft 3.6 GB | HF cache |
| 27b KV per token (fp8) | target 32 KiB (16 full-attn layers × 4 KV heads × 256 × K,V); draft 16 KiB (5 layers × 8 × 128), sliding window 2048 | config.json of both |
| 27b speed on one GB10 | ~48–50 tok/s c=1, ~148 combined at c=8 (community; not yet measured here) | OpenZeka, NVIDIA forum |
| 27b chat template | `enable_thinking` and `reasoning_effort` supported | `chat_template.jinja` |
| 35B-A3B weights | 24.5 GB target + 1.2 GB draft | best-config.txt |
| 35B-A3B KV per token | 10 KB target + 12 KB draft (fp8) | best-config.txt |
| 35B-A3B speed, this box | c=1: 120 tok/s mean, 163 code; c=8: 280 combined / 50 per stream; c=10: 301 / 44 | numbers.md, 2026-10-02 |
| 35B-A3B capacity | 4.7 full 262k contexts at fraction 0.5; ~2.4 more per +0.1 | numbers.md |
| 35B-A3B chat template | `enable_thinking` only: no effort levels | `chat_template.jinja` |
| Engine overhead beyond its fraction | ~9 GB (0.5 × 121.6 = 60.8 reserved, 52 GB free after boot) | numbers.md |
| Checkpoint state | only `nvidia/Qwen3.6-35B-A3B-NVFP4` is cached; the measured `unsloth/…-NVFP4` + `incoai/…-DFlash2` draft must be downloaded (~26 GB, 3.1 TB free) | HF cache, start.sh |
| Workload (cad run) | worker: 72k output tokens, 60 turns, context 94k–190k, 50–66% thinking; reviewer: 18k, 9 turns; orchestrator context peaked at 250k | session logs |
| Guard app detection | `appDir()` takes the first path segment after `~/workspace/apps/` | `guard/rules.ts:23` |
| pi-subagents worktrees | default root `~/workspace/apps/worktrees/<app>/pi-worktree-<run>-<i>`; `worktreeBaseDir` overrides the root; roots inside the repo are refused | pi-subagents docs/configuration.md |

## Architecture

### Serving (llama-swap)

Both engines are members of one group with `swap: false, exclusive: true` (the existing
`duo` group already pairs them; its fractions are what's wrong). Starting fractions, to be
replaced by measured ones in phase 0:

| Engine | Fraction | Reserved | Weights | Left for KV/state | Streams |
|---|---|---|---|---|---|
| `qwen3.8-27b` (sglang, DFlash2 K=8) | 0.32 | 38.9 GB | 18.6 GB | ~18 GB ≈ 370k tokens ≈ 1.4 full contexts | `--max-running-requests 3`: orchestrator + final reviewer + headroom |
| `qwen3.6-35b-a3b-sglang` (sglang, DFlash block 8) | 0.42 | 51.1 GB | 25.7 GB | ~24 GB ≈ 1.1M tokens ≈ 4 full / ~7 at 160k | `MAX_CONCURRENT_REQUESTS=8` |
| Both + overhead | 0.74 | 90 + ~18 | | | ~13 GB free, floor 10 |

27b's `--max-total-tokens` and the 35B `.env` (`MEM_FRACTION_STATIC`, `MAX_CONCURRENT_REQUESTS`,
pinned `MODEL_ID`) change accordingly. The 35B `start.sh` auto-sizes `MAX_TOTAL_TOKENS` to
`MAX_CONCURRENT_REQUESTS × 262144`, which at 8 overshoots the 0.42 budget, so it is capped
explicitly (the worker-context budget above, ~1.1M tokens). llama-swap gets a `concurrencyLimit` above the planned
fan-out so excess requests queue in sglang rather than getting a 429.

### pi model config

- `models.json`, spark provider: the `qwen3.8-27b` entry gains the same `compat` block as
  flash-next (`thinkingFormat: chat-template`, `chatTemplateKwargs` with `enable_thinking` and
  `reasoning_effort`) and a `thinkingLevelMap`; today it has none, so effort is silently
  ignored. The 35B entry gets `enable_thinking` only.
- `settings.json`: `defaultModel: spark/qwen3.8-27b`; a compaction override for 27b sized to
  its 262k window (the orchestrator hit 250k on flash's 500k window, so expect roughly twice
  the compactions; the reserve is the builder's number); `subagents.defaultModel:
  spark/qwen3.6-35b-a3b-sglang`; `agentOverrides` for `scout`, `reviewer`, `worker` pointing
  at the 35B (today scout and reviewer are pinned to flash-next: left alone, one review
  would unload the pair); `httpIdleTimeoutMs` raised so a long prefill behind other streams
  isn't abandoned at 5 min; parallel concurrency 6 to start.
- The `flash-auto` package is removed from `settings.json` packages while the pair is pi's
  model. Any chat that picked flash-auto would otherwise trigger the group swap. pi-web's
  last-picked-model memory must land on 27b; the `flash-auto` status line and the
  superpowers reasoning floor are flash-only and become no-ops.
- `~/.pi/agent/agents/worker.md` (created 2026-11-11: tool budget 40, orient in ≤ 10
  calls, first edit by ~10, read with read tools not bash, stay in cwd) stays; it gets the
  35B via the override, not frontmatter.

### Roles and models

| Role | Model | Tools | Runs | Notes |
|---|---|---|---|---|
| Orchestrator (pi session) | 27b | all | 1 stream | writes plans, briefs, merges, runs verify and the PR flow |
| Scout | 35B | read-only | 2 in parallel, async | prefetches the next task's brief material while the current task runs |
| Worker | 35B | read, grep, find, ls, bash, edit, write, contact_supervisor | 1 per task; N in parallel for independent tasks, each in a worktree | medium-effort equivalent: thinking on, per-turn `maxTokens` 32768, run deadline from pi-subagents |
| Task reviewer | 35B | read-only | async, overlapped with the next task | guard-scoped diff; reports P1/P2 with file:line; the guard marks it on completion |
| Final reviewer | 27b | read-only | once per plan | whole-branch review on the stronger model, one of 27b's extra slots; the guard keeps the `model` because 27b is resident |

### Plan execution (the harness contract)

The orchestrator follows `executing-plans` with these pi-specific rules, carried by the
pi note the pi-web superpowers extension prepends (today's note says "inline only"; it
becomes mode-aware):

1. **Prefetch.** When task N starts, two scouts run async for task N+1: the files it names,
   their seams, the test files and names, the spec sections. Their output (≤ 2k tokens each,
   paths not pasted bodies where possible) goes into N+1's brief.
2. **Brief.** Every worker brief carries: the task text from the plan, the scout findings,
   acceptance (the exact failing test to write first, the verify command), the budget rules,
   and "do not open a PR, do not push". Briefs live in the plan's `.superpowers/sdd/` workspace
   as today.
3. **Write.** One worker per task on the plan branch, launched as an **async single**
   (`async: true`, with `checkpointBeforeDeadlineMs`): the orchestrator stays awake to take
   scout and reviewer results, steer the worker on a P1, and resume it after a deadline.
   Composite `tasks:[…]` fan-outs have no deadline or checkpoint, so a parallel group is N
   separate async singles. pi-subagents infers an acceptance review for an async writer
   (`acceptanceRole: writer`); it is turned off (`acceptance: { level: "none" }`) because
   the gate is the orchestrator's verify plus the guard-scoped reviewer, not an unscoped
   second reviewer per worker.
   For a task group the plan marks as independent, one worker each with `worktree: true`;
   the orchestrator merges the branches in plan order onto the plan branch and reruns verify
   after each merge. **Worktrees are bare checkouts**, so: pi-subagents links the main checkout's `node_modules` into each one itself (Playwright browsers already live in `~/.cache`);
   workers in worktrees run typecheck and unit tests only, never e2e (ports collide and the
   guard blocks a full e2e outside `verify` anyway); the full `npm run verify` runs once in
   the main checkout after each merge. The plan branch is committed before a fan-out, since
   allocation refuses a dirty checkout; `.superpowers/sdd/` is self-ignored so briefs don't
   count.
4. **Gate.** On the worker's commit: verify; on green, spawn the task reviewer async and
   immediately start N+1. Findings arrive as the `subagent-notify` message pi already
   delivers.
5. **Fix.** Findings queue to the next task boundary, except a P1 touching a file the
   current task edits, which is fixed now. Each fix is RED → GREEN plus a green suite, as
   executing-plans requires.
6. **Final.** After the last task: final review on 27b, one fix pass, then the thatsit-app
   PR steps. Never finishing-a-development-branch.
7. **Runaways.** The 35B has no effort levels, so caps are the harness's job: the worker's
   tool budget, pi-subagents' run deadline with a checkpoint before it, and the per-turn
   token cap. A worker that hits its deadline hands off state on disk; the orchestrator
   resumes or finishes inline, as today.

### Guard changes (`~/workspace/pi-web/guard`)

- **Async scoped reviews.** `scopeReview()` today forces `async = false` and strips
  `model`, so Decision 4 cannot happen under it. It keeps everything that makes the review
  scoped (cwd, the incremental diff and its base, the budget, the header) and allows
  `async: true`. The review mark that satisfies the PR gate and sets the next review's base
  moves from the launch's tool result to the completion: the guard records the snapshot at
  launch and writes the mark when that run's `subagent-notify` arrives with a finished
  report. A review that is still running, timed out or failed leaves no mark, so the PR
  gate still means "a completed review covers HEAD".
- **Model override only for resident models.** `model` is kept when it names a model in the
  currently loaded llama-swap group (the guard asks `127.0.0.1:9000/running`), and stripped
  otherwise. That lets the final review run on 27b and makes the mid-plan swap to flash
  impossible from a reviewer call.
- `appDir()` maps `~/workspace/apps/worktrees/<app>/…` to `~/workspace/apps/<app>`, so a
  worker running in a worktree is governed as that app (edit rules, verify, review scoping).
  Alternatively `worktreeBaseDir` is set somewhere the guard already understands; the
  builder picks.
- The PR reminder (`pi-guard-pr`) fires for the parent session only. Today it reached
  workers and one stopped to ask which instruction to obey.
- Review scoping keeps working across worktree merges: the incremental diff base is the
  last reviewed commit on the plan branch, not the worktree's.

### Superpowers extension (`~/workspace/pi-web/superpowers`)

The pi notes for `writing-plans` and `executing-plans` become mode-aware: with the pair
configured (session model 27b, subagent default 35B) they describe the contract above;
otherwise they keep the 2026-11-11 inline-only text. `writing-plans` additionally asks the
plan to mark independent task groups explicitly, since rule 3 depends on it.

## Phase 0: measure before switching

All of this needs flash-next unloaded, so it waits for the running cad session to finish.
Each gate is a number written into this document's "Measured" section before phase 1.

1. **Co-load.** Boot both engines at the starting fractions. Record free memory after boot
   (floor 10 GB), KV tokens per engine, and that llama-swap reports both ready.
2. **Contention.** 27b c=1 tok/s alone; then while the 35B serves 4 and 8 workers on
   realistic prompts (a worker turn: ~120k prompt, 2k output). 35B per-stream at c=4 and c=8
   with 27b active. Chunked-prefill stalls on both engines (p95 inter-token gap).
3. **Replay.** Run cad Tasks 2–4 from the plan under the pair, with the contract above.
   Compare against the 2026-11-11 inline numbers: wall-clock per task, verify pass on
   first try, reviewer findings, worker timeouts.

Go if the per-task critical path beats ~45 min and nothing in the anti-goals happened.
If the 27b stream collapses under load (throughput-first still needs it to finish a turn),
the builder lowers worker concurrency before touching fractions.

## Builder-check answers (my calls, 2026-11-11)

A fresh reviewer read this document as the engineer who'd build it and asked three
questions. None changes what Michael decided; the answers are now in the sections above:

1. The guard allows async scoped reviews and marks them on completion; `model` survives
   when it names a resident model (Guard changes).
2. Workers are async singles with checkpoints; parallel groups are N async singles; the
   inferred acceptance review is off (Plan execution, rule 3).
3. Worktree workers get a `node_modules` symlink, run typecheck and unit tests only, and
   the full verify runs once per merge in the main checkout (Plan execution, rule 3).

Also from that check: pi-subagents' own config file (`~/.pi/agent/extensions/subagent/config.json`,
for `parallel.concurrency`, `timeoutMs`, `checkpointBeforeDeadlineMs`, `worktreeBaseDir`)
doesn't exist yet and is created in phase 1; pi-web's `LastModelStore`
(`hub/src/last-model.ts`) is rewritten to 27b at the switch.

## Addendum (Michael, 2026-11-11, after plan review)

Three additions. They change the orchestrator checkpoint, replace the "full switch" with a
router, and allow phase 0 to start now.

### 1. The 27b is the pi fine-tune: `bytkim/Qwen3.8-27B-pi-FP8`

SFT on successful pi sessions plus GRPO with an effort-ordered reward; on Terminal-Bench 2.1 it
matches the base at xhigh (67/89) while running at **medium with ~41% fewer output tokens**
(37.4k vs 63.5k per task), and reaches 71/89 at xhigh ([blog](https://huggingface.co/blog/bytkim/qwen38-27b-pi),
[FP8 card](https://huggingface.co/bytkim/Qwen3.8-27B-pi-FP8)). Its template keeps
`enable_thinking` and `reasoning_effort` low/medium/xhigh. Ships as BF16, block-wise FP8
(~30.4 GB) and GGUF; **no NVFP4**. The base's MTP heads are preserved and the DFlash2 draft
(incoai mirror, 3.85 GB) is stated to work with either target format, but neither was
retrained on the tune, so acceptance length is a phase-0 number.

Consequences, replacing the serving table above:

| Engine | Fraction | Reserved | Weights | Left for KV/state | Streams |
|---|---|---|---|---|---|
| `qwen3.8-27b-pi` (sglang, FP8 weights, FP8 KV, DFlash2) | 0.44 | 53.5 GB | 34.2 GB | ~19 GB ≈ 400k tokens ≈ 1.5 full contexts | `--max-running-requests 3` |
| `qwen3.6-35b-a3b-sglang` | 0.32 | 38.9 GB | 25.7 GB | ~13 GB ≈ 600k tokens ≈ 4 workers at 150k | `MAX_CONCURRENT_REQUESTS=6` |
| Both + overhead | 0.76 | 92 + ~18 | | | ~11.6 GB free, floor 10 |

FP8 reads twice the bytes per step of NVFP4: on vLLM at c=16 FP8 was ~25% slower than NVFP4
([forum](https://forums.developer.nvidia.com/t/qwen3-8-27b-on-dgx-spark-using-vllm-nvfp4-vs-fp8-performance/380258)),
and one user saw 10–12 tok/s single-stream with vLLM+MTP on FP8. With sglang+DFlash the
expectation is ~30 tok/s against the base's ~48, paid back by the 41% token cut. Phase 0
runs an A/B (base NVFP4 vs pi FP8: tok/s at c=1, DFlash accept length, output tokens and
wall-clock on one fixed pi task). If the pi tune loses on wall-clock, the fallback is a
self-quantized NVFP4 of `bytkim/Qwen3.8-27B-pi` (llm-compressor, the RadixArk BF16-lm_head
recipe), a separate task; the base NVFP4 stays serveable for that comparison.

### 2. A router picks the model and the level: `spark/pair-auto`

flash-auto's controller is reimplemented for the pair. pi's default model becomes the virtual
`spark/pair-auto`; per user message it decides a level and the level implies the engine:

| Readout level | Engine | Thinking |
|---|---|---|
| off | 35B-A3B | off (`enable_thinking: false`) |
| low | 35B-A3B | on |
| medium | 27b-pi | `reasoning_effort: medium` |
| xhigh | 27b-pi | `reasoning_effort: xhigh` |

- The one-token readout keeps flash-auto's prompt and letters (so the frozen benchmark set
  and `FLASH_PROMPT_VERSION` still apply) but runs on the **35B** with thinking off: it is
  always resident and fast. Same sticky rules: continuation and retry reuse the turn's
  decision; go-ahead and steering keep the previous one; a failed decision falls back to
  **medium (27b-pi)**, never to a model that isn't loaded.
- The `flash-auto-floor` session entry keeps its name and meaning on the four-level scale:
  the superpowers switch's `medium` floor therefore pins a plan-running chat to 27b-pi.
- Subagents are not routed: scout, reviewer and worker stay pinned to the 35B through
  `agentOverrides`; the final reviewer names `spark/qwen3.8-27b-pi`.
- Switching engines mid-session costs a prefill of the context on the other engine unless its
  radix cache still holds the prefix. The decision is per user message, never per tool step,
  so a turn never switches; phase 0 records TTFT right after a switch at ~100k context.
- `flash-auto` (the virtual model that targets flash-next) is no longer registered while the
  pair is pi's model: its fallback path would dispatch to flash-next and trigger the group
  swap. The package stays installed; it now provides `pair-auto`. It registers whichever router
  `settings.json`'s `defaultModel` names (a `pair-auto` default selects the pair; anything else keeps
  flash-auto), so the switch is one settings edit and the revert is restoring it; `PI_PAIR_AUTO=1` /
  `PI_FLASH_AUTO=1` override for tests.
- The virtual model declares `contextWindow: 262144`, the smaller of the two.

### 3. Phase 0 may start now

Michael allowed stopping the running cad pi session and unloading flash-next. The switch plan
gains a Task 0 that stops that session (pi process `PI_WEB=1`, started 2026-11-10 20:44 PT,
and its detached worker runner) and unloads flash through llama-swap.

**Config staged 2026-11-11** (harness plan Task 6, inert until the switch): `~/.pi/agent/extensions/subagent/config.json`
(parallel 8/6, 45-min deadline, 5-min checkpoint; **no worktree hook**: pi-subagents 0.76 links the main checkout's
`node_modules` into every worktree itself and reports it synthetic, `runs/shared/worktree.js` `linkNodeModulesIfPresent`,
so the hook the plan described was removed after the final review), `~/.pi/agent/agents/worker.md` (`acceptance: none`),
`~/.pi/agent/models.json` (new `qwen3.8-27b-pi` entry; `qwen3.8-27b` and the 35B gain their `compat` blocks;
backup `models.json.bak-2026-11-11`).

## Measured (phase 0)

**Task 0 (2026-11-11 12:06 PT):** cad session stopped (pi pid 4169216 and its worker runner), flash-next container
stopped, `llama-swap /running` empty, MemAvailable 115.9 GB. The cad checkout stays on branch `cad-v1` at
`5fecb5b` (task 11 step 4) with its four uncommitted files. Lesson: `kill -HUP llama-swap` reloads the config but
drops its running-model state; the next proxied request re-runs the model's `cmd`, which for `flash serve` restarted
the container cold. Reload llama-swap only when nothing needs the loaded model.

**Task 1 (12:14 PT):** downloads done (bytkim pi tune FP8 33 GB, incoai 27B DFlash2 3.6 GB, unsloth 35B NVFP4, incoai 35B DFlash2 @51ef7b6), serving config in place (`run-27b-pi.sh` :8001 at 0.44, 35B `.env` 0.32 / 6 slots / 600k tokens, llama-swap groups `duo` = pair, `base27` = base), reloaded.

**Task 2 (12:25 PT), co-load:** `--mem-fraction-static` is a fraction of the memory *free when that engine starts*
(sglang profiles pre-load memory), so the pair boots sequentially. Measured:

| Engine | Boot order | Free at its start | Fraction | Weights | KV pool (tokens) | Free after |
|---|---|---|---|---|---|---|
| `qwen3.8-27b-pi` (FP8 + DFlash2) | 1st | 107.2 GB | 0.44 | 27.8 GB | 291,400 (≈1.1 full contexts, `--max-running-requests 3`) | 58.5 GB |
| `qwen3.6-35b-a3b-sglang` (+ DFlash2) | 2nd | ~58 GB | 0.70 | 23.8 + 1.4 GB | 453,514 (≈3 workers at 150k; 6 slots) | **13.4 GB** |

Floor (10 GB) met. The 35B's first attempt at 0.32 beside the still-loading pi tune failed ("weights leave no GPU
memory for the KV cache", min viable 0.351): the fractions in the Addendum table were written as if of the box.
The `.env` now says `MEM_FRACTION_STATIC=0.70`, valid only when the pi tune is already up; llama-swap's `duo`
group starts members on demand, so the orchestrator must be requested first (plan 2 Task 5 makes pi do that).

**Task 3a (12:31 PT), readout on the 35B** (flash-auto's frozen test split, 66 items, idle, the pi-tune A/B running
on the other engine): exact **55%**, within-one **94%**, p50 285 ms, p95 345 ms, 0 failures (flash on its 44-item
run: 70% / 100%, p50 260 ms). Confusion (label → readout): off 11/11; low → off 15, low 6, medium 3; medium → off 3,
low 3, medium 10, xhigh 4; xhigh → low 1, medium 1, xhigh 9. The readout under-calls (23 too little, 7 too much),
mostly `low → off`, which changes nothing in the pair (both run on the 35B). Counting only the engine decision
(off/low → MoE, medium/xhigh → tune) it is right on **56/66 = 85%**; the costly direction is `medium → off/low`
(6 of 20), a medium task landing on the MoE with thinking. Below the plan's bars (60% / 95%) but recorded and
accepted: the fallback is medium (tune), and a bias toward medium on close calls can be tuned later from the
decision log's probabilities. Rows: `~/workspace/flash-auto/results/test-idle-35b.jsonl` (private, gitignored).

**Task 3b (12:34–13:24 PT), A/B — pi tune at medium** on cad Task 3 (brief `task-3-brief.md`, scratch worktree at
`649259e`, `pi -p -ne -e guard`, 25-min cap):

| Run | Wall | Turns | Tool calls | Output tokens (thinking) | Max context | Finished? |
|---|---|---|---|---|---|---|
| 1 | 25 min (cap) | 17 | 20 | 30,586 (≈16,300) | 47k | no; tests not green |
| 2 | 25 min (cap) | 12 | 13 | 34,494 (≈23,200) | 37k | no; `src/sketch/` written, no tests yet |

Engine during the runs (35B idle): **21.4 tok/s decode, DFlash accept length 3.48**. Wall-clock output rate ≈ 20–23
tok/s. For scale, flash-next's worker finished this task in ~50 min at 34 tok/s with 86k tokens. The FP8 weights
read twice the bytes of NVFP4 per step; the tune's token saving (at "medium" it still spent ~2/3 of its tokens
thinking here) does not cover the gap. Verdict waits for the base runs below.

**Task 3c (13:25 PT), pi tune alone** (`bench/pair-contention.mjs --workers 0`, 21k-token prompt, 1.5k output): decode
**20.8 tok/s**, TTFT 23.8 s (≈890 tok/s prefill), p95 inter-token gap 197 ms, DFlash accept 6.2 on this prose prompt
(3.5 on the agent runs). **Engine switch:** the same 100k-token prompt, warm on the 35B then cold on the tune: 157 s to
first token (≈640 tok/s prefill). A `pair-auto` switch at a 100k context therefore costs ~2.5 min on the first turn.
Readout probes on the 35B: p95 274 ms.

**Task 3d (13:34–14:24 PT), A/B — base 27b (NVFP4 + DFlash2) at xhigh**, same brief, base, harness and cap:

| Model / effort | Run | Wall | Turns | Tool calls | Output tokens (thinking share) | Max ctx | Engine decode (accept) | Finished? |
|---|---|---|---|---|---|---|---|---|
| pi tune FP8 / medium | 1 | 25 (cap) | 17 | 20 | 30,586 (53%) | 47k | 21.4 tok/s (3.48) | no |
| pi tune FP8 / medium | 2 | 25 (cap) | 12 | 13 | 34,494 (67%) | 37k | ~21 tok/s | no (`src/sketch/` written) |
| base NVFP4 / xhigh | 1 | 25 (cap) | 13 | 19 | 22,972 (56%) | 45k | 31.2 tok/s (4.28) | no (`test/sketch.test.ts` written) |
| base NVFP4 / xhigh | 2 | 25 (cap) | 10 | 15 | 13,730 (78%) | 35k | 23.4 tok/s (3.17) | no (nothing written) |

Token counts exclude the turn in flight when the cap hit (pi records a message only when it completes), so they
undercount by up to one turn each; "tests" only ever meant the pre-existing suite. **Neither model finished the
task in 25 min** (flash-next's worker took ~50 min), so the wall-clock rule is inconclusive. Per token the base
is 1.3–1.5× faster (27 vs 21 tok/s; the community's ~48 for this box did not reproduce with this image/config).
The tune's thinking share at "medium" (53–67%) was no lower than the base's at xhigh. The memory cost stands:
the FP8 tune leaves the 35B 453k KV tokens (~3 workers) where NVFP4 weights would leave ~15 GB more.

## Left to the builder

- Exact fractions, `max-total-tokens`, concurrency and the compaction reserve, from phase 0.
- How the superpowers notes detect the mode (settings read at discovery vs a saved entry).
- The merge procedure for parallel worktrees and how it is recorded in the plan ledger.
- Whether the task reviewer's budget changes with the faster model.
- Whether to keep `~/.pi/agent/agents/worker.md`'s read-tool block at 40 for a model that
  decodes 3.5× faster.

## Risks

- The 35B numbers are a month old and were taken with the unsloth checkpoint at
  `MAX_CONCURRENT_REQUESTS=2`; c=8 at a 0.42 fraction with 160k contexts is extrapolated.
- 27b's speed on this box is community data; its DFlash acceptance on tool-call-heavy
  output is unknown.
- Qwen3.6-35B-A3B is a generation older than 27b; its tool-call reliability under pi's
  tool schema hasn't been exercised here.
- Two sglang engines contend for one memory bus; the contention test is the first thing
  that can kill this design.
