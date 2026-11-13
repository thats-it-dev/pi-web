#!/usr/bin/env node
// Single-stream orchestrator bench for an A/B of two builds of the same model: three prompt kinds an orchestrator
// actually emits (prose summary, code, a plan), thinking on at medium, one stream each. Prints decode tok/s, TTFT and
// the engine's DFlash accept-length gauge after each request; appends one JSON line per prompt to --out.
//
//   node bench/pair-orch.mjs --model qwen3.8-27b-pi [--base http://127.0.0.1:9000] [--port 8001] [--label fp8]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : [])).filter((e) => e.length));
const MODEL = args.model ?? "qwen3.8-27b-pi";
const BASE = args.base ?? "http://127.0.0.1:9000";
const PORT = Number(args.port ?? 8001);
const LABEL = args.label ?? MODEL;
const OUT = args.out ?? join(dirname(fileURLToPath(import.meta.url)), "results", "orch-ab.jsonl");
const MAX = Number(args["output-tokens"] ?? 3000);
mkdirSync(dirname(OUT), { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));
const prose = readFileSync(join(here, "prompts", "20000-orch.txt"), "utf8");
const spec = readFileSync(join(homedir(), "workspace", "apps", "touchtype", "docs", "superpowers", "specs", "2026-11-12-kit-charts-design.md"), "utf8");
const code = readFileSync(join(homedir(), "workspace", "apps", "touchtype", "src", "stats", "history.ts"), "utf8");
const prompts = {
	prose: prose,
	plan: `Here is a design spec for a change to a TypeScript web app:\n\n${spec}\n\nWrite an implementation plan for it: 4-6 tasks, each with the files it touches, the exact failing test to write first (name and assertions), the implementation step with function signatures, the verification command, and a commit message. Mark tasks that touch different files as a parallel group.`,
	code: `Here is a TypeScript module:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nWrite a new module \`streaks.ts\` that exports \`streaks(rows: SessionRow[]): { current: number; longest: number; lastDay: string | null }\` counting consecutive practised days (a day counts when it has at least one session), with a node:test file covering an empty list, one day, a gap, and a streak that reaches today. Return only the two files as code blocks.`,
};

async function gauge() {
	try {
		const t = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
		const v = /sglang:spec_accept_length\{[^}]*\}\s+([0-9.]+)/.exec(t)?.[1];
		return v ? Number(v) : null;
	} catch {
		return null;
	}
}

async function run(kind, content) {
	const t0 = performance.now();
	let first = null, last = null, chunks = 0, usage = null, reasoning = 0, text = 0;
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], max_tokens: MAX, stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium" } }),
	});
	if (!res.ok) return { kind, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
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
			if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
			let j;
			try { j = JSON.parse(line.slice(5)); } catch { continue; }
			if (j.usage) usage = j.usage;
			const d = j.choices?.[0]?.delta;
			if (d && (d.content || d.reasoning_content || d.reasoning)) {
				const now = performance.now();
				if (first === null) first = now;
				last = now; chunks++;
				reasoning += (d.reasoning_content ?? d.reasoning ?? "").length;
				text += (d.content ?? "").length;
			}
		}
	}
	const end = performance.now();
	const out = usage?.completion_tokens ?? chunks;
	return {
		kind, promptTokens: usage?.prompt_tokens ?? null, outputTokens: out, reasoningChars: reasoning, textChars: text,
		ttftMs: first === null ? null : Math.round(first - t0),
		decodeTokPerS: first === null || end === first ? null : Number((out / ((end - first) / 1000)).toFixed(1)),
		wallS: Number(((end - t0) / 1000).toFixed(1)),
		acceptAfter: await gauge(),
	};
}

const rows = [];
for (const [kind, content] of Object.entries(prompts)) {
	const r = { ts: new Date().toISOString(), label: LABEL, model: MODEL, base: BASE, ...(await run(kind, content)) };
	rows.push(r);
	appendFileSync(OUT, JSON.stringify(r) + "\n");
	console.log(JSON.stringify(r));
}
console.log("MEAN decode tok/s", (rows.reduce((s, r) => s + (r.decodeTokPerS ?? 0), 0) / rows.length).toFixed(1));
