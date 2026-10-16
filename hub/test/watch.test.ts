import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage, Dialog, LiveState } from "../../shared/src/protocol.ts";
import { Viewers } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { SessionIndex } from "../src/sessions.ts";
import { WatchService } from "../src/watch.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup() {
	let n = 0;
	const registry = new Registry({
		factory: { startRpc: async (o) => new FakeHandle(`s-${++n}`, o.cwd) },
		lookup: { find: async () => null },
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const dir = mkdtempSync(join(tmpdir(), "watch-test-"));
	const clock = { t: 1000 };
	const viewers = new Viewers();
	const svc = new WatchService({ registry, index: new SessionIndex(dir), viewers, home: dir, now: () => clock.t });
	return { registry, viewers, svc, clock };
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
	h.conv.messages.push(user("fix the parser"), end);
	to(h, "idle");
}

const push: Dialog = { id: "d1", method: "select", title: "Allow git push?", message: "origin feat/x", options: ["allow", "allow always", "deny"] };

function raise(h: FakeHandle, d: Dialog): void {
	h.dialogs = [...h.dialogs, d];
	to(h, "needs_you");
}

function settle(h: FakeHandle, id: string): void {
	h.dialogs = h.dialogs.filter((d) => d.id !== id);
	to(h, h.dialogs.length ? "needs_you" : "idle");
}

const tick = () => new Promise<void>((r) => setImmediate(r));

async function session(registry: Registry): Promise<FakeHandle> {
	return (await registry.create("/work/proj")) as FakeHandle;
}

test("a pending select dialog becomes a request with tool name, title+message and options", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	h.pendingToolValue = { name: "bash", args: {} };
	raise(h, push);
	assert.deepEqual(svc.pending().requests, [
		{
			id: "dialog:s-1:d1",
			kind: "dialog",
			sessionId: "s-1",
			sessionTitle: "proj",
			tool: "bash",
			message: "Allow git push?\norigin feat/x",
			options: ["allow", "allow always", "deny"],
			method: "select",
			createdAt: 1000,
		},
	]);
	svc.close();
});

test("a confirm dialog gets options yes/no; input and editor get none", async () => {
	const { registry, svc, clock } = setup();
	const h = await session(registry);
	raise(h, { id: "c1", method: "confirm", title: "Proceed?" });
	clock.t = 2000;
	raise(h, { id: "i1", method: "input", title: "Name?" });
	clock.t = 3000;
	raise(h, { id: "e1", method: "editor", title: "Edit" });
	const reqs = svc.pending().requests;
	assert.deepEqual(
		reqs.map((r) => [r.id, r.method, r.options, r.message, r.tool, r.createdAt]),
		[
			["dialog:s-1:c1", "confirm", ["yes", "no"], "Proceed?", null, 1000],
			["dialog:s-1:i1", "input", [], "Name?", null, 2000],
			["dialog:s-1:e1", "editor", [], "Edit", null, 3000],
		],
	);
	svc.close();
});

test("requests are sorted oldest first and createdAt is when first seen", async () => {
	const { registry, svc, clock } = setup();
	const a = await session(registry);
	const b = await session(registry);
	clock.t = 5000;
	raise(b, { id: "x", method: "confirm", title: "B?" });
	svc.pending();
	clock.t = 6000;
	raise(a, { id: "y", method: "confirm", title: "A?" });
	assert.deepEqual(
		svc.pending().requests.map((r) => [r.id, r.createdAt]),
		[
			["dialog:s-2:x", 5000],
			["dialog:s-1:y", 6000],
		],
	);
	svc.close();
});

test("answering with an option sends dialog_response value; confirm no sends confirmed:false; the request is gone afterwards", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	raise(h, { id: "c1", method: "confirm", title: "Proceed?" });
	assert.deepEqual(await svc.answer("dialog:s-1:d1", { option: "allow" }), { ok: true });
	assert.deepEqual(await svc.answer("dialog:s-1:c1", { option: "no" }), { ok: true });
	assert.deepEqual(h.received, [
		{ type: "dialog_response", id: "d1", value: "allow" },
		{ type: "dialog_response", id: "c1", confirmed: false },
	]);
	assert.deepEqual(svc.pending().requests, []);
	svc.close();
});

test("an option that is not one of the dialog's gets no_match and sends nothing", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	assert.deepEqual(await svc.answer("dialog:s-1:d1", { option: "maybe" }), { ok: false, reason: "no_match", options: ["allow", "allow always", "deny"] });
	assert.deepEqual(h.received, []);
	svc.close();
});

