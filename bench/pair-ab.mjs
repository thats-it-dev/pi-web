#!/usr/bin/env node
// A/B one fixed pi task between two orchestrator models (spec Addendum §1): wall-clock, output and reasoning tokens,
// tool calls, whether the worktree's unit tests pass afterwards, and the engine's DFlash accept length.
//
//   node bench/pair-ab.mjs --model qwen3.8-27b-pi --effort medium --task <brief.md> --cwd <scratch checkout> [--cap-min 25] [--out bench/results/ab.jsonl]
//
// The model must already be loaded (this never triggers a swap on purpose: load it through llama-swap first).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : [])).filter((e) => e.length));
const MODEL = args.model;
const EFFORT = args.effort ?? "medium";
const TASK = args.task;
const CWD = args.cwd;
const CAP_MS = Number(args["cap-min"] ?? 25) * 60_000;
const OUT = args.out ?? join(dirname(fileURLToPath(import.meta.url)), "results", "ab.jsonl");
const PORT = { "qwen3.8-27b-pi": 8001, "qwen3.8-27b": 8000, "qwen3.6-35b-a3b-sglang": 8888 }[MODEL];
if (!MODEL || !TASK || !CWD) {
	console.error("usage: --model <id> --task <brief.md> --cwd <checkout> [--effort low|medium|xhigh]");
	process.exit(2);
}

const running = await (await fetch("http://127.0.0.1:9000/running")).json();
if (!running.running?.some((r) => r.model === MODEL && r.state === "ready")) {
	console.error(`${MODEL} is not loaded; load it through llama-swap first (this script never swaps)`);
	process.exit(3);
}

const brief = readFileSync(TASK, "utf8");
const prompt = `${brief}\n\nWork in ${CWD}. Do not open a PR and do not push. When done, run \`npm test\` and stop.`;
const sessionsRoot = join(homedir(), ".pi", "agent", "sessions", `--${CWD.replace(/^\//, "").replaceAll("/", "-")}--`);
const before = new Set(safeList(sessionsRoot));

async function acceptLen() {
	try {
		const text = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
		return text.split("\n").filter((l) => /accept/.test(l) && !l.startsWith("#")).join(" | ") || null;
	} catch {
		return null;
	}
}
function safeList(dir) {
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
}

const acceptBefore = await acceptLen();
const t0 = Date.now();
const pi = spawnSync("pi", ["-p", "--model", `spark/${MODEL}`, "--thinking", EFFORT, prompt], { cwd: CWD, encoding: "utf8", timeout: CAP_MS, maxBuffer: 64 * 1024 * 1024 });
const wallMs = Date.now() - t0;
const acceptAfter = await acceptLen();

const after = safeList(sessionsRoot).filter((f) => !before.has(f));
const newest = after.sort((a, b) => statSync(join(sessionsRoot, b)).mtimeMs - statSync(join(sessionsRoot, a)).mtimeMs)[0];
let outputTokens = 0, reasoningChars = 0, turns = 0, toolCalls = 0, maxCtx = 0;
if (newest) {
	for (const line of readFileSync(join(sessionsRoot, newest), "utf8").split("\n")) {
		if (!line.trim()) continue;
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		const m = r.message;
		if (m?.role !== "assistant") continue;
		turns++;
		const u = m.usage ?? {};
		outputTokens += u.output ?? 0;
		maxCtx = Math.max(maxCtx, (u.input ?? 0) + (u.cacheRead ?? 0));
		for (const c of m.content ?? []) {
			if (c.type === "thinking") reasoningChars += (c.thinking ?? "").length;
			if (c.type === "toolCall") toolCalls++;
		}
	}
}
const tests = spawnSync("npm", ["test"], { cwd: CWD, encoding: "utf8", timeout: 10 * 60_000 });
const row = {
	ts: new Date().toISOString(),
	model: MODEL,
	effort: EFFORT,
	task: TASK,
	wallMin: Number((wallMs / 60000).toFixed(1)),
	timedOut: pi.status === null,
	exit: pi.status,
	turns,
	toolCalls,
	outputTokens,
	reasoningTokensApprox: Math.round(reasoningChars / 4),
	maxContextTokens: maxCtx,
	testsPass: tests.status === 0,
	session: newest ? join(sessionsRoot, newest) : null,
	acceptBefore,
	acceptAfter,
};
mkdirSync(dirname(OUT), { recursive: true });
appendFileSync(OUT, JSON.stringify(row) + "\n");
console.log(JSON.stringify(row, null, 1));
