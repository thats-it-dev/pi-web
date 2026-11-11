# Spark agent pair: serving switch and phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cad session is stopped and flash-next unloaded; the pi tune and the MoE boot together within the memory floor; the pi tune is A/B'd against the base; speeds under load and the readout's accuracy on the 35B are measured and written into the spec; pi runs on `spark/pair-auto`; a replay of cad Tasks 2–4 beats ~45 min per task, or the switch is reverted.

**Architecture:** Serving changes are a new launch script for the pi tune, the 35B `.env`, and `~/llama-swap.yaml`, measured by a Node bench script against the OpenAI endpoints and sglang `/metrics`. The pi switch is `settings.json` plus the hub's last-model file. Every gate writes its numbers into the spec's "Measured (phase 0)" section before the next task starts.

**Tech Stack:** llama-swap (SIGHUP reload), sglang in docker (the `~/run-27b.sh` image), Node 26 scripts, pi 1.0.2, pi-subagents 0.76, flash-auto's `bench/`.

**Spec:** `docs/superpowers/specs/2026-11-11-spark-agent-pair-design.md` (with its Addendum)

**Prerequisite:** the harness plan (`2026-11-11-spark-agent-pair-harness.md`) is done through Task 7 (Task 8's push may follow).

## Global Constraints

- Free memory after both engines boot ≥ 10 GB (`grep MemAvailable /proc/meminfo`); if not, lower the 35B fraction first (never below 0.28), then the 27b-pi's, re-boot, re-measure.
- 27b-pi stays `--max-running-requests 3`; worker concurrency is the knob, never a combined fraction above 0.80.
- Never load a flash model while the pair is up (exclusive groups); the only flash-next request allowed is the revert in Task 7.
- Backups before editing: `cp` each edited file to `<name>.bak-2026-11-11`.
- Numbers go into the spec under `## Measured (phase 0)`, one table per task, committed to pi-web master as `docs(superpowers): pair phase 0 — <task>`.

## Review Focus

1. The 35B `start.sh` auto-sizes `MAX_TOTAL_TOKENS` from `MAX_CONCURRENT_REQUESTS × 262144`; Task 2 pins it and Task 3 checks the boot-log value.
2. A worker-sized prompt (120k tokens) prefilling on the 35B while 27b-pi decodes: Task 4 records 27b-pi's p95 inter-token gap, not only its mean tok/s.
3. `subagent({action:"models"})` after the switch must show every builtin agent on `spark/qwen3.6-35b-a3b-sglang` and the session model as `spark/pair-auto`. Task 5 checks each row.
4. A `pair-auto` decision when the 35B is busy with 6 workers: the readout has a 1.5 s budget; Task 4 records readout latency under load and the fallback rate (`~/.pi/agent/flash-auto.jsonl`, `virtual: "pair-auto"`).
5. The first user turn after the router switches engines at ~100k context: Task 4 records TTFT on the engine that did not serve the previous turn.

---

### Task 0: Stop the cad session and unload flash-next

**Files:** none (process and llama-swap state).

- [ ] **Step 1: Identify** the cad session's pi process: `ps -eo pid,ppid,etime,args | grep -E "[p]i$"` and the one whose `/proc/<pid>/environ` has `PI_WEB=1` and whose start matches the session file `2026-11-11T04-44-44-048Z_…jsonl` (it was pid 4169216 at 11:46 PT). Also its worker runner: `ps -eo pid,args | grep subagent-runner-bootstrap`.
- [ ] **Step 2: Stop** the runner first (`kill <runner pid>`), then the pi process (`kill <pid>`; `kill -9` after 10 s if still alive). Expected: both gone from `ps`; the session file stops changing.
- [ ] **Step 3: Unload flash:** `curl -s 127.0.0.1:9000/` lists llama-swap's endpoints; use its unload endpoint for `qwen3.8-flash-next` (or `docker stop qwen38-flash`, which llama-swap treats as stopped). Expected: `curl -s 127.0.0.1:9000/running` shows no ready model; `MemAvailable` > 90 GB.
- [ ] **Step 4: Record** in the spec's Measured section: "Task 0: cad session stopped at <time>, last commit on its scratch branch <hash>, flash unloaded".

### Task 1: Downloads and serving config

**Files:**
- Create: `~/run-27b-pi.sh` (from `~/run-27b.sh`)
- Modify: `~/run-27b.sh` (base stays serveable for the A/B: `--mem-fraction-static 0.44`, `--max-running-requests 3`, `--max-total-tokens 400000`, `--enable-metrics`)
- Modify: `~/Qwen3.6-35b-SGLang-DGX-Spark/.env`
- Modify: `~/llama-swap.yaml`

**Interfaces:**
- `run-27b-pi.sh`: container `qwen38-27b-pi`, `--model-path bytkim/Qwen3.8-27B-pi-FP8`, `--served-model-name qwen3.8-27b-pi`, `--port 8001`, `--mem-fraction-static 0.44`, `--max-total-tokens 400000`, `--max-running-requests 3`, `--kv-cache-dtype fp8_e4m3`, `--enable-metrics`, the same DFlash flags as `run-27b.sh` but `--speculative-draft-model-path incoai/Qwen3.8-27B-DFlash2` at the revision the FP8 card names; keep `--reasoning-parser qwen3 --tool-call-parser qwen3_coder`.
- `.env`: `MODEL_ID=unsloth/Qwen3.6-35B-A3B-NVFP4`, `MEM_FRACTION_STATIC=0.32`, `MAX_CONCURRENT_REQUESTS=6`, `MAX_TOTAL_TOKENS=600000`.
- `llama-swap.yaml`: new model `qwen3.8-27b-pi` (`cmd: bash -c "bash ~/run-27b-pi.sh"`, `cmdStop: docker stop qwen38-27b-pi`, `proxy: http://127.0.0.1:8001`, `checkEndpoint: /v1/models`, `concurrencyLimit: 6`); group `duo` becomes `members: ["qwen3.6-35b-a3b-sglang", "qwen3.8-27b-pi"]`, still `swap: false, exclusive: true`; `qwen3.8-27b` (base) moves to its own group `base27` (`swap: true, exclusive: true`) so the A/B swaps cleanly; `concurrencyLimit: 12` on the 35B.

- [ ] **Step 1: Back up** the edited files.
- [ ] **Step 2: Download** with `bg_bash`: `hf download bytkim/Qwen3.8-27B-pi-FP8`, `hf download incoai/Qwen3.8-27B-DFlash2`, `hf download unsloth/Qwen3.6-35B-A3B-NVFP4`, `hf download incoai/Qwen3.6-35B-A3B-DFlash2 --revision 51ef7b6923ad6c14cb1bb41c37a9041446496ab6` (~60 GB total; 3.1 TB free). Expected: four snapshot dirs under `~/.cache/huggingface/hub`.
- [ ] **Step 3: Write and edit** the files as in Interfaces; `bash -n ~/run-27b-pi.sh` passes; `grep -v '^#' .env | grep -v '^$'` shows the four keys.
- [ ] **Step 4: Reload llama-swap** `kill -HUP $(pidof llama-swap)`; `curl -s 127.0.0.1:9000/v1/models` lists `qwen3.8-27b-pi`.
- [ ] **Step 5: Commit** the spec note "Task 1 done: downloads and config".

### Task 2: Co-load gate

- [ ] **Step 1: Load the pair:** one chat request each to `qwen3.8-27b-pi` and `qwen3.6-35b-a3b-sglang` through port 9000 (the first boot of the FP8 tune compiles; allow 10 min). Expected: `curl -s 127.0.0.1:9000/running` lists both `ready`.
- [ ] **Step 2: Record** `MemAvailable`; from `docker logs qwen38-27b-pi` and the 35B `.sglang.log`: `max_total_num_tokens`, DFlash draft load, any FP8 or mamba-pool warning. Expected: MemAvailable ≥ 10 GB; 35B tokens ≈ 600k; 27b-pi ≈ 400k.
- [ ] **Step 3: If the floor fails,** lower `MEM_FRACTION_STATIC` to 0.28, re-boot the 35B, re-measure; if still short, drop 27b-pi to 0.40 and `--max-total-tokens 330000`. Record every attempt.
- [ ] **Step 4: Sanity:** one 500-token chat on each engine through pi (`pi --mode json --model spark/qwen3.8-27b-pi --thinking medium`, same for the 35B) returns a reply with a `reasoning` field on the 27b-pi and none on the 35B at `off`.
- [ ] **Step 5: Commit** the table.

### Task 3: A/B the pi tune against the base, and the readout on the 35B

**Files:**
- Create: `~/workspace/pi-web/bench/pair-ab.mjs`
- Modify: spec, "A/B" and "Readout" tables.

**Interfaces:**
- `node bench/pair-ab.mjs --model <id> --task <file> --effort <level> --out <jsonl>`: runs `pi --mode json -p --model spark/<id> --thinking <level>` on a fixed pi task (the cad Task 3 brief from `~/workspace/apps/cad/.superpowers/sdd/2026-11-10-cad-v1.0/task-3-brief.md`, on a scratch worktree of cad at `649259e` (the ruling commit just before Task 3's implementation `c407b57`)), with a 25-minute cap; records wall-clock, output tokens, reasoning tokens, tool calls, whether `npm test` passes after, and the engine's DFlash accept length from `/metrics`.
- Readout bench: flash-auto's `node bench/run.ts --set test --condition idle` with the flash classifier pointed at `qwen3.6-35b-a3b-sglang` (its `FlashOptions.model`); `node bench/report.ts` prints exact and within-one-level accuracy.

- [ ] **Step 1: Pi tune at medium**, twice: `--model qwen3.8-27b-pi --effort medium`. Record.
- [ ] **Step 2: Base at xhigh**, twice: load `qwen3.8-27b` (this unloads the pair, by design of the A/B), `--model qwen3.8-27b --effort xhigh`. Also record c=1 tok/s on a 2k-output prompt for each model. Reload the pair afterwards.
- [ ] **Step 3: Decide:** the pi tune stays if its wall-clock per task is ≤ the base's and `npm test` passes as often. Otherwise write "pi tune loses on <metric>" and open the self-quantized NVFP4 task (left to the builder; not in this plan).
- [ ] **Step 4: Readout accuracy on the 35B:** run the bench as in Interfaces. Expected: within-one-level ≥ 95% (flash: 100%), exact ≥ 60% (flash: 70%). Below that, write it down and keep going: the fallback level is medium.
- [ ] **Step 5: Commit** the tables and the script.

### Task 4: Contention bench

**Files:**
- Create: `~/workspace/pi-web/bench/pair-contention.mjs`
- Modify: spec, "Contention" table.

**Interfaces:**
- `node bench/pair-contention.mjs --workers <n> --prompt-tokens 120000 --out <jsonl>`: one streaming completion to `qwen3.8-27b-pi` (a 20k-token prompt from a cad session excerpt, 2k output, medium) while `n` concurrent streaming completions run on the 35B (120k-token prompts built from `~/workspace/apps/cad/src/**/*.ts`, 2k output, thinking on). Per stream: TTFT, output tok/s (wall), p95 inter-token gap; one JSON line per stream plus a summary. Also: ten `pair-auto`-style readout requests (1 token, logprobs) to the 35B during the run, recording latency; and one 100k-token prompt sent to the 27b-pi right after the same prompt ran on the 35B, recording TTFT (the switch cost).
- Prompts live under `bench/prompts/` (built by the script, not committed).

- [ ] **Step 1: Write the script**; smoke with `--workers 0` (< 3 min).
- [ ] **Step 2: Run** `--workers 0`, `4`, `6`, each twice. Record 27b-pi tok/s and p95 gap, 35B per-stream and combined, readout latency p95, switch TTFT.
- [ ] **Step 3: Record** sglang `/metrics` on both ports during the 6-worker run (running/waiting, cache hit rate, preemptions).
- [ ] **Step 4: Decide the worker concurrency:** the largest n at which 27b-pi keeps a p95 gap under 2 s and ≥ 15 tok/s mean, and readout p95 < 1.5 s; write it into `config.json`'s `parallel.concurrency` and the spec.
- [ ] **Step 5: Commit** the script and the table.

### Task 5: Switch pi to `pair-auto`

**Files:**
- Modify: `~/.pi/agent/settings.json`
- Modify: `<hub data dir>/last-model.json` (path from `hub/src/main.ts:41`)
- Modify: spec, "Switch" checklist.

**Interfaces:**
- `settings.json`: `defaultModel: "spark/pair-auto"` (this is also what makes the flash-auto package register `pair-auto` instead of `flash-auto`); `packages` keeps `"../../workspace/flash-auto"`; `compaction.modelOverrides` gains `"spark/pair-auto"`, `"spark/qwen3.8-27b-pi"` and `"spark/qwen3.6-35b-a3b-sglang"`, each `{ "reserveTokens": 60000 }`; `subagents.defaultModel: "spark/qwen3.6-35b-a3b-sglang"`, `subagents.defaultThinking: "medium"`, `agentOverrides.scout/reviewer/worker.model = "spark/qwen3.6-35b-a3b-sglang"` (reviewer `thinking: "medium"`, scout `"low"`); `httpIdleTimeoutMs: 900000`.
- `last-model.json`: `{"provider":"spark","modelId":"pair-auto","thinking":"medium"}`.

- [ ] **Step 1: Back up and edit** `settings.json`; validate with `node -e 'JSON.parse(...)'`.
- [ ] **Step 2: Rewrite `last-model.json`** and restart the hub as `~/workspace/pi-web/README.md` documents.
- [ ] **Step 3: Verify in a fresh pi-web chat:** the picker shows "Spark pair (auto)"; a trivial message ("thanks") routes to the 35B at off and a design question routes to 27b-pi (status line `pair-auto → <level>`, `~/.pi/agent/flash-auto.jsonl` last line has `virtual: "pair-auto"`); `subagent({action:"models"})` lists scout, reviewer, worker on the 35B; `curl -s 127.0.0.1:9000/running` still shows both engines and no flash model.
- [ ] **Step 4: Verify the pair note:** `grep -c "Parallel group" ~/.pi/agent/tmp/superpowers-manual/writing-plans/SKILL.md` ≥ 1.
- [ ] **Step 5: Commit** the checklist.

### Task 6: Replay cad Tasks 2–4 on the pair

- [ ] **Step 1: Prepare the branch:** `cd ~/workspace/apps/cad && git switch -c pair-replay 8e0fc22`; copy `docs/superpowers/plans/2026-11-10-cad-v1.0.md` from `cad-v1`; commit.
- [ ] **Step 2: Start a pi-web chat with superpowers on** and the prompt: "Execute Tasks 2, 3 and 4 of docs/superpowers/plans/2026-11-10-cad-v1.0.md on branch pair-replay with superpowers:executing-plans. Stop after Task 4's review is complete. Do not open a PR." Record the start time.
- [ ] **Step 3: While it runs,** watch `/running`, `/proc/meminfo`, the progress panel; note worker timeouts, compactions (`grep -c '"type": "compaction"'` on the session file), each reviewer launch's model, and every router decision for the orchestrator's turns.
- [ ] **Step 4: Record per task:** wall-clock from first scout launch to review complete, verify green first try, reviewer P1/P2 counts, worker runs and timeouts, output tokens per engine.
- [ ] **Step 5: Compare** with the 2026-11-11 baseline rows in the spec (73 min/task subagent, ~45 min inline). Commit the table.

### Task 7: Go / no-go

- [ ] **Step 1: Go** if Task 6's mean critical path < 45 min, no anti-goal occurred, and the harness tests still pass. Write "Verdict: go, <date>, <numbers>"; the pair stays pi's model.
- [ ] **Step 2: No-go** otherwise: restore `settings.json`, `last-model.json`, `run-27b.sh`, `.env`, `llama-swap.yaml` from the backups; `kill -HUP $(pidof llama-swap)`; one request to `qwen3.8-flash-next` to reload it; restoring `settings.json` already makes the package register flash-auto again; restart the hub; write "Verdict: no-go, <reason>, pair config kept in .bak files". The harness changes stay.
- [ ] **Step 3: Commit** the verdict and update `~/.claude/projects/-home-michael/memory/spark-agent-pair.md`.
