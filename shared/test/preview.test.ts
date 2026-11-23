import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "../src/protocol.ts";
import { derivePreview } from "../src/preview.ts";
import { createConversation } from "../src/reducer.ts";

const user = (t = "hi"): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 1 });
const result = (id: string, details: Record<string, unknown> | undefined, extra: object = {}): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "preview",
	content: [],
	details,
	isError: false,
	timestamp: 2000,
	...extra,
});
const good = (n: number, extra: object = {}) =>
	result(`p${n}`, { url: `http://localhost:${n}/`, label: `app ${n}`, kind: "dev", port: n, root: "/x" }, extra);

test("the latest successful preview result is the state", () => {
	const c = createConversation([user(), good(1, { timestamp: 10 }), good(2, { timestamp: 20 })]);
	assert.deepEqual(derivePreview(c), { id: "p2", url: "http://localhost:2/", label: "app 2", kind: "dev", at: 20 });
});

test("a stop result clears it", () => {
	const c = createConversation([user(), good(1), result("s", { stopped: true })]);
	assert.equal(derivePreview(c), null);
});

test("an error result is ignored", () => {
	const c = createConversation([user(), good(1), result("e", { error: "boom" }, { isError: true })]);
	assert.equal(derivePreview(c)?.url, "http://localhost:1/");
	assert.equal(derivePreview(createConversation([user(), result("e", undefined, { isError: true })])), null);
});

test("a live tool run with a result counts before its toolResult message lands", () => {
	const c = createConversation([user()]);
	c.tools.live = {
		name: "preview",
		running: false,
		result: { content: [], details: { url: "http://localhost:9/", label: "live", kind: "static" } },
	} as any;
	assert.deepEqual(derivePreview(c), { id: "live", url: "http://localhost:9/", label: "live", kind: "static", at: 0 });
});

test("same url, new id → a different state id (a restart on the same url)", () => {
	const restartedTo = { url: "http://localhost:1/", label: "app 1", kind: "dev" };
	const first = derivePreview(createConversation([user(), good(1, { timestamp: 10 })]));
	const c = createConversation([user(), good(1, { timestamp: 10 })]);
	c.tools.again = { name: "preview", running: false, result: { content: [], details: restartedTo } } as any;
	const live = derivePreview(c);
	const landed = derivePreview(createConversation([user(), good(1, { timestamp: 10 }), result("again", restartedTo, { timestamp: 30 })]));
	assert.equal(first?.id, "p1");
	assert.equal(live?.url, first?.url);
	assert.equal(live?.id, "again");
	assert.notEqual(live?.id, first?.id);
	assert.equal(landed?.id, "again"); // the same call landing in the messages keeps its id
});

test("nothing → null", () => {
	assert.equal(derivePreview(createConversation([user()])), null);
});
