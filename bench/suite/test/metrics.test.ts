import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSession, scanBlocks, tallyBlocks, freshParent } from "../metrics.ts";

const line = (o: unknown) => JSON.stringify(o);
const assistant = (content: unknown[], usage: Record<string, number> = {}) => line({ type: "message", message: { role: "assistant", content, usage } });
const call = (name: string) => ({ type: "toolCall", name });

test("parseSession: turns, tool counts, work vs harness turns, tokens and cache ratio", () => {
	const jsonl = [
		line({ type: "model_change", provider: "spark", modelId: "inkling-2-mini" }),
		assistant([{ type: "thinking", thinking: "x" }, call("edit")], { input: 1000, output: 50, reasoning: 10, cacheRead: 0 }),
		assistant([call("bash")], { input: 1200, output: 20, cacheRead: 300 }),
		assistant([call("subagent")], { input: 2000, output: 5, cacheRead: 100 }), // pure harness turn
		assistant([call("ask_user_question")], { input: 2100, output: 5, cacheRead: 100 }), // harness + an intervention
		line({ type: "compaction_summary" }),
		line({ type: "message", message: { role: "user", content: "hi" } }), // not an assistant turn
	].join("\n");
	const m = parseSession(jsonl);
	assert.equal(m.turns, 4);
	assert.equal(m.toolCalls, 4);
	assert.deepEqual(m.byTool, { edit: 1, bash: 1, subagent: 1, ask_user_question: 1 });
	assert.equal(m.harnessTurns, 2, "the subagent-only and ask-only turns, not the edit or bash turns");
	assert.equal(m.asks, 1);
	assert.equal(m.subagents, 1);
	assert.equal(m.compactions, 1);
	assert.equal(m.outputTokens, 80);
	assert.equal(m.reasoningTokens, 10);
	assert.equal(m.cacheReadTokens, 500);
	assert.equal(m.peakContextTokens, 2200, "input + cacheRead of the biggest turn");
	assert.deepEqual(m.models, ["spark/inkling-2-mini"]);
	assert.equal(m.cacheHitRatio, Number((500 / (6300 + 500)).toFixed(3)));
});

test("parseSession: a read-only turn is neither work nor pure harness; blank and junk lines are skipped", () => {
	const m = parseSession(["", "not json", assistant([call("read"), call("grep")], { input: 100 }), assistant([], { input: 50 })].join("\n"));
	assert.equal(m.turns, 2);
	assert.equal(m.harnessTurns, 0, "a read/grep turn is not counted as pure harness");
	assert.equal(m.toolCalls, 2);
});

test("scanBlocks and tallyBlocks: only the window, counted by reason", () => {
	const log = [
		line({ t: "2026-11-25T10:00:00Z", reason: "push", tool: "bash", child: false }),
		line({ t: "2026-11-25T10:05:00Z", reason: "rewrite", tool: "bash", child: true }),
		line({ t: "2026-11-25T10:30:00Z", reason: "push", tool: "bash", child: false }),
		line({ t: "2026-11-25T11:00:00Z", reason: "merge", tool: "bash", child: false }), // outside the window
	].join("\n");
	const rows = scanBlocks(log, "2026-11-25T10:00:00Z", "2026-11-25T10:45:00Z");
	assert.equal(rows.length, 3);
	assert.deepEqual(tallyBlocks(rows), { total: 3, byReason: { push: 2, rewrite: 1 } });
});

test("freshParent: the smallest-message parent entry in the window", () => {
	const digest = [
		line({ t: "2026-11-25T10:01:00Z", child: false, msgs: ["a", "b", "c", "d", "e"], chars: 400000, tools: 28, sysChars: 12000 }),
		line({ t: "2026-11-25T10:02:00Z", child: false, msgs: ["a"], chars: 68000, tools: 28, sysChars: 12712 }), // the fresh one
		line({ t: "2026-11-25T10:03:00Z", child: true, msgs: ["a"], chars: 30000, tools: 7, sysChars: 3000 }), // a child, ignored
	].join("\n");
	assert.deepEqual(freshParent(digest, "2026-11-25T10:00:00Z", "2026-11-25T10:10:00Z"), { chars: 68000, tools: 28, sysChars: 12712 });
	assert.equal(freshParent(digest, "2026-11-25T12:00:00Z", null), null, "nothing in the window");
});
