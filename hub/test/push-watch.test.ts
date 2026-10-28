import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, LiveState, PushPayload } from "../../shared/src/protocol.ts";
import { Viewers, watchPush } from "../src/push-watch.ts";
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
	const viewers = new Viewers();
	const stop = watchPush(registry, (p) => sent.push(p), viewers);
	return { registry, sent, stop, viewers };
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
	assert.deepEqual(sent, [{ sessionId: "s-1", title: "fix the parser", kind: "finished", body: "done" }]);
});

test("nothing is sent while the app is open somewhere, and everything is once it's gone", async () => {
	const { registry, sent, viewers } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const leave = viewers.add();
	await run(h);
	await run(h, reply("error"));
	to(h, "needs_you");
	to(h, "idle");
	assert.equal(sent.length, 0);
	leave();
	await run(h);
	await run(h, reply("error"));
	to(h, "needs_you");
	assert.deepEqual(sent.map((p) => p.kind), ["finished", "error", "needs_you"]);
});

test("a session stream left attached (a hidden tab) doesn't hold back 'finished'", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const off = h.subscribe(() => {});
	await run(h);
	assert.deepEqual(sent.map((p) => p.kind), ["finished"]);
	off();
});

test("viewers count each open app; leaving twice counts once", () => {
	const v = new Viewers();
	const a = v.add();
	const b = v.add();
	a();
	a();
	assert.equal(v.watching(), true);
	b();
	assert.equal(v.watching(), false);
});

test("an aborted run sends nothing", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h, reply("aborted"));
	assert.deepEqual(sent, []);
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

test("push body carries the dialog message for needs_you", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.dialogs = [{ id: "d1", method: "select", title: "Allow git push?", message: "origin feat/x", options: ["allow", "deny"] }];
	to(h, "needs_you");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].body, "Allow git push?\norigin feat/x");
});

test("push body is the reply excerpt for finished, clipped to 160", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h, { role: "assistant", content: [{ type: "text", text: "x".repeat(300) }], stopReason: "stop" });
	assert.equal(sent[0].body, `${"x".repeat(159)}…`);
	assert.equal(sent[0].body?.length, 160);
});

test("push body is the error text for error", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h, { role: "assistant", content: [], stopReason: "error", errorMessage: "model unreachable" });
	assert.equal(sent[0].kind, "error");
	assert.equal(sent[0].body, "model unreachable");
});

test("Viewers tracks which session each viewer is on, and the global count is unchanged", () => {
	const v = new Viewers();
	const seen: boolean[] = [];
	v.onChange((w) => seen.push(w));
	const a1 = v.add("a");
	const a2 = v.add("a");
	assert.equal(v.viewing("a"), true);
	assert.equal(v.viewing("b"), false);
	assert.equal(v.watching(), true);
	a1();
	a1(); // idempotent
	assert.equal(v.viewing("a"), true);
	a2();
	assert.equal(v.viewing("a"), false);
	assert.equal(v.watching(), false);
	const anon = v.add();
	assert.equal(v.watching(), true);
	assert.equal(v.viewing("a"), false);
	anon();
	assert.deepEqual(seen, [true, false, true, false]);
});
