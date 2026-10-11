import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, PiEvent } from "../src/protocol.ts";
import { applyEvent, contentText, createConversation } from "../src/reducer.ts";

const SYSTEM = { role: "system", content: "", sections: { preamble: "You are…" }, timestamp: 1 } as AgentMessage;
const USER = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 2 } as AgentMessage;
const FINAL = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "pondering", thinkingSignature: "reasoning_content" },
		{ type: "text", text: "Hello world" },
	],
	api: "openai-completions",
	provider: "fake",
	model: "fake-a",
	usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105 },
	stopReason: "stop",
	timestamp: 3,
} as AgentMessage;

const upd = (assistantMessageEvent: object): PiEvent => ({ type: "message_update", assistantMessageEvent });

const TEXT_RUN: PiEvent[] = [
	{ type: "agent_start" },
	{ type: "turn_start" },
	{ type: "message_start", message: SYSTEM },
	{ type: "message_end", message: SYSTEM },
	{ type: "message_start", message: USER },
	{ type: "message_end", message: USER },
	{ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }], stopReason: "pending", timestamp: 3 } },
	upd({ type: "thinking_start", contentIndex: 0 }),
	upd({ type: "thinking_delta", contentIndex: 0, delta: "pondering" }),
	upd({ type: "text_start", contentIndex: 1 }),
	upd({ type: "text_delta", contentIndex: 1, delta: "Hello " }),
	upd({ type: "text_delta", contentIndex: 1, delta: "world" }),
	upd({ type: "thinking_end", contentIndex: 0, content: "pondering" }),
	upd({ type: "text_end", contentIndex: 1, content: "Hello world" }),
	{ type: "message_end", message: FINAL },
	{ type: "turn_end", message: FINAL, toolResults: [] },
	{ type: "agent_end", messages: [], willRetry: false },
	{ type: "agent_settled" },
];

test("a full run ends with exactly the user and final assistant messages", () => {
	const conv = createConversation();
	for (const ev of TEXT_RUN) applyEvent(conv, ev);
	assert.deepEqual(conv.messages, [USER, FINAL]);
	assert.equal(conv.partial, null);
	assert.equal(conv.streaming, false);
});

test("mid-stream the partial message holds the deltas so far, without duplicating prefilled content", () => {
	const conv = createConversation();
	for (const ev of TEXT_RUN.slice(0, 11)) applyEvent(conv, ev); // through "Hello "
	assert.equal(conv.streaming, true);
	assert.deepEqual(conv.partial?.content, [
		{ type: "thinking", thinking: "pondering" },
		{ type: "text", text: "Hello " },
	]);
});

test("tool calls stream into the partial, tool runs are tracked, results append", () => {
	const conv = createConversation();
	const call = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
	const assistant = { role: "assistant", content: [call], stopReason: "toolUse", timestamp: 4 };
	const result = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: 5 };
	const events: PiEvent[] = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [], timestamp: 4 } },
		upd({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" }),
		upd({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":' }),
	];
	for (const ev of events) applyEvent(conv, ev);
	assert.deepEqual(conv.partial?.content, [{ type: "toolCall", id: "call_1", name: "bash", arguments: {}, argsRaw: '{"command":' }]);

	applyEvent(conv, upd({ type: "toolcall_end", contentIndex: 0, toolCall: call }));
	applyEvent(conv, { type: "message_end", message: assistant });
	applyEvent(conv, { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
	assert.deepEqual({ ...conv.tools.call_1 }, { name: "bash", args: { command: "echo hi" }, running: true });
	applyEvent(conv, { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" }, partialResult: { content: [{ type: "text", text: "h" }] } });
	assert.equal(conv.tools.call_1.partialResult?.content?.[0]?.type, "text");
	applyEvent(conv, { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] }, isError: false });
	assert.equal(conv.tools.call_1.running, false);
	applyEvent(conv, { type: "message_end", message: result });
	assert.deepEqual(conv.messages, [assistant, result]);
});

test("queue, compaction and retry events update their flags", () => {
	const conv = createConversation();
	applyEvent(conv, { type: "queue_update", steering: ["stop that"], followUp: [] });
	assert.deepEqual(conv.queue, { steering: ["stop that"], followUp: [] });
	applyEvent(conv, { type: "compaction_start", reason: "manual" });
	assert.equal(conv.compacting, true);
	applyEvent(conv, { type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
	assert.equal(conv.compacting, false);
	applyEvent(conv, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
	assert.deepEqual(conv.retry, { attempt: 1, max: 3, error: "529 overloaded" });
	applyEvent(conv, { type: "auto_retry_end", success: true, attempt: 2 });
	assert.equal(conv.retry, null);
});

test("an aborted run settles with the aborted message and no partial", () => {
	const conv = createConversation();
	const aborted = { role: "assistant", content: [{ type: "text", text: "Hel" }], stopReason: "aborted", timestamp: 9 };
	applyEvent(conv, { type: "agent_start" });
	applyEvent(conv, { type: "message_start", message: { role: "assistant", content: [], timestamp: 9 } });
	applyEvent(conv, upd({ type: "text_delta", contentIndex: 0, delta: "Hel" }));
	applyEvent(conv, { type: "message_end", message: aborted });
	applyEvent(conv, { type: "agent_settled" });
	assert.deepEqual(conv.messages, [aborted]);
	assert.equal(conv.partial, null);
});

test("createConversation drops system messages; unknown events are ignored", () => {
	const conv = createConversation([SYSTEM, USER]);
	assert.deepEqual(conv.messages, [USER]);
	assert.equal(applyEvent(conv, { type: "something_new" }), null);
});

test("contentText joins text blocks and accepts plain strings", () => {
	assert.equal(contentText("plain"), "plain");
	assert.equal(contentText([{ type: "text", text: "a" }, { type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "b" }]), "a\nb");
	assert.equal(contentText(undefined), "");
});
