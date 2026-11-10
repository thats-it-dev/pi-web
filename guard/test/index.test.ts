import { test } from "node:test";
import assert from "node:assert/strict";
import piGuard from "../index.ts";
import { NUDGE_TYPE, REASONS, TODO_NUDGE_TYPE } from "../rules.ts";

function load() {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	piGuard({ on: (event, handler) => void (handlers[event] = handler) });
	return handlers;
}

const stalled = [
	{ role: "user", content: "fix it" },
	{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "write" }] },
	{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
	{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
];

test("a stalled run is continued, though pi reports canContinue false before the nudge is added", () => {
	const r = load().agent_before_settle({ outcome: "completed", context: { canContinue: false, contextMessages: stalled } }, { cwd: "/" });
	assert.equal(r.continue, true);
	assert.equal(r.entries[0].customType, NUDGE_TYPE);
	assert.equal(r.entries[0].display, true);
});

test("an aborted run is never continued", () => {
	const r = load().agent_before_settle({ outcome: "aborted", context: { canContinue: false, contextMessages: stalled } }, { cwd: "/" });
	assert.equal(r, undefined);
});

test("tool_call returns the block for pi", () => {
	const r = load().tool_call({ toolName: "bash", input: { command: "cd ~/workspace/apps/keeb && gh run watch 1" } }, { cwd: "/" });
	assert.deepEqual(r, { block: true, reason: REASONS.ci });
});

test("a finished run with open to-dos on the branch gets the to-do nudge", () => {
	const finished = [
		{ role: "user", content: "fix it" },
		{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "edit" }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. " + "x".repeat(400) }] },
	];
	const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 3, tasks: [{ id: 1, subject: "a", status: "completed" }, { id: 2, subject: "b", status: "in_progress" }] } } }];
	const ctx = { cwd: "/", sessionManager: { getBranch: () => branch } };
	const r = load().agent_before_settle({ outcome: "completed", context: { canContinue: false, contextMessages: finished } }, ctx);
	assert.equal(r.continue, true);
	assert.equal(r.entries[0].customType, TODO_NUDGE_TYPE);
	assert.match(r.entries[0].content, /#2 b \(in progress\)/);
	assert.equal(load().agent_before_settle({ outcome: "completed", context: { contextMessages: finished } }, { cwd: "/", sessionManager: { getBranch: () => [] } }), undefined);
});
