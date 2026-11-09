import { test } from "node:test";
import assert from "node:assert/strict";
import piGuard from "../index.ts";
import { NUDGE_TYPE, REASONS } from "../rules.ts";

function load() {
	const handlers: Record<string, (event: any, ctx: { cwd: string }) => any> = {};
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
