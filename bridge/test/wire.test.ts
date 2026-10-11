import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, createConversation } from "../../shared/src/reducer.ts";
import { commandInfos, extensionCommandName, sessionStats, slimModel, wireEvent } from "../wire.ts";

const usage = (input: number, output: number, cost = 0) => ({ input, output, cacheRead: 1, cacheWrite: 2, cost: { total: cost } });

test("message_update loses message and partial, like RPC mode; the reducer still rebuilds the reply", () => {
	const partial = { role: "assistant", content: [{ type: "text", text: "Hel" }] };
	const conv = createConversation();
	const raw = [
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", message: { ...partial, usage: usage(3, 1) }, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial } },
		{ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial } },
		{ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial } },
	];
	for (const ev of raw) {
		const w = wireEvent(ev);
		assert.ok(w);
		assert.equal("partial" in (w.assistantMessageEvent ?? {}), false);
		assert.equal("message" in w && w.type === "message_update", false);
		applyEvent(conv, w);
	}
	assert.deepEqual(conv.partial?.content, [{ type: "text", text: "Hello" }]);
	assert.deepEqual(conv.partial?.usage, usage(3, 1));
});

test("toolcall_start gains the call id and tool name from partial", () => {
	const partial = { content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] };
	const w = wireEvent({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } });
	assert.deepEqual(w?.assistantMessageEvent, { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" });
});

test("system messages and pi-only events are not forwarded; heavy fields are dropped", () => {
	assert.equal(wireEvent({ type: "message_start", message: { role: "system", content: "prompt" } }), null);
	assert.equal(wireEvent({ type: "model_select", model: {} }), null);
	assert.equal(wireEvent({ type: "ui_prompt_start", kind: "select" }), null);
	assert.deepEqual(wireEvent({ type: "agent_end", messages: [1, 2, 3] }), { type: "agent_end" });
	assert.deepEqual(wireEvent({ type: "turn_end", turnIndex: 2, message: {}, toolResults: [], context: {} }), { type: "turn_end", turnIndex: 2 });
	assert.deepEqual(wireEvent({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: [] }, isError: false }), {
		type: "tool_execution_end",
		toolCallId: "c",
		toolName: "bash",
		result: { content: [] },
		isError: false,
	});
});

test("compaction events are synthesized from the session compaction hooks", () => {
	assert.deepEqual(wireEvent({ type: "session_before_compact", reason: "manual", preparation: {}, branchEntries: [] }), { type: "compaction_start", reason: "manual" });
	assert.deepEqual(wireEvent({ type: "session_compact", reason: "threshold", willRetry: false, compactionEntry: {} }), { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
	assert.deepEqual(wireEvent({ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, errorMessage: "nope" }), {
		type: "compaction_end",
		reason: "manual",
		aborted: true,
		willRetry: false,
		errorMessage: "nope",
	});
});

test("stats sum usage the way pi's getSessionStats does", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text" }, { type: "toolCall" }, { type: "toolCall" }], usage: usage(10, 5, 0.5) } },
		{ type: "message", message: { role: "toolResult", content: [] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text" }] } }, // aborted before usage
		{ type: "compaction", usage: usage(100, 20, 1) },
		{ type: "model_change" },
	];
	const stats = sessionStats(entries, { sessionId: "s", sessionFile: "/f" }, { tokens: 7, contextWindow: 1000, percent: 0.7 });
	assert.deepEqual(stats, {
		sessionFile: "/f",
		sessionId: "s",
		userMessages: 1,
		assistantMessages: 2,
		toolCalls: 2,
		toolResults: 1,
		totalMessages: 4,
		tokens: { input: 110, output: 25, cacheRead: 2, cacheWrite: 4, total: 141 },
		cost: 1.5,
		contextUsage: { tokens: 7, contextWindow: 1000, percent: 0.7 },
	});
});

test("models are slimmed to the app's ModelInfo; command lists keep pi's three sources", () => {
	assert.deepEqual(slimModel({ id: "a", name: "A", provider: "p", reasoning: true, input: ["text", "image"], contextWindow: 9, maxTokens: 3, api: "x", baseUrl: "y" } as never), {
		id: "a",
		name: "A",
		provider: "p",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 9,
		maxTokens: 3,
		cost: undefined,
	});
	const cmds = [
		{ name: "ask", description: "d", source: "extension", sourceInfo: {} },
		{ name: "greet", source: "prompt" },
		{ name: "skill:demo", source: "skill" },
		{ name: "weird", source: "other" },
	];
	assert.deepEqual(commandInfos(cmds), [
		{ name: "ask", description: "d", source: "extension" },
		{ name: "greet", description: undefined, source: "prompt" },
		{ name: "skill:demo", description: undefined, source: "skill" },
	]);
	assert.equal(extensionCommandName("/ask now", cmds), "ask");
	assert.equal(extensionCommandName("  /ask", cmds), "ask");
	assert.equal(extensionCommandName("/greet Bob", cmds), null);
	assert.equal(extensionCommandName("tell me about /ask", cmds), null);
});
