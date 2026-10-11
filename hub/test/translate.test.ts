import assert from "node:assert/strict";
import { test } from "node:test";
import { toRpc } from "../src/translate.ts";

test("app commands map to pi RPC commands", () => {
	assert.deepEqual(toRpc({ type: "prompt", text: "hi", mode: "send" }), { type: "prompt", message: "hi" });
	assert.deepEqual(toRpc({ type: "prompt", text: "stop", mode: "steer" }), { type: "prompt", message: "stop", streamingBehavior: "steer" });
	assert.deepEqual(toRpc({ type: "prompt", text: "look", mode: "followUp", images: [{ data: "AAAA", mimeType: "image/png" }] }), {
		type: "prompt",
		message: "look",
		images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		streamingBehavior: "followUp",
	});
	assert.deepEqual(toRpc({ type: "set_thinking", level: "high" }), { type: "set_thinking_level", level: "high" });
	assert.deepEqual(toRpc({ type: "compact" }), { type: "compact" });
	assert.deepEqual(toRpc({ type: "compact", instructions: "keep the API decisions" }), { type: "compact", customInstructions: "keep the API decisions" });
	assert.deepEqual(toRpc({ type: "rename", name: "portfolio" }), { type: "set_session_name", name: "portfolio" });
	assert.deepEqual(toRpc({ type: "get_fork_points" }), { type: "get_fork_messages" });
	assert.deepEqual(toRpc({ type: "bash", command: "ls", excludeFromContext: true }), { type: "bash", command: "ls", excludeFromContext: true });
	assert.deepEqual(toRpc({ type: "dialog_response", id: "d1", value: "blue" }), { type: "extension_ui_response", id: "d1", value: "blue" });
	assert.deepEqual(toRpc({ type: "dialog_response", id: "d2", cancelled: true }), { type: "extension_ui_response", id: "d2", cancelled: true });
});