test("answering with text uses matchOption; no_match returns the options and sends nothing", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	raise(h, { id: "c1", method: "confirm", title: "Proceed?" });
	raise(h, { id: "i1", method: "input", title: "Name?" });
	assert.deepEqual(await svc.answer("dialog:s-1:d1", { text: "the moon" }), { ok: false, reason: "no_match", options: ["allow", "allow always", "deny"] });
	raise(h, { id: "s1", method: "select", title: "Edit file?", options: ["allow once", "allow always", "deny"] });
	assert.deepEqual(await svc.answer("dialog:s-1:s1", { text: "allow" }), { ok: false, reason: "no_match", options: ["allow once", "allow always", "deny"] }); // ambiguous collapses
	assert.deepEqual(h.received, []);
	assert.deepEqual(await svc.answer("dialog:s-1:d1", { text: "Deny" }), { ok: true });
	assert.deepEqual(await svc.answer("dialog:s-1:c1", { text: "go ahead" }), { ok: true });
	assert.deepEqual(await svc.answer("dialog:s-1:i1", { text: "Pebble" }), { ok: true });
	assert.deepEqual(h.received, [
		{ type: "dialog_response", id: "d1", value: "deny" },
		{ type: "dialog_response", id: "c1", confirmed: true },
		{ type: "dialog_response", id: "i1", value: "Pebble" },
	]);
	svc.close();
});

test("a dialog answered elsewhere: pending drops it and answer returns gone", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	assert.equal(svc.pending().requests.length, 1);
	settle(h, "d1");
	assert.deepEqual(svc.pending().requests, []);
	assert.deepEqual(await svc.answer("dialog:s-1:d1", { option: "allow" }), { ok: false, reason: "gone" });
	assert.deepEqual(await svc.answer("nonsense", { text: "hi" }), { ok: false, reason: "gone" });
	assert.deepEqual(h.received, []);
	svc.close();
});

test("a finished turn with nobody watching becomes a finished request; a new run clears it", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await run(h);
	assert.deepEqual(svc.pending().requests, [
		{ id: "finished:s-1:1", kind: "finished", sessionId: "s-1", sessionTitle: "fix the parser", tool: "question", message: "done", options: [], method: null, createdAt: 1000 },
	]);
	to(h, "running");
	assert.deepEqual(svc.pending().requests, []);
	svc.close();
});

test("an errored turn becomes an error request; a long reply is clipped", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await run(h, { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }], stopReason: "error", errorMessage: "overloaded" });
	const [r] = svc.pending().requests;
	assert.equal(r.id, "error:s-1:1");
	assert.equal(r.kind, "error");
	assert.equal(r.message, "overloaded");
	await run(h, { role: "assistant", content: [{ type: "text", text: "y".repeat(1000) }], stopReason: "stop" });
	const [f] = svc.pending().requests;
	assert.equal(f.id, "finished:s-1:3");
	assert.ok(f.message.length <= 240 && f.message.endsWith("…"));
	svc.close();
});

test("viewer gate: while an app is open, pending is empty; finished is dropped for good; a dialog comes back", async () => {
	const { registry, svc, viewers } = setup();
	const a = await session(registry);
	const b = await session(registry);
	await run(a);
	raise(b, push);
	assert.equal(svc.pending().requests.length, 2);
	const leave = viewers.add();
	assert.deepEqual(svc.pending().requests, []);
	leave();
	assert.deepEqual(
		svc.pending().requests.map((r) => r.id),
		["dialog:s-2:d1"],
	);
	svc.close();
});

test("finished recorded while an app is open never appears", async () => {
	const { registry, svc, viewers } = setup();
	const h = await session(registry);
	const leave = viewers.add();
	await run(h);
	leave();
	assert.deepEqual(svc.pending().requests, []);
	svc.close();
});

test("dismiss hides a request until it ends; a new dialog with the same id after the old one ended is not dismissed", async () => {
	const { registry, svc, viewers } = setup();
	const h = await session(registry);
	raise(h, push);
	svc.dismiss("dialog:s-1:d1");
	assert.deepEqual(svc.pending().requests, []);
	viewers.add()(); // an app opened and closed: the dismissal survives
	assert.deepEqual(svc.pending().requests, []);
	settle(h, "d1");
	raise(h, push);
	assert.deepEqual(
		svc.pending().requests.map((r) => r.id),
		["dialog:s-1:d1"],
	);
	await run(h);
	svc.dismiss("finished:s-1:1");
	assert.deepEqual(
		svc.pending().requests.map((r) => r.id),
		["dialog:s-1:d1"],
	);
	svc.close();
});

