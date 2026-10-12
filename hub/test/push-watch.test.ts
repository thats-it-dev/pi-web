import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, LiveState, PushPayload } from "../../shared/src/protocol.ts";
import { watchPush } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup() {
	let n = 0;
	const registry = new Registry({
		factory: { startRpc: async (o) => new FakeHandle(`s-${++n}`, o.cwd) },
		lookup: { find: async () => null },
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const sent: PushPayload[] = [];
	const stop = watchPush(registry, (p) => sent.push(p));
	return { registry, sent, stop };
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });
const reply = (stopReason = "stop"): AgentMessage => ({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason });

function to(h: FakeHandle, state: LiveState): void {
	h.state = state;
	h.busy = state !== "idle";
	h.fire({ type: "state_changed" });
}

async function run(h: FakeHandle, end: AgentMessage = reply()): Promise<void> {
	to(h, "running");
	h.conv.messages.push(user("fix the parser\nand the tests"), end);
	to(h, "idle");
}

test("a run that finishes with nobody watching sends 'finished', titled by the first prompt line", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h);
	assert.deepEqual(sent, [{ sessionId: "s-1", title: "fix the parser", kind: "finished" }]);
});

test("no 'finished' while an app stream is attached", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const off = h.subscribe(() => {});
	await run(h);
	assert.deepEqual(sent, []);
	off();
});

test("a run that ends in an error sends 'error' even while watched; an aborted run sends nothing", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const off = h.subscribe(() => {});
	await run(h, reply("error"));
	assert.deepEqual(sent.map((p) => p.kind), ["error"]);
	off();
	await run(h, reply("aborted"));
	assert.deepEqual(sent.map((p) => p.kind), ["error"]);
});

test("a dialog during a run sends 'needs_you', and the run still reports when it ends", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "running");
	to(h, "needs_you");
	to(h, "running");
	h.conv.messages.push(user("go"), reply());
	to(h, "idle");
	assert.deepEqual(sent.map((p) => p.kind), ["needs_you", "finished"]);
});

test("a dialog while idle sends 'needs_you' once and no 'finished'", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "needs_you");
	h.fire({ type: "state_changed" }); // the same state reported again
	to(h, "idle");
	assert.deepEqual(sent.map((p) => p.kind), ["needs_you"]);
});

test("a run that adds no new assistant message (a manual compaction) sends nothing", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.conv.messages.push(user("earlier"), reply());
	to(h, "running");
	to(h, "idle");
	assert.deepEqual(sent, []);
});

test("terminal sessions never push", async () => {
	const { registry, sent } = setup();
	const t = new FakeHandle("term-1", "/work/proj", null, { kind: "bridge", pid: 999 });
	assert.equal(registry.attachBridge(t), "attached");
	await run(t);
	to(t, "needs_you");
	assert.deepEqual(sent, []);
});

test("the title prefers the session name, falls back to the folder, and is clipped", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "needs_you");
	assert.equal(sent.at(-1)?.title, "proj");
	const snap = h.snapshot.bind(h);
	h.snapshot = () => ({ ...snap(), state: { ...snap().state, sessionName: "x".repeat(80) } });
	to(h, "idle");
	to(h, "needs_you");
	assert.equal(sent.at(-1)?.title, `${"x".repeat(59)}…`);
});

test("stop() ends watching", async () => {
	const { registry, sent, stop } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	stop();
	to(h, "needs_you");
	assert.deepEqual(sent, []);
});
