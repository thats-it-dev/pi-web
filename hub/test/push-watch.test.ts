import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, LiveState, Snapshot } from "../../shared/src/protocol.ts";
import { sessionTitle, Viewers, watchPush } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import type { TurnOutcome } from "../src/turns.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup() {
	let n = 0;
	const registry = new Registry({
		factory: { startRpc: async (o) => new FakeHandle(`s-${++n}`, o.cwd) },
		lookup: { find: async () => null },
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const got: { o: TurnOutcome; snap: Snapshot }[] = [];
	const stop = watchPush(registry, (o, snap) => got.push({ o, snap }));
	const sent = { get kinds() { return got.map((g) => g.o.kind); } };
	return { registry, got, sent, stop };
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

test("a finished run is forwarded with its outcome and the session's snapshot", async () => {
	const { registry, got } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h);
	assert.deepEqual(got.map((g) => g.o), [{ sessionId: "s-1", kind: "finished", messageIndex: 1, text: "done" }]);
	assert.equal(got[0].snap.cwd, "/work/proj");
	assert.equal(got[0].snap.sessionId, "s-1");
});

test("watchPush has no viewer suppression: outcomes are forwarded while an app views the session", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const viewers = new Viewers();
	const leave = viewers.add("s-1");
	await run(h);
	await run(h, reply("error"));
	to(h, "needs_you");
	assert.deepEqual(sent.kinds, ["finished", "error", "needs_you"]);
	leave();
});

test("a session stream left attached (a hidden tab) doesn't hold back 'finished'", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const off = h.subscribe(() => {});
	await run(h);
	assert.deepEqual(sent.kinds, ["finished"]);
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
	assert.deepEqual(sent.kinds, []);
});

test("a dialog during a run sends 'needs_you', and the run still reports when it ends", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "running");
	to(h, "needs_you");
	to(h, "running");
	h.conv.messages.push(user("go"), reply());
	to(h, "idle");
	assert.deepEqual(sent.kinds, ["needs_you", "finished"]);
});

test("a dialog while idle sends 'needs_you' once and no 'finished'", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "needs_you");
	h.fire({ type: "state_changed" }); // the same state reported again
	to(h, "idle");
	assert.deepEqual(sent.kinds, ["needs_you"]);
});

test("a run that adds no new assistant message (a manual compaction) sends nothing", async () => {
	const { registry, sent } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.conv.messages.push(user("earlier"), reply());
	to(h, "running");
	to(h, "idle");
	assert.deepEqual(sent.kinds, []);
});

test("terminal sessions never push", async () => {
	const { registry, sent } = setup();
	const t = new FakeHandle("term-1", "/work/proj", null, { kind: "bridge", pid: 999 });
	assert.equal(registry.attachBridge(t), "attached");
	await run(t);
	to(t, "needs_you");
	assert.deepEqual(sent.kinds, []);
});

test("sessionTitle prefers the session name, falls back to the folder, and is clipped", () => {
	const h = new FakeHandle("s-1", "/work/proj");
	assert.equal(sessionTitle(h.snapshot()), "proj");
	h.conv.messages.push(user("fix the parser\nand the tests"));
	assert.equal(sessionTitle(h.snapshot()), "fix the parser");
	const snap = h.snapshot();
	assert.equal(sessionTitle({ ...snap, state: { ...snap.state, sessionName: "x".repeat(80) } }), `${"x".repeat(59)}…`);
});

test("stop() ends watching", async () => {
	const { registry, sent, stop } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	stop();
	to(h, "needs_you");
	assert.deepEqual(sent.kinds, []);
});

test("needs_you is forwarded with the waiting dialog in the snapshot; error with its text", async () => {
	const { registry, got } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.dialogs = [{ id: "d1", method: "select", title: "Allow git push?", message: "origin feat/x", options: ["allow", "deny"] }];
	to(h, "needs_you");
	assert.equal(got[0].o.kind, "needs_you");
	assert.equal(got[0].snap.dialogs[0].id, "d1");
	h.dialogs = [];
	to(h, "idle");
	await run(h, { role: "assistant", content: [], stopReason: "error", errorMessage: "model unreachable" });
	assert.equal(got[1].o.kind, "error");
	assert.equal(got[1].o.kind === "error" && got[1].o.text, "model unreachable");
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

test("Viewers.onViewing fires when one session's viewer count crosses zero either way", () => {
	const v = new Viewers();
	const seen: string[] = [];
	v.onViewing((sid, on) => seen.push(`${sid}:${on}`));
	const a1 = v.add("a");
	const a2 = v.add("a");
	const b = v.add("b");
	const anon = v.add();
	a1();
	a1();
	assert.deepEqual(seen, ["a:true", "b:true"]);
	a2();
	b();
	anon();
	assert.deepEqual(seen, ["a:true", "b:true", "a:false", "b:false"]);
});
