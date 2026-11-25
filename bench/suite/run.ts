#!/usr/bin/env node
// The harness measurement runner (2026-11-24 review's protocol). For each task x run: build the scratch, run one
// headless pi session pinned to a loaded model under the harness exactly as configured now, then turn the session
// file, the guard's block log and prompt digest, and the task's oracle into one RunMetrics row appended to a JSONL.
//
//   node bench/suite/run.ts --model inkling-2-mini --arm C [--task o2-copy-change] [--runs 3] [--cap-min 20]
//
// Comparing arms means running the whole suite under each harness config (swap ~/.pi/agent/settings.json, restart
// nothing — pi reads it per process) and labelling the runs with --arm. The model must already be loaded; this never
// triggers a swap. Nothing here pushes, opens a PR, or touches a real app: scratch dirs are bench-* and are removed.

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS, type Task } from "./tasks.ts";
import { freshParent, parseSession, scanBlocks, tallyBlocks, type RunMetrics } from "./metrics.ts";

const HOME = homedir();
const SUITE = dirname(fileURLToPath(import.meta.url));
const BLOCK_LOG = join(HOME, ".pi", "agent", "tmp", "pi-guard-blocks.jsonl");
const DIGEST = join(HOME, ".pi", "agent", "tmp", "pi-guard-prompts.jsonl");

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]] : [])));
const MODEL = args.model;
const ARM = args.arm ?? "unlabelled";
const RUNS = Number(args.runs ?? 3);
const CAP_MS = Number(args["cap-min"] ?? 20) * 60_000;
const THINKING = args.thinking ?? "high";
const OUT = args.out ?? join(SUITE, "results", `${ARM}.jsonl`);
const only = args.task && args.task !== "true" ? args.task.split(",") : null;

if (!MODEL) {
	console.error("usage: node bench/suite/run.ts --model <loaded id> --arm <label> [--task id[,id]] [--runs 3] [--cap-min 20]");
	process.exit(2);
}

async function modelLoaded(id: string): Promise<boolean> {
	try {
		const r = (await (await fetch("http://127.0.0.1:9000/running")).json()) as { running?: { model?: string; state?: string }[] };
		return (r.running ?? []).some((x) => x.model === id && x.state === "ready");
	} catch {
		return false;
	}
}

/** Where a task's scratch lives so the real guard engages: an app under ~/workspace/apps, the website-like tasks under
 *  ~/workspace (a non-app repo the guard gates too). */
function baseFor(task: Task): string {
	return task.size === "keep-the-look" ? join(HOME, "workspace") : join(HOME, "workspace", "apps");
}

function prompt(task: Task, dir: string): string {
	const rel = dir.replace(HOME, "~");
	return [
		task.prompt,
		"",
		`Work only in ${rel} (a throwaway checkout for a benchmark). Branch, make the change, and get the checks green.`,
		"Do not open a pull request, do not push, and do not run the deploy or ship commands — this is a local measurement.",
		"When the work is done and verified, stop.",
	].join("\n");
}


async function main(): Promise<void> {
	if (!(await modelLoaded(MODEL))) {
		console.error(`${MODEL} is not loaded in llama-swap; load it first (this runner never swaps).`);
		process.exit(3);
	}
	mkdirSync(dirname(OUT), { recursive: true });
	const tasks = TASKS.filter((t) => !only || only.includes(t.id));
	console.log(`arm ${ARM}, model ${MODEL}, ${tasks.length} tasks x ${RUNS} runs -> ${OUT}\n`);
	for (const task of tasks) {
		for (let run = 1; run <= RUNS; run++) {
			const built = join(baseFor(task), `bench-${task.id}`);
			try {
				task.setup(built);
			} catch (e) {
				console.log(`[${task.id} #${run}] setup failed: ${(e as Error).message.split("\n")[0]}`);
				continue;
			}
			const sessionFile = join(SUITE, "results", "sessions", `${ARM}-${task.id}-${run}.jsonl`);
			mkdirSync(dirname(sessionFile), { recursive: true });
			const t0 = new Date().toISOString();
			const start = Date.now();
			const pi = spawnSync("pi", ["-p", "--model", `spark/${MODEL}`, "--thinking", THINKING, "--session", sessionFile, prompt(task, built)], {
				cwd: built,
				encoding: "utf8",
				timeout: CAP_MS,
				maxBuffer: 128 * 1024 * 1024,
			});
			const wallSeconds = Math.round((Date.now() - start) / 10) / 100;
			const t1 = new Date().toISOString();
			const timedOut = pi.status === null;
			const sess = (() => {
				try {
					return parseSession(readFileSync(sessionFile, "utf8"));
				} catch {
					return parseSession("");
				}
			})();
			const blocks = tallyBlocks(scanBlocks(safeRead(BLOCK_LOG), t0, t1));
			const fresh = freshParent(safeRead(DIGEST), t0, t1);
			const oracle = (() => {
				try {
					return task.oracle(built);
				} catch (e) {
					return { pass: false, detail: `oracle threw: ${(e as Error).message.split("\n")[0]}` };
				}
			})();
			const row: RunMetrics = {
				...sess,
				task: task.id,
				arm: ARM,
				model: MODEL,
				wallSeconds,
				timedOut,
				oraclePass: oracle.pass,
				oracleDetail: oracle.detail,
				lintViolations: oracle.lintViolations ?? null,
				blocks,
				fresh,
			};
			appendFileSync(OUT, `${JSON.stringify({ ts: t0, ...row })}\n`);
			rmSync(built, { recursive: true, force: true });
			console.log(`[${task.id} #${run}] ${timedOut ? "TIMED OUT" : oracle.pass ? "pass" : "fail"} · ${wallSeconds}s · ${sess.turns} turns · ${sess.toolCalls} tools · ${blocks.total} blocks · ${(sess.outputTokens / 1000).toFixed(1)}k out · oracle: ${oracle.detail}`);
		}
	}
	console.log(`\ndone. aggregate with: node bench/suite/report.ts ${OUT}`);
}

function safeRead(p: string): string {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

void main();
