# Spark agent pair: serving switch and phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both engines boot together within the memory floor, their speeds under load are measured and written into the spec, pi runs on the pair, and a replay of cad Tasks 2–4 shows the per-task critical path beating ~45 min, or the switch is reverted.

**Architecture:** Serving changes are three files (`~/run-27b.sh`, `~/Qwen3.6-35b-SGLang-DGX-Spark/.env`, `~/llama-swap.yaml`), measured by a small Node bench script against the OpenAI endpoints and sglang `/metrics`. The pi switch is `settings.json` plus the hub's last-model file. Every gate writes its numbers into the spec's "Measured" section before the next task starts.

**Tech Stack:** llama-swap (SIGHUP reload), sglang in docker, Node 26 scripts, pi 1.0.2, pi-subagents 0.76.

**Spec:** `docs/superpowers/specs/2026-11-11-spark-agent-pair-design.md`

**Prerequisite:** the harness plan (`2026-11-11-spark-agent-pair-harness.md`) is done, and the cad pi session has finished (its session file under `~/.pi/agent/sessions/--home-michael--/` stops changing and `curl -s 127.0.0.1:18300/metrics | grep -E "^vllm:num_requests_running"` reports 0). Tasks 1 can run before that; Tasks 2–7 unload flash-next.

## Global Constraints

- Free memory after both engines boot ≥ 10 GB (`grep MemAvailable /proc/meminfo`); if not, lower the 35B fraction first, then 27b's, re-boot, re-measure.
- 27b stays `--max-running-requests 3`; worker concurrency is the knob, never a fraction above 0.80 combined.
- Never load a flash model while the pair is up (exclusive groups); the only flash-next request allowed is the final revert in Task 7's fallback.
- Backups before editing: `cp` each edited file to `<name>.bak-2026-11-11`.
- Numbers go into the spec under a new `## Measured (phase 0)` section, one table per task, committed to pi-web master as `docs(superpowers): pair phase 0 — <task>`.

## Review Focus

1. The 35B `start.sh` auto-sizes `MAX_TOTAL_TOKENS` from `MAX_CONCURRENT_REQUESTS × 262144`; with 8 that is 2.1M tokens, over the 0.42 budget. Task 1 pins it and Task 2 checks the boot log value.
2. A worker-sized prompt (120k tokens) prefilling on the 35B while 27b decodes: Task 3 records 27b's p95 inter-token gap, not only its mean tok/s.
3. `subagent({action:"models"})` after the switch must show every builtin agent on `spark/qwen3.6-35b-a3b-sglang`, not `flash-auto` (which no longer exists as a model). Task 4 checks each row.
4. pi's compaction on a 262k window: Task 5 records how many compactions the replay triggers and whether any task lost its brief.
5. A reviewer call during the replay that names `spark/qwen3.8-27b` must keep it (Task 4 of the harness plan); Task 5 greps the review launch for the model.

---

### Task 1: Serving config and downloads (safe while flash-next runs)

**Files:**
- Modify: `~/run-27b.sh` (lines 12–13, 22; add `--enable-metrics`)
- Modify: `~/Qwen3.6-35b-SGLang-DGX-Spark/.env`
- Modify: `~/llama-swap.yaml` (35B and 27b entries)

**Interfaces:**
- `run-27b.sh`: `--mem-fraction-static 0.32`, `--max-total-tokens 370000`, `--max-running-requests 3`, `--enable-metrics`.
- `.env`: `MODEL_ID=unsloth/Qwen3.6-35B-A3B-NVFP4`, `MEM_FRACTION_STATIC=0.42`, `MAX_CONCURRENT_REQUESTS=8`, `MAX_TOTAL_TOKENS=1100000`.
- `llama-swap.yaml`: `concurrencyLimit: 16` on `qwen3.6-35b-a3b-sglang`, `concurrencyLimit: 6` on `qwen3.8-27b`; the `duo` group stays `swap: false, exclusive: true`; `cmd` for the 35B stays `start-dflash.sh`.