test("wait resolves early on change and at maxMs without one; two waiters both wake", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await tick();
	const c0 = svc.pending().cursor;
	const start = Date.now();
	const a = svc.wait(c0, 2000);
	const b = svc.wait(c0, 2000);
	assert.equal(svc.waiterCount(), 2);
	raise(h, push);
	const [pa, pb] = await Promise.all([a, b]);
	assert.ok(Date.now() - start < 500);
	assert.ok(pa.cursor > c0);
	assert.equal(pb.cursor, pa.cursor);
	assert.equal(pa.requests.length, 1);
	assert.equal(svc.waiterCount(), 0);
	const t0 = Date.now();
	const idle = await svc.wait(pa.cursor, 30);
	assert.ok(Date.now() - t0 >= 25);
	assert.equal(idle.cursor, pa.cursor);
	assert.equal(svc.waiterCount(), 0);
	svc.close();
});

test("wait returns at once when the cursor is already past since; a burst bumps the cursor once", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await tick();
	const c0 = svc.pending().cursor;
	raise(h, push);
	raise(h, { id: "c1", method: "confirm", title: "Proceed?" });
	await tick();
	assert.equal(svc.pending().cursor, c0 + 1);
	const p = await svc.wait(c0, 2000);
	assert.equal(p.cursor, c0 + 1);
	svc.close();
});

test("showing is remembered and cleared when its request ends; currentTarget falls back to the most recently shown pending request", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	raise(h, { id: "c1", method: "confirm", title: "Proceed?" });
	assert.equal(svc.currentTarget(), null);
	svc.showing("dialog:s-1:c1");
	svc.showing("dialog:s-1:d1", "s-1");
	assert.equal(svc.pending().showing, "dialog:s-1:d1");
	assert.deepEqual(svc.currentTarget(), { requestId: "dialog:s-1:d1", sessionId: "s-1" });
	svc.showing(null);
	assert.equal(svc.pending().showing, null);
	assert.deepEqual(svc.currentTarget(), { requestId: "dialog:s-1:d1", sessionId: "s-1" });
	svc.showing("dialog:s-1:d1");
	settle(h, "d1");
	assert.equal(svc.pending().showing, null);
	assert.deepEqual(svc.currentTarget(), { requestId: "dialog:s-1:c1", sessionId: "s-1" });
	settle(h, "c1");
	assert.equal(svc.currentTarget(), null);
	svc.close();
});

test("a handle exit with a dialog showing ends the request and clears showing", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	svc.showing("dialog:s-1:d1");
	registry.close("s-1");
	assert.deepEqual(svc.pending().requests, []);
	assert.equal(svc.pending().showing, null);
	assert.equal(svc.currentTarget(), null);
	svc.close();
});

test("prompt on a finished request's session sends prompt {text, mode:'send'} and ends the request", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await run(h);
	assert.deepEqual(await svc.answer("finished:s-1:1", { text: "now the docs" }), { ok: true });
	assert.deepEqual(h.received, [{ type: "prompt", text: "now the docs", mode: "send" }]);
	assert.deepEqual(svc.pending().requests, []);
	await run(h);
	await svc.prompt("s-1", "and push");
	assert.deepEqual(h.received.at(-1), { type: "prompt", text: "and push", mode: "send" });
	assert.deepEqual(svc.pending().requests, []);
	svc.close();
});

test("setModel sends set_model to the session", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await svc.setModel("s-1", "anthropic", "claude-x");
	assert.deepEqual(h.received, [{ type: "set_model", provider: "anthropic", modelId: "claude-x" }]);
	svc.close();
});

test("health counts running and pending rpc sessions", async () => {
	const { registry, svc } = setup();
	const a = await session(registry);
	const b = await session(registry);
	await session(registry);
	const t = new FakeHandle("term-1", "/work/proj", null, { kind: "bridge", pid: 999 });
	registry.attachBridge(t);
	to(t, "running");
	to(a, "running");
	raise(b, push);
	assert.deepEqual(svc.health(), { running: 1, pending: 1 });
	svc.close();
});

test("close() releases waiters and stops listening", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	const c0 = svc.pending().cursor;
	const w = svc.wait(c0, 10_000);
	svc.close();
	const p = await w;
	assert.equal(p.cursor, c0);
	assert.equal(svc.waiterCount(), 0);
	raise(h, push);
	await tick();
	assert.equal(svc.pending().cursor, c0);
});

test("Viewers.onChange fires only when the count crosses zero", () => {
	const v = new Viewers();
	const seen: boolean[] = [];
	const off = v.onChange((w) => seen.push(w));
	const a = v.add();
	const b = v.add();
	a();
	a();
	b();
	off();
	v.add();
	assert.deepEqual(seen, [true, false]);
});

test("opening or closing an app wakes waiters", async () => {
	const { svc, viewers } = setup();
	const c0 = svc.pending().cursor;
	const w = svc.wait(c0, 2000);
	const leave = viewers.add();
	assert.ok((await w).cursor > c0);
	const w2 = svc.wait(svc.pending().cursor, 2000);
	leave();
	assert.ok((await w2).cursor > c0 + 1);
	svc.close();
});
