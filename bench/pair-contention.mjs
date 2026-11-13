#!/usr/bin/env node
// Contention bench for the Spark agent pair (spec: docs/superpowers/specs/2026-11-11-spark-agent-pair-design.md).
// One orchestrator stream on the pi tune while N worker streams decode on the MoE, plus readout probes and the
// engine-switch TTFT. Prints one JSON line per stream and a summary line; appends them to --out.
//
//   node bench/pair-contention.mjs --workers 4 [--prompt-tokens 120000] [--out bench/results/contention.jsonl]
//
// Prompts are built once from ~/workspace/apps/cad/src/**/*.ts into bench/prompts/ (not committed).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Agent, setGlobalDispatcher } from "undici";

// A worker's first token can take many minutes behind other workers' 120k-token prefills; Node's default 300 s
// header timeout killed the 6-worker pass on 2026-11-11.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : [])).filter((e) => e.length));
const WORKERS = Number(args.workers ?? 0);
const PROMPT_TOKENS = Number(args["prompt-tokens"] ?? 120000);
const BASE = args.base ?? "http://127.0.0.1:9000";
// The orchestrator engine may sit outside llama-swap (an A/B build on its own port): its chat URL and metrics port.
const ORCH_BASE = args["orch-base"] ?? BASE;
const ORCH_PORT = Number(args["orch-port"] ?? 8001);
const OUT = args.out ?? join(dirname(fileURLToPath(import.meta.url)), "results", "contention.jsonl");
const ORCH = args.orch ?? "qwen3.8-27b-pi";
const MOE = args.moe ?? "qwen3.6-35b-a3b-sglang";
const OUTPUT_TOKENS = Number(args["output-tokens"] ?? 2000);
const CHARS_PER_TOKEN = 3.6;

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "prompts");
mkdirSync(promptsDir, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

function corpus() {
	const root = join(homedir(), "workspace", "apps", "cad", "src");
	const files = [];
	const walk = (d) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".ts")) files.push(p);
		}
	};
	walk(root);
	return files.map((f) => `// FILE ${f}\n${readFileSync(f, "utf8")}`).join("\n\n");
}

/** A prompt of about `tokens` tokens, cached on disk; `tag` makes each worker's prefix distinct so the radix cache can't share it. */
function prompt(tokens, tag) {
	const file = join(promptsDir, `${tokens}-${tag}.txt`);
	if (existsSync(file)) return readFileSync(file, "utf8");
	const want = Math.round(tokens * CHARS_PER_TOKEN);
	let body = `// worker ${tag}: read this repository and summarise its module structure.\n`;
	const c = corpus();
	while (body.length < want) body += `\n// pass ${Math.floor(body.length / Math.max(c.length, 1))}\n` + c;
	body = body.slice(0, want) + "\n\nSummarise the module structure in ten bullet points.";
	writeFileSync(file, body);
	return body;
}

async function stream(model, content, extra, label, base = BASE) {
	const t0 = performance.now();
	let first = null;
	let last = null;
	let tokens = 0;
	const gaps = [];
	let usage = null;
	const res = await fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: OUTPUT_TOKENS, stream: true, stream_options: { include_usage: true }, ...extra }),
	});
	if (!res.ok) return { label, model, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "[DONE]") continue;
			let j;
			try {
				j = JSON.parse(data);
			} catch {
				continue;
			}
			if (j.usage) usage = j.usage;
			const d = j.choices?.[0]?.delta;
			if (d && (d.content || d.reasoning_content || d.reasoning)) {
				const now = performance.now();
				if (first === null) first = now;
				else gaps.push(now - last);
				last = now;
				tokens++; // chunks; DFlash may emit several tokens per chunk, usage below is authoritative
			}
		}
	}
	const end = performance.now();
	const out = usage?.completion_tokens ?? tokens;
	gaps.sort((a, b) => a - b);
	const p95 = gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] : null;
	return {
		label,
		model,
		promptTokens: usage?.prompt_tokens ?? null,
		outputTokens: out,
		ttftMs: first === null ? null : Math.round(first - t0),
		decodeTokPerS: first === null || end === first ? null : Number((out / ((end - first) / 1000)).toFixed(1)),
		wallTokPerS: Number((out / ((end - t0) / 1000)).toFixed(1)),
		p95GapMs: p95 === null ? null : Math.round(p95),
		chunks: tokens,
	};
}

async function readout(model) {
	const t0 = performance.now();
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "Classify: A = trivial, B = simple, C = some work, D = hard.\nUser message:\n<<<\nfix the race in the queue\n>>>\nAnswer with one letter." }], max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20, chat_template_kwargs: { enable_thinking: false } }),
	});
	await res.text();
	return Math.round(performance.now() - t0);
}

async function metrics(port) {
	try {
		const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
		return text.split("\n").filter((l) => /^sglang:(num_running_reqs|num_queue_reqs|cache_hit_rate|spec_accept_length|num_preempt)/.test(l)).join(" | ");
	} catch {
		return "metrics unavailable";
	}
}

const run = { ts: new Date().toISOString(), workers: WORKERS, promptTokens: PROMPT_TOKENS, outputTokens: OUTPUT_TOKENS, orch: ORCH, orchBase: ORCH_BASE };
const workerPrompts = Array.from({ length: WORKERS }, (_, i) => prompt(PROMPT_TOKENS, `w${i}`));
const orchPrompt = prompt(20000, "orch");

const workers = workerPrompts.map((p, i) => stream(MOE, p, { chat_template_kwargs: { enable_thinking: true } }, `worker-${i}`));
await new Promise((r) => setTimeout(r, 1500)); // let the workers' prefills start first
const orch = stream(ORCH, orchPrompt, { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium" } }, "orchestrator", ORCH_BASE);
const probes = [];
const probeLoop = (async () => {
	for (let i = 0; i < 10; i++) {
		probes.push(await readout(MOE));
		await new Promise((r) => setTimeout(r, 3000));
	}
})();
const midMetrics = new Promise((r) => setTimeout(async () => r({ orch: await metrics(ORCH_PORT), moe: await metrics(8888) }), 20000));
const results = await Promise.all([orch, ...workers]);
await probeLoop;
const m = await midMetrics;

// Switch cost: the same 100k prompt warm on the MoE, then cold on the orchestrator.
const sw = prompt(100000, "switch");
await stream(MOE, sw, { chat_template_kwargs: { enable_thinking: false } }, "switch-warm-moe");
const switched = await stream(ORCH, sw, { chat_template_kwargs: { enable_thinking: false } }, "switch-cold-orch", ORCH_BASE);

for (const r of results) appendFileSync(OUT, JSON.stringify({ ...run, ...r }) + "\n");
probes.sort((a, b) => a - b);
const summary = {
	...run,
	summary: true,
	orchestrator: results[0],
	moePerStreamTokPerS: results.slice(1).map((r) => r.decodeTokPerS),
	moeCombinedTokPerS: Number(results.slice(1).reduce((s, r) => s + (r.decodeTokPerS ?? 0), 0).toFixed(1)),
	readoutP95Ms: probes.length ? probes[Math.min(probes.length - 1, Math.floor(probes.length * 0.95))] : null,
	switchTtftMs: switched.ttftMs,
	metricsAt20s: m,
};
appendFileSync(OUT, JSON.stringify(summary) + "\n");
console.log(JSON.stringify(summary, null, 1));
