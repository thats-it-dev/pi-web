import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "../src/protocol.ts";
import { rejectKind, runReports, runReportsFromEntries } from "../src/run-report.ts";

const user = (t: string, ts: number): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }], timestamp: ts });
const calls = (ts: number, ...parts: Array<[string, string, Record<string, unknown>?]>): AgentMessage => ({
	role: "assistant",
	stopReason: "toolUse",
	content: parts.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args ?? {} })),
	timestamp: ts,
});
const said = (ts: number): AgentMessage => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], timestamp: ts });
const res = (id: string, ts: number, text = "ok", isError = false): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text }],
	isError,
	timestamp: ts,
});
const custom = (customType: string, ts: number): AgentMessage => ({ role: "custom", customType, content: "x", display: true, timestamp: ts });

test("splits time between the model and tools, counting calls, per run since each user message", () => {
	const msgs = [
		user("first task", 0),
		calls(10_000, ["a", "bash"]), // model 10 s
		res("a", 15_000), // tools 5 s
		said(45_000), // model 30 s
		user("second", 100_000),
		calls(102_000, ["b", "read"], ["c", "edit"]),
		res("b", 103_000),
		res("c", 103_500),
		said(110_000),
	];
	const runs = runReports(msgs, { now: 999_999, streaming: false });
	assert.equal(runs.length, 2);
	const [first, second] = runs;
	assert.deepEqual({ label: first.label, elapsedMs: first.elapsedMs, modelMs: first.modelMs, toolMs: first.toolMs, toolCalls: first.toolCalls }, { label: "first task", elapsedMs: 45_000, modelMs: 40_000, toolMs: 5_000, toolCalls: 1 });
	assert.equal(second.toolCalls, 2);
	assert.equal(second.modelMs, 2_000 + 6_500);
	assert.equal(second.toolMs, 1_500);
});

test("a live run counts the open wait: the model after a result, tools after a tool call", () => {
	const waitingOnModel = runReports([user("go", 0), calls(1_000, ["a", "bash"]), res("a", 3_000)], { now: 10_000, streaming: true })[0];
	assert.equal(waitingOnModel.elapsedMs, 10_000);
	assert.equal(waitingOnModel.modelMs, 1_000 + 7_000);
	const waitingOnTool = runReports([user("go", 0), calls(1_000, ["a", "bash"])], { now: 10_000, streaming: true })[0];
	assert.equal(waitingOnTool.toolMs, 9_000);
});

test("rejected tool results are grouped by their text", () => {
	assert.equal(rejectKind("🔄 RETRYABLE — Edit target not found"), "edit retries");
	assert.equal(rejectKind("⚠️ PARTIAL APPLY — 6 edits committed"), "edit retries");
	assert.equal(rejectKind("🔄 RETRYABLE — Edit without read: you have not read"), "edit retries");
	assert.equal(rejectKind("Blocked: don't rewrite files with a Python script."), "guard blocks");
	assert.equal(rejectKind("ls: cannot access 'docs'\n\nCommand exited with code 2"), "failed commands");
	assert.equal(rejectKind("Tool file_diff not found"), "other");
	const r = runReports([user("go", 0), calls(1, ["a", "edit"], ["b", "bash"]), res("a", 2, "🔄 RETRYABLE — x", true), res("b", 3, "Blocked: no", true)], { now: 4, streaming: false })[0];
	assert.equal(r.rejected, 2);
	assert.deepEqual(r.rejectedBy, { "edit retries": 1, "guard blocks": 1 });
});

test("guard nudges, compactions and the reviewer are reported", () => {
	const msgs: AgentMessage[] = [
		user("go", 0),
		said(1_000),
		custom("pi-guard-nudge", 1_100),
		custom("pi-guard-todos", 1_200),
		custom("i-have-adhd-rules", 1_300),
		{ role: "compactionSummary", summary: "s", tokensBefore: 251_325, timestamp: 2_000 },
		calls(3_000, ["bg", "subagent", { agent: "reviewer", task: "t" }]),
		res("bg", 3_100),
		calls(4_000, ["fail", "subagent", { agent: "reviewer", async: false }]),
		res("fail", 4_100, "boom", true),
	];
	let r = runReports(msgs, { now: 5_000, streaming: false })[0];
	assert.deepEqual(r.nudges, { stall: 1, "to-dos": 1 });
	assert.deepEqual(r.compactions, [251_325]);
	assert.equal(r.reviewedAt, null, "a background run or a failed review does not count");
	msgs.push(calls(6_000, ["ok", "subagent", { agent: "reviewer", async: false, task: "t" }]), res("ok", 9_000));
	r = runReports(msgs, { now: 10_000, streaming: false })[0];
	assert.equal(r.reviewedAt, 9_000);
});

test("no user message yet, or messages without timestamps, do not break the report", () => {
	assert.deepEqual(runReports([], { now: 1, streaming: false }), []);
	const r = runReports([user("go", 0), { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: {} }] }, res("a", 5)], { now: 9, streaming: false })[0];
	assert.equal(r.toolCalls, 1);
	assert.ok(r.modelMs + r.toolMs <= r.elapsedMs);
});

test("from session entries: an assistant message counts until it was written, not from when it began", () => {
	const at = (s: number) => new Date(s * 1000).toISOString();
	const entries = [
		{ type: "message", timestamp: at(0), message: { role: "user", content: "go", timestamp: 0 } },
		{ type: "message", timestamp: at(20), message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: {} }], timestamp: 1_000 } },
		{ type: "message", timestamp: at(22), message: { role: "toolResult", toolCallId: "a", content: [], timestamp: 22_000 } },
		{ type: "custom_message", timestamp: at(23), customType: "pi-guard-nudge", content: "x", display: false },
		{ type: "compaction", timestamp: at(24), tokensBefore: 9 },
	];
	const [r] = runReportsFromEntries(entries, { now: 0, streaming: false });
	assert.equal(r.modelMs, 20_000);
	assert.equal(r.toolMs, 2_000);
	assert.deepEqual(r.nudges, { stall: 1 }, "hidden custom messages count too");
	assert.deepEqual(r.compactions, [9]);
});