- [ ] **Step 1: Back up** the three files with the `.bak-2026-11-11` suffix.
- [ ] **Step 2: Download the measured checkpoint and draft:** `hf download unsloth/Qwen3.6-35B-A3B-NVFP4` and `hf download incoai/Qwen3.6-35B-A3B-DFlash2 --revision 51ef7b6923ad6c14cb1bb41c37a9041446496ab6` (run with `bg_bash`; ~26 GB). Expected: both snapshot dirs exist under `~/.cache/huggingface/hub`.
- [ ] **Step 3: Edit** the three files as in Interfaces; `grep -n "mem-fraction\|max-total\|max-running\|enable-metrics" ~/run-27b.sh` shows the four values; `grep -v '^#' ~/Qwen3.6-35b-SGLang-DGX-Spark/.env | grep -v '^$'` shows the four keys.
- [ ] **Step 4: Reload llama-swap** `kill -HUP $(pidof llama-swap)` and check `curl -s 127.0.0.1:9000/running` still shows only flash-next ready (a reload must not swap).
- [ ] **Step 5: Commit** the spec note "Task 1 done: config staged, checkpoint downloaded" to pi-web.

### Task 2: Co-load gate

**Files:**
- Modify: spec, `## Measured (phase 0)` → "Co-load" table.

- [ ] **Step 1: Confirm the cad session is idle** (prerequisite above). If not, stop here.
- [ ] **Step 2: Unload flash and load the pair:** `curl -s -X POST 127.0.0.1:9000/unload` (or the llama-swap unload endpoint the running version exposes; `curl -s 127.0.0.1:9000/` lists them), then one chat request to each of `qwen3.8-27b` and `qwen3.6-35b-a3b-sglang` through port 9000. Expected within ~8 min: `curl -s 127.0.0.1:9000/running` lists both `ready`.
- [ ] **Step 3: Record** `MemAvailable` from `/proc/meminfo`; from `docker logs qwen38-27b` and the 35B `.sglang.log`: `max_total_num_tokens`, KV pool size, and any warning about the mamba pool. Expected: MemAvailable ≥ 10 GB; 35B tokens ≈ 1.1M; 27b tokens ≈ 370k.
- [ ] **Step 4: If the floor fails,** lower `MEM_FRACTION_STATIC` by 0.04, `docker stop` the 35B, re-request it through llama-swap, re-measure; repeat once more for 27b (`--mem-fraction-static 0.28`) if still short. Record every attempt.
- [ ] **Step 5: Commit** the table to the spec.

### Task 3: Contention bench

**Files:**
- Create: `~/workspace/pi-web/bench/pair-contention.mjs`
- Modify: spec, "Contention" table.

**Interfaces:**
- `node bench/pair-contention.mjs --workers <n> --prompt-tokens 120000 --out <jsonl>`: sends one streaming chat completion to `qwen3.8-27b` (a 20k-token prompt from a cad session excerpt, 2k output) while `n` concurrent streaming completions run against the 35B (each a 120k-token prompt built from repeated cad source files, 2k output, `enable_thinking: true`). Measures per stream: TTFT, output tok/s (wall), p95 inter-token gap; prints one JSON line per stream and a summary line.
- Prompts are files under `bench/prompts/` built once by the script from `~/workspace/apps/cad/src/**/*.ts` (not committed).

- [ ] **Step 1: Write the script** (no test; its output is the artifact). Smoke: `--workers 0` returns the 27b-alone numbers in under 3 min.
- [ ] **Step 2: Run** `--workers 0`, `--workers 4`, `--workers 8`, each twice. Record 27b tok/s and p95 gap, 35B per-stream and combined tok/s, from the summary lines.
- [ ] **Step 3: Also record** sglang `/metrics` on both ports during the 8-worker run: running/waiting requests, cache hit rate, any preemption counters.
- [ ] **Step 4: Decide the worker concurrency** for the replay: the largest n (4, 6 or 8) at which the 27b stream keeps a p95 gap under 2 s and ≥ 20 tok/s mean; write it into `config.json`'s `parallel.concurrency` and the spec.
- [ ] **Step 5: Commit** the script and the table (`git add bench/pair-contention.mjs docs/...`).

### Task 4: Switch pi to the pair

**Files:**
- Modify: `~/.pi/agent/settings.json`
- Modify: `<hub data dir>/last-model.json` (the path `hub/src/main.ts:41` builds from `cfg.dataDir`)
- Modify: spec, "Switch" checklist.

