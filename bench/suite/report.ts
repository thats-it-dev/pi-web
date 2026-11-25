#!/usr/bin/env node
// Aggregate one or more results JSONL files (one per arm) into a per-task and per-arm summary, and, when two arms are
// given, their deltas. Pure read-and-print; the decision rule (a removal holds the pass rate and beats on time/tokens;
// an addition lowers false-positive blocks, reviewer rounds or lint without lowering pass rate) is the reader's.
//
//   node bench/suite/report.ts results/A.jsonl results/B.jsonl results/C.jsonl

import { readFileSync } from "node:fs";
import type { RunMetrics } from "./metrics.ts";

type Row = RunMetrics & { ts: string };

function load(path: string): Row[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Row);
}

const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const padL = (s: string, n: number) => s.padStart(n).slice(0, n);

interface ArmSummary {
	arm: string;
	runs: number;
	passRate: number;
	medWall: number;
	medTurns: number;
	medTools: number;
	medOutTok: number;
	medBlocks: number;
	fpBlocks: number; // blocks the measurer flagged false-positive: counted from a `fp` field if present
	medReviews: number; // subagent launches as a proxy for review/worker rounds
	timeouts: number;
	freshChars: number;
	freshTools: number;
	lintTotal: number;
}

function summarise(rows: Row[]): ArmSummary {
	const arm = rows[0]?.arm ?? "?";
	return {
		arm,
		runs: rows.length,
		passRate: Number(rate(rows.map((r) => r.oraclePass)).toFixed(2)),
		medWall: median(rows.map((r) => r.wallSeconds)),
		medTurns: median(rows.map((r) => r.turns)),
		medTools: median(rows.map((r) => r.toolCalls)),
		medOutTok: Math.round(median(rows.map((r) => r.outputTokens))),
		medBlocks: median(rows.map((r) => r.blocks.total)),
		fpBlocks: rows.reduce((n, r) => n + ((r as { fpBlocks?: number }).fpBlocks ?? 0), 0),
		medReviews: median(rows.map((r) => r.subagents)),
		timeouts: rows.filter((r) => r.timedOut).length,
		freshChars: median(rows.map((r) => r.fresh?.chars ?? 0)),
		freshTools: median(rows.map((r) => r.fresh?.tools ?? 0)),
		lintTotal: rows.reduce((n, r) => n + (r.lintViolations ?? 0), 0),
	};
}

function printArm(s: ArmSummary): void {
	console.log(
		`  ${pad(s.arm, 6)} runs=${padL(String(s.runs), 3)}  pass=${(s.passRate * 100).toFixed(0).padStart(3)}%  wall=${padL(s.medWall.toFixed(0), 5)}s  turns=${padL(String(s.medTurns), 4)}  tools=${padL(String(s.medTools), 4)}  out=${padL((s.medOutTok / 1000).toFixed(1), 5)}k  blocks=${padL(String(s.medBlocks), 3)}  subagents=${padL(String(s.medReviews), 3)}  freshTok=${padL((s.freshChars / 3.3 / 1000).toFixed(1), 5)}k/${s.freshTools}t  lint=${padL(String(s.lintTotal), 3)}  timeouts=${s.timeouts}`,
	);
}

function main(): void {
	const files = process.argv.slice(2);
	if (!files.length) {
		console.error("usage: node bench/suite/report.ts <arm.jsonl> [arm2.jsonl ...]");
		process.exit(2);
	}
	const arms = files.map(load).filter((r) => r.length);
	console.log("\nPer arm (medians over all runs):\n");
	arms.forEach((rows) => printArm(summarise(rows)));

	console.log("\nPer task (pass rate / median wall seconds), by arm:\n");
	const taskIds = [...new Set(arms.flat().map((r) => r.task))];
	const header = ["  task".padEnd(22), ...arms.map((rows) => pad(rows[0].arm, 14))].join("");
	console.log(header);
	for (const id of taskIds) {
		const cells = arms.map((rows) => {
			const rs = rows.filter((r) => r.task === id);
			return rs.length ? pad(`${(rate(rs.map((r) => r.oraclePass)) * 100).toFixed(0)}% ${median(rs.map((r) => r.wallSeconds)).toFixed(0)}s`, 14) : pad("—", 14);
		});
		console.log(`  ${pad(id, 20)}${cells.join("")}`);
	}

	if (arms.length >= 2) {
		const a = summarise(arms[0]);
		const b = summarise(arms[arms.length - 1]);
		const pct = (x: number, y: number) => (x === 0 ? "n/a" : `${(((y - x) / x) * 100).toFixed(0)}%`);
		console.log(`\n${a.arm} -> ${b.arm} (last arm vs first):`);
		console.log(`  pass rate:   ${(a.passRate * 100).toFixed(0)}% -> ${(b.passRate * 100).toFixed(0)}%`);
		console.log(`  wall median: ${a.medWall.toFixed(0)}s -> ${b.medWall.toFixed(0)}s  (${pct(a.medWall, b.medWall)})`);
		console.log(`  tool calls:  ${a.medTools} -> ${b.medTools}  (${pct(a.medTools, b.medTools)})`);
		console.log(`  output tok:  ${(a.medOutTok / 1000).toFixed(1)}k -> ${(b.medOutTok / 1000).toFixed(1)}k  (${pct(a.medOutTok, b.medOutTok)})`);
		console.log(`  blocks:      ${a.medBlocks} -> ${b.medBlocks}  (false positives: ${a.fpBlocks} -> ${b.fpBlocks})`);
		console.log(`  fresh req:   ${(a.freshChars / 3.3 / 1000).toFixed(1)}k tok / ${a.freshTools} tools -> ${(b.freshChars / 3.3 / 1000).toFixed(1)}k / ${b.freshTools}`);
		console.log(`  lint total:  ${a.lintTotal} -> ${b.lintTotal}`);
		console.log("\n  Decision rule: a removal holds pass rate and beats on wall/tokens; an addition lowers false-positive");
		console.log("  blocks, subagent rounds or lint without lowering pass rate. Tag false positives with a `fpBlocks` field.");
	}
}

main();