**Interfaces:**
- `settings.json`: `defaultModel: "spark/qwen3.8-27b"`; `packages` without `"../../workspace/flash-auto"`; `compaction.modelOverrides["spark/qwen3.8-27b"] = { "reserveTokens": 60000 }` and `["spark/qwen3.6-35b-a3b-sglang"] = { "reserveTokens": 60000 }`; `subagents.defaultModel: "spark/qwen3.6-35b-a3b-sglang"`, `subagents.defaultThinking: "medium"`, `agentOverrides.scout/reviewer/worker.model = "spark/qwen3.6-35b-a3b-sglang"` (reviewer `thinking: "medium"`, scout `"low"`); `httpIdleTimeoutMs: 900000`.
- `last-model.json`: `{"provider":"spark","modelId":"qwen3.8-27b","thinking":"medium"}`.

- [ ] **Step 1: Back up** `settings.json` to `.bak-2026-11-11` and edit as in Interfaces; validate with `node -e 'JSON.parse(...)'`.
- [ ] **Step 2: Rewrite `last-model.json`** and restart the hub the way `~/workspace/pi-web/README.md` documents (the same restart used on 2026-11-10 for bg_bash).
- [ ] **Step 3: Verify in a fresh pi-web chat:** the model picker shows Qwen3.8 27B as current; `subagent({action:"models"})` lists scout, reviewer, worker on `spark/qwen3.6-35b-a3b-sglang` with the expected thinking; `curl -s 127.0.0.1:9000/running` still shows both engines and no flash model.
- [ ] **Step 4: Verify the superpowers pair note:** `grep -c "Parallel group" ~/.pi/agent/tmp/superpowers-manual/writing-plans/SKILL.md` ≥ 1 after the hub restart (the extension rebuilt the manual copies in pair mode).
- [ ] **Step 5: Commit** the checklist to the spec.

### Task 5: Replay cad Tasks 2–4 on the pair

**Files:**
- Modify: spec, "Replay" table.
- Uses: `~/workspace/apps/cad`, branch `pair-replay` from commit `8e0fc22` (cad: scaffold from template).

- [ ] **Step 1: Prepare the branch:** `cd ~/workspace/apps/cad && git switch -c pair-replay 8e0fc22`; copy the plan `docs/superpowers/plans/2026-11-10-cad-v1.0.md` from `cad-v1` so Tasks 2–4 are present; commit.
- [ ] **Step 2: Start a pi-web chat with superpowers on** and the prompt: "Execute Tasks 2, 3 and 4 of docs/superpowers/plans/2026-11-10-cad-v1.0.md on branch pair-replay with superpowers:executing-plans. Stop after Task 4's review is complete. Do not open a PR." Record the start time.
- [ ] **Step 3: While it runs,** watch `curl -s 127.0.0.1:9000/running`, `/proc/meminfo`, and the pi-web progress panel. Note every worker timeout, every compaction (`grep -c '"type": "compaction"'` on the session file), and the model each reviewer launched with (`grep -o '"agent": "reviewer"[^}]*model[^,]*' <session>`).
- [ ] **Step 4: Record per task:** wall-clock from first scout launch to review complete, verify green on first try (y/n), reviewer P1/P2 counts, worker runs and timeouts, 27b output tokens and 35B output tokens from the session and run dirs.
- [ ] **Step 5: Compare** with the 2026-11-11 baseline rows already in the spec (73 min/task subagent, ~45 min inline). Commit the table.

### Task 6: Go / no-go

**Files:**
- Modify: spec, "Verdict".
- Modify: `~/.claude/projects/-home-michael/memory/spark-agent-pair.md` (status line).

- [ ] **Step 1: Go** if Task 5's mean critical path < 45 min, no anti-goal occurred (no OOM, no flash swap, no worker PR, no shared-file conflict), and the harness plan's tests still pass. Write "Verdict: go, <date>, <numbers>" and leave the pair as pi's model.
- [ ] **Step 2: No-go** otherwise: restore `settings.json`, `last-model.json`, `run-27b.sh`, `.env`, `llama-swap.yaml` from the backups, `kill -HUP $(pidof llama-swap)`, one request to `qwen3.8-flash-next` to reload it, restart the hub, and write "Verdict: no-go, <reason>, pair config kept in .bak files". The harness changes stay: they are correct for inline mode too.
- [ ] **Step 3: Commit** the verdict to pi-web and update the memory file's status line.
