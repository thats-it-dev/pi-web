import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { AgentMessage, Dialog, LiveState, ModelInfo, PiEvent, SessionStats, WatchStreamFrame } from "../../shared/src/protocol.ts";
import { LastModelStore } from "../src/last-model.ts";
import { Viewers } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { SessionIndex } from "../src/sessions.ts";
import { WatchService } from "../src/watch.ts";
import { closedSession, shortModel, turnsFrom } from "../src/watch-sessions.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "watch-test-"));
	const index = new SessionIndex(dir);
	let n = 0;
	const registry = new Registry({
		// A reopened session keeps its id (its file is <id>.jsonl here); a new one gets s-<n>.
		factory: { startRpc: async (o) => new FakeHandle(o.sessionFile ? basename(o.sessionFile, ".jsonl") : `s-${++n}`, o.cwd, o.sessionFile ?? null) },
		lookup: index,
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const clock = { t: 1000 };
	const viewers = new Viewers();
	const svc = new WatchService({ registry, index, viewers, home: dir, now: () => clock.t });
	return { registry, viewers, svc, clock, dir };
}

// A closed session file in the index: header, then one user/assistant exchange per prompt.
function writeSession(dir: string, id: string, o: { mtime: number; model?: string; prompts?: string[]; name?: string }): void {
	const sub = join(dir, "--work-proj--");
	mkdirSync(sub, { recursive: true });
	const [provider, modelId] = (o.model ?? "ollama/qwen3:32b").split("/");
	const lines: object[] = [{ type: "session", id, cwd: "/work/proj", timestamp: new Date(0).toISOString() }];
	if (o.name) lines.push({ type: "session_info", name: o.name });
	let parent: string | null = null;
	let k = 0;
	for (const text of o.prompts ?? ["hello"]) {
		const u = `e${++k}`;
		lines.push({ type: "message", id: u, parentId: parent, message: user(text) });
		const a = `e${++k}`;
		lines.push({ type: "message", id: a, parentId: u, message: { role: "assistant", provider, model: modelId, content: [{ type: "text", text: `re: ${text}` }], usage: { input: 50_000, output: 2_000, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } });
		parent = a;
	}
	const file = join(sub, `${id}.jsonl`);
	writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	utimesSync(file, o.mtime / 1000, o.mtime / 1000);
}

const stats = (tokens: number, contextWindow: number, percent: number): SessionStats => ({
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 2,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	cost: 0,
	contextUsage: { tokens, contextWindow, percent },
});

const model = (provider: string, id: string, name = id): ModelInfo => ({ id, name, provider, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_000 } as ModelInfo);

const ev = (e: PiEvent) => ({ type: "event" as const, event: e });

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

test("pi dialog appears as a query with source pi and label \"pi · <title>\"", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	assert.deepEqual(svc.pending().queries, [
		{
			id: "dialog:s-1:d1",
			source: "pi",
			sessionId: "s-1",
			label: "pi · proj",
			text: "Allow git push?\norigin feat/x",
			options: ["allow", "allow always", "deny"],
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
	const reqs = svc.pending().queries;
	assert.deepEqual(
		reqs.map((r) => [r.id, r.options, r.text, r.createdAt]),
		[
			["dialog:s-1:c1", ["yes", "no"], "Proceed?", 1000],
			["dialog:s-1:i1", [], "Name?", 2000],
			["dialog:s-1:e1", [], "Edit", 3000],
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
		svc.pending().queries.map((r) => [r.id, r.createdAt]),
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
	assert.deepEqual(svc.pending().queries, []);
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
	assert.equal(svc.pending().queries.length, 1);
	settle(h, "d1");
	assert.deepEqual(svc.pending().queries, []);
	assert.deepEqual(await svc.answer("dialog:s-1:d1", { option: "allow" }), { ok: false, reason: "gone" });
	assert.deepEqual(await svc.answer("nonsense", { text: "hi" }), { ok: false, reason: "gone" });
	assert.deepEqual(h.received, []);
	svc.close();
});

const statusOf = (svc: WatchService, id = "s-1") => svc.pending().sessions.find((x) => x.id === id)?.status;
const err = (): AgentMessage => ({ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "error", errorMessage: "overloaded" }) as AgentMessage;

test("a finished turn with nobody watching is no query, and the session shows done", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await run(h);
	assert.deepEqual(svc.pending().queries, []);
	assert.equal(statusOf(svc), "done");
	svc.close();
});

test("an errored turn shows the session as error on Home until it runs again", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await run(h, err());
	assert.equal(statusOf(svc), "error");
	to(h, "running");
	assert.equal(statusOf(svc), "running");
	await run(h);
	assert.equal(statusOf(svc), "done");
	svc.close();
});

test("viewer gate: while an app is open, pi queries are held; a dialog comes back; alerts are dropped for good", async () => {
	const { registry, svc, viewers } = setup();
	const a = await session(registry);
	const b = await session(registry);
	await run(a, err());
	raise(b, push);
	assert.equal(svc.pending().queries.length, 1);
	assert.equal(statusOf(svc), "error");
	const leave = viewers.add();
	assert.deepEqual(svc.pending().queries, []);
	assert.equal(statusOf(svc), "done");
	leave();
	assert.deepEqual(
		svc.pending().queries.map((r) => r.id),
		["dialog:s-2:d1"],
	);
	svc.close();
});

test("pi queries are held while the web app is open; ring-profile queries are not", async () => {
	const { registry, svc, viewers } = setup();
	const h = await session(registry);
	raise(h, push);
	const q = svc.queries.raise({ source: "ring-profile", label: "ring", text: "ok?", options: ["yes", "no"], timeoutMs: 60_000, onOutcome: () => {} });
	const leave = viewers.add();
	assert.deepEqual(svc.pending().queries.map((r) => r.id), [q.id]);
	leave();
	assert.deepEqual(svc.pending().queries.map((r) => r.id).sort(), ["dialog:s-1:d1", q.id].sort());
	svc.close();
});

test("finished recorded while an app is open never appears", async () => {
	const { registry, svc, viewers } = setup();
	const h = await session(registry);
	const leave = viewers.add();
	await run(h);
	leave();
	assert.deepEqual(svc.pending().queries, []);
	svc.close();
});

test("skip on a pi query hides it from the watch but the dialog stays pending in the handle", async () => {
	const { registry, svc, viewers } = setup();
	const h = await session(registry);
	raise(h, push);
	svc.skip("dialog:s-1:d1");
	assert.deepEqual(svc.pending().queries, []);
	assert.equal(h.snapshot().dialogs.length, 1);
	assert.deepEqual(h.received, []);
	viewers.add()(); // an app opened and closed: the skip survives
	assert.deepEqual(svc.pending().queries, []);
	settle(h, "d1");
	raise(h, push);
	assert.deepEqual(
		svc.pending().queries.map((r) => r.id),
		["dialog:s-1:d1"],
	);
	svc.close();
});

test("answering a dialog in the web app removes the query and the next pending query is first", async () => {
	const { registry, svc, clock } = setup();
	const h = await session(registry);
	raise(h, push);
	clock.t = 2000;
	raise(h, { id: "c1", method: "confirm", title: "Proceed?" });
	assert.deepEqual(svc.pending().queries.map((r) => r.id), ["dialog:s-1:d1", "dialog:s-1:c1"]);
	svc.showing({ queryId: "dialog:s-1:d1", sessionId: "s-1" });
	settle(h, "d1"); // answered in the web app
	const p = svc.pending();
	assert.deepEqual(p.queries.map((r) => r.id), ["dialog:s-1:c1"]);
	assert.equal(p.showing, null);
	svc.close();
});

test("session status: waiting > error > running > done, waiting sessions listed first", async () => {
	const { registry, svc, clock } = setup();
	const done = await session(registry);
	const running = await session(registry);
	const err = await session(registry);
	const asked = await session(registry);
	const needs = await session(registry);
	done.lastActive = 50;
	running.lastActive = 40;
	err.lastActive = 30;
	asked.lastActive = 20;
	needs.lastActive = 10;
	to(running, "running");
	to(err, "error");
	to(needs, "needs_you"); // needs_you without a visible query still waits
	asked.dialogs = [push];
	asked.fire({ type: "state_changed" });
	clock.t = 5000;
	const status = () => Object.fromEntries(svc.pending().sessions.map((s) => [s.id, s.status]));
	assert.deepEqual(status(), { "s-1": "done", "s-2": "running", "s-3": "error", "s-4": "waiting", "s-5": "waiting" });
	assert.deepEqual(svc.pending().sessions.map((s) => s.id), ["s-4", "s-5", "s-1", "s-2", "s-3"]);
	// A session whose last turn errored while no app was open reads error even when idle.
	to(done, "running");
	await run(done, { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "error", errorMessage: "boom" });
	assert.equal(status()["s-1"], "error");
	svc.close();
});

test("showing marks an external query delivered", async () => {
	const { svc } = setup();
	const q = svc.queries.raise({ source: "ring-profile", label: "ring", text: "ok?", options: ["yes"], timeoutMs: 60_000, onOutcome: () => {} });
	assert.equal(svc.queries.delivered(q.id), false);
	svc.showing({ queryId: q.id, sessionId: null });
	assert.equal(svc.queries.delivered(q.id), true);
	assert.deepEqual(svc.onScreen(), { queryId: q.id, sessionId: null });
	svc.close();
});

test("answering or skipping an external query resolves it: option, ring-answer text, skip", async () => {
	const { svc } = setup();
	const outcomes: unknown[] = [];
	const raiseOne = () => svc.queries.raise({ source: "ring-profile", label: "ring", text: "ok?", options: ["yes", "no"], timeoutMs: 60_000, onOutcome: (o) => outcomes.push(o) });
	const a = raiseOne();
	assert.deepEqual(await svc.answer(a.id, { option: "maybe" }), { ok: false, reason: "no_match", options: ["yes", "no"] });
	assert.deepEqual(await svc.answer(a.id, { option: "yes" }), { ok: true });
	assert.deepEqual(await svc.answer(a.id, { option: "yes" }), { ok: false, reason: "gone" });
	const b = raiseOne();
	assert.deepEqual(await svc.answer(b.id, { text: "hello" }), { ok: true });
	const c = raiseOne();
	svc.skip(c.id);
	assert.deepEqual(outcomes, [{ kind: "option", option: "yes" }, { kind: "ring-answer", text: "hello" }, { kind: "skip" }]);
	assert.deepEqual(svc.pending().queries, []);
	svc.close();
});

test("connected: a held long-poll counts as well as a stream subscriber", async () => {
	const { svc } = setup();
	assert.equal(svc.connected(), false);
	const ac = new AbortController();
	void svc.wait(svc.pending().cursor, 60_000, ac.signal);
	assert.equal(svc.connected(), true);
	ac.abort();
	assert.equal(svc.connected(), false);
	const off = svc.subscribe(() => {});
	assert.equal(svc.connected(), true);
	off();
	assert.equal(svc.connected(), false);
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
	assert.equal(pa.queries.length, 1);
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

test("showing is remembered and cleared when its query ends", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	svc.showing({ queryId: "dialog:s-1:d1", sessionId: "s-1" });
	assert.equal(svc.pending().showing?.queryId, "dialog:s-1:d1");
	svc.showing({ queryId: null, sessionId: null });
	assert.equal(svc.pending().showing, null);
	svc.showing({ queryId: "dialog:s-1:d1", sessionId: null });
	settle(h, "d1");
	assert.equal(svc.pending().showing, null);
	svc.close();
});

test("notice goes to stream subscribers as a notice frame", async () => {
	const { svc } = setup();
	const got: unknown[] = [];
	svc.subscribe((f) => got.push(f));
	svc.notice("hi");
	assert.deepEqual(got, [{ type: "notice", text: "hi" }]);
	svc.close();
});

test("a handle exit with a dialog showing ends the request and clears showing", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, push);
	svc.showing({ queryId: "dialog:s-1:d1", sessionId: null });
	registry.close("s-1");
	assert.deepEqual(svc.pending().queries, []);
	assert.equal(svc.pending().showing, null);
	svc.close();
});

test("prompt on an errored session sends prompt {text, mode:'send'} and ends its error", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await run(h, err());
	assert.deepEqual(await svc.answer("finished:s-1:1", { text: "now the docs" }), { ok: false, reason: "gone" });
	assert.deepEqual(await svc.prompt("s-1", "now the docs"), { ok: true });
	assert.deepEqual(h.received, [{ type: "prompt", text: "now the docs", mode: "send" }]);
	assert.equal(statusOf(svc), "done");
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

test("sessions: by updatedAt (live ones are newest here), closed ones capped at 20, with short model names and context percent", async () => {
	const { registry, svc, dir } = setup();
	for (let i = 0; i < 25; i++) writeSession(dir, `disk-${i}`, { mtime: 1_700_000_000_000 + i * 1000, prompts: [`task ${i}\nmore detail`] });
	const a = await session(registry);
	a.lastActive = 1_800_000_000_010;
	a.stats = stats(52_000, 128_000, 40.6);
	a.model = model("ollama", "qwen3:32b");
	const b = await session(registry);
	b.lastActive = 1_800_000_000_020;
	const list = await svc.sessions();
	assert.equal(list.length, 22);
	assert.deepEqual(
		list.slice(0, 2).map((s) => s.id),
		["s-2", "s-1"],
	);
	assert.deepEqual(list[1], { id: "s-1", title: "proj", state: "idle", status: "done", live: true, model: "qwen3", contextPercent: 41, contextTokens: 52_000, contextWindow: 128_000, tps: null, updatedAt: 1_800_000_000_010 });
	assert.equal(list[0]!.contextPercent, null);
	const closed = list.slice(2);
	assert.equal(closed.length, 20);
	assert.deepEqual(closed[0], { id: "disk-24", title: "task 24", state: "idle", status: "done", live: false, model: "qwen3", contextPercent: null, contextTokens: 52_000, contextWindow: null, tps: null, updatedAt: 1_700_000_024_000 });
	assert.equal(closed.at(-1)!.id, "disk-5");
	assert.ok(closed.every((s) => !s.live && s.contextPercent === null && s.contextTokens === 52_000));
	svc.close();
});

test("sessions: a live session is not listed again as closed; the long-poll carries the same list", async () => {
	const { registry, svc, dir } = setup();
	writeSession(dir, "disk-1", { mtime: 1_700_000_000_000 });
	writeSession(dir, "disk-2", { mtime: 1_700_000_001_000, name: "release prep" });
	(await registry.ensure("disk-1")).lastActive = 1_800_000_000_000;
	const list = await svc.sessions();
	assert.deepEqual(
		list.map((s) => [s.id, s.live, s.title]),
		[
			["disk-1", true, "proj"], // a fake handle starts with an empty conversation
			["disk-2", false, "release prep"],
		],
	);
	assert.deepEqual(svc.pending().sessions, list);
	svc.close();
});

test("tps is null before any reply, a number while one streams, and keeps the last reply's figure after", async () => {
	const { registry, svc, clock } = setup();
	const h = await session(registry);
	const other = await session(registry);
	await tick();
	const tps = async () => (await svc.sessions()).find((s) => s.id === "s-1")!.tps;
	assert.equal(await tps(), null);
	h.push(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } }));
	clock.t = 2000;
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) } }));
	assert.equal(await tps(), 100);
	clock.t = 3000;
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) } }));
	h.push(ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(800) }], stopReason: "stop" } }));
	clock.t = 60_000;
	assert.equal(await tps(), 100);
	assert.equal((await svc.sessions()).find((s) => s.id === "s-2")!.tps, null);

	// Streaming wakes pollers only for the session the watch shows, at most once a second.
	svc.showing({ queryId: null, sessionId: "s-1" });
	await tick();
	const c0 = svc.pending().cursor;
	other.push(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
	other.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abcd" } }));
	await tick();
	assert.equal(svc.pending().cursor, c0);
	h.push(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abcd" } }));
	await tick();
	assert.equal(svc.pending().cursor, c0 + 1);
	clock.t = 60_500;
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abcd" } }));
	await tick();
	assert.equal(svc.pending().cursor, c0 + 1);
	clock.t = 61_000;
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abcd" } }));
	await tick();
	assert.equal(svc.pending().cursor, c0 + 2);
	svc.close();
});

test("context percent falls back to the live estimate when the handle's stats have none", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await tick();
	h.push({ type: "meta", state: h.snapshot().state, stats: stats(32_000, 128_000, 25), statuses: {} } as never);
	const s = (await svc.sessions())[0]!;
	assert.equal(s.contextPercent, 25);
	svc.close();
});

test("a handle that goes away stops being observed", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await svc.sessions();
	assert.equal(h.observerCount(), 1);
	registry.close("s-1");
	assert.equal(h.observerCount(), 0);
	svc.close();
});

test("shortModel takes the part after the last slash, cut at the first colon", () => {
	assert.equal(shortModel("ollama/qwen3:32b"), "qwen3");
	assert.equal(shortModel("anthropic/claude-opus-5-5"), "claude-opus-5-5");
	assert.equal(shortModel("qwen3"), "qwen3");
	assert.equal(shortModel(null), null);
});

test("closedSession titles: name, else first prompt line, else the folder; clipped to 60", () => {
	const base = { id: "x", file: "/f", cwd: "/work/proj", name: null, firstPrompt: null, userMessages: 0, model: null, contextTokens: null, createdAt: 0, updatedAt: 0, parentSession: null };
	assert.equal(closedSession({ ...base, name: "named", firstPrompt: "p" }).title, "named");
	assert.equal(closedSession({ ...base, firstPrompt: "line one\nline two" }).title, "line one");
	assert.equal(closedSession(base).title, "proj");
	assert.equal(closedSession({ ...base, name: "n".repeat(80) }).title, `${"n".repeat(59)}…`);
});

test("turnsFrom: user → you, assistant text → agent, toolCall blocks → tool lines 'name · first arg line', toolResult messages skipped, text clipped to 240 chars", () => {
	const long = "y".repeat(300);
	const messages: AgentMessage[] = [
		{ role: "user", content: "fix it" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "On it." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "git push\n--force" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "src/a.ts" } },
				{ type: "toolCall", id: "t3", name: "grep", arguments: { pattern: "x" } },
			],
		},
		{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "t4", name: "bash", arguments: {} }] },
		{ role: "bashExecution", command: "ls", output: "a" },
		{ role: "compactionSummary", summary: "s" },
		{ role: "assistant", content: [{ type: "text", text: long }] },
	];
	assert.deepEqual(turnsFrom(messages, { t4: { name: "bash", args: { command: "npm test" }, running: false } }), [
		{ i: 0, role: "you", text: "fix it" },
		{ i: 1, role: "agent", text: "On it." },
		{ i: 2, role: "tool", text: "bash · git push" },
		{ i: 3, role: "tool", text: "read · src/a.ts" },
		{ i: 4, role: "tool", text: 'grep · {"pattern":"x"}' },
		{ i: 5, role: "tool", text: "bash · npm test" },
		{ i: 6, role: "agent", text: `${"y".repeat(239)}…` },
	]);
});

test("history pages backwards: before=undefined gives the last `limit` turns with total; before=i gives the `limit` before i", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	for (let i = 0; i < 15; i++) h.conv.messages.push(user(`q${i}`), { role: "assistant", content: [{ type: "text", text: `a${i}` }] });
	const last = await svc.history("s-1");
	assert.equal(last.total, 30);
	assert.deepEqual(
		last.turns.map((t) => [t.i, t.text]),
		Array.from({ length: 12 }, (_, k) => [18 + k, k % 2 ? `a${9 + (k >> 1)}` : `q${9 + (k >> 1)}`]),
	);
	const page = await svc.history("s-1", 18, 5);
	assert.deepEqual(
		page.turns.map((t) => t.i),
		[13, 14, 15, 16, 17],
	);
	assert.deepEqual((await svc.history("s-1", 3)).turns.map((t) => t.i), [0, 1, 2]);
	await assert.rejects(svc.history("nope"), (e: { status?: number }) => e.status === 404);
	svc.close();
});

test("history of a closed session reads the file", async () => {
	const { svc, dir } = setup();
	writeSession(dir, "disk-1", { mtime: 1_700_000_000_000, prompts: ["first", "second"] });
	assert.deepEqual(await svc.history("disk-1"), {
		total: 4,
		turns: [
			{ i: 0, role: "you", text: "first" },
			{ i: 1, role: "agent", text: "re: first" },
			{ i: 2, role: "you", text: "second" },
			{ i: 3, role: "agent", text: "re: second" },
		],
	});
	svc.close();
});

test("models lists the handle's models and marks the current one; setModel sends set_model", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	h.models = [model("ollama", "qwen3:32b", "Qwen3 32B"), model("anthropic", "claude-opus-5-5", "Claude Opus 5.5")];
	h.model = h.models[1]!;
	assert.deepEqual(await svc.models("s-1"), {
		current: { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		models: [
			{ provider: "ollama", id: "qwen3:32b", name: "Qwen3 32B" },
			{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		],
	});
	h.model = null;
	assert.equal((await svc.models("s-1")).current, null);
	await svc.setModel("s-1", "ollama", "qwen3:32b");
	assert.deepEqual(h.received.at(-1), { type: "set_model", provider: "ollama", modelId: "qwen3:32b" });
	await assert.rejects(svc.models("nope"), (e: { status?: number }) => e.status === 404);
	svc.close();
});

test("prompt to a closed session reopens it through registry.ensure", async () => {
	const { registry, svc, dir } = setup();
	writeSession(dir, "disk-1", { mtime: 1_700_000_000_000 });
	assert.deepEqual(await svc.prompt("disk-1", "carry on"), { ok: true });
	const h = registry.get("disk-1") as FakeHandle;
	assert.deepEqual(h.received, [{ type: "prompt", text: "carry on", mode: "send" }]);
	svc.close();
});

test("prompt or answer on a session nobody can find returns gone; other failures still throw", async () => {
	const { registry, svc } = setup();
	assert.deepEqual(await svc.prompt("nope", "hi"), { ok: false, reason: "gone" });
	const h = await session(registry);
	await run(h);
	registry.close("s-1");
	// The finished request outlives its handle; the session has no file, so it cannot be reopened.
	assert.deepEqual(await svc.answer("finished:s-1:1", { text: "more" }), { ok: false, reason: "gone" });
	const g = await session(registry);
	g.command = async () => ({ ok: false, error: "busy" });
	await assert.rejects(svc.prompt("s-2", "hi"), (e: { status?: number }) => e.status === 409);
	svc.close();
});

test("prompt keeps an outcome that lands while the prompt is being sent", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await run(h, err());
	assert.equal(statusOf(svc), "error");
	const send = h.command.bind(h);
	h.command = async (cmd) => {
		const res = await send(cmd);
		// A fast reply: the turn runs and errors again before the send resolves.
		await run(h, err());
		return res;
	};
	await svc.prompt("s-1", "again");
	assert.equal(statusOf(svc), "error");
	svc.close();
});

test("startRingSession rejects when the first prompt is refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "watch-test-"));
	const index = new SessionIndex(dir);
	const registry = new Registry({
		factory: {
			startRpc: async (o) => {
				const h = new FakeHandle("s-1", o.cwd, null);
				h.command = async () => ({ ok: false, error: "nope" });
				return h;
			},
		},
		lookup: index,
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const svc = new WatchService({ registry, index, viewers: new Viewers(), home: dir });
	await assert.rejects(svc.startRingSession("hi"), /nope/);
	svc.close();
});

test("startRingSession starts on the hub's default model", async () => {
	const dir = mkdtempSync(join(tmpdir(), "watch-test-"));
	const index = new SessionIndex(dir);
	const models: unknown[] = [];
	const registry = new Registry({
		factory: {
			startRpc: async (o) => {
				models.push(o.model);
				return new FakeHandle("s-1", o.cwd, null);
			},
		},
		lookup: index,
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const m = (id: string): ModelInfo => ({ id, name: id, provider: "fake", reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1 });
	const catalog = { get: async () => ({ models: [m("fake-a"), m("fake-b")], piDefault: { provider: "fake", modelId: "fake-a", thinking: null }, levels: {} }) };
	const lastModel = new LastModelStore(join(dir, "last-model.json"));
	lastModel.set({ provider: "fake", modelId: "fake-b", thinking: null });
	const svc = new WatchService({ registry, index, viewers: new Viewers(), home: dir, catalog, lastModel });
	await svc.startRingSession("hi");
	assert.deepEqual(models, [{ provider: "fake", modelId: "fake-b", thinking: null }]);
	svc.close();
});

test("wait returns at once for a cursor from the future (stale after a restart)", async () => {
	const { svc } = setup();
	const t0 = Date.now();
	const p = await svc.wait(999_999, 2000);
	assert.equal(p.cursor, 0);
	assert.ok(Date.now() - t0 < 500);
	svc.close();
});

test("dialog title+message text is clipped to 240 chars", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	raise(h, { id: "big", method: "select", title: "T", message: "m".repeat(300), options: ["allow", "deny"] });
	const msg = svc.pending().queries[0]!.text;
	assert.equal(msg.length, 240);
	assert.ok(msg.endsWith("…"));
	svc.close();
});

test("startRingSession creates ~/pebble once and prompts the new session", async () => {
	const { registry, svc, dir } = setup();
	const id = await svc.startRingSession("hello ring");
	const h = registry.get(id) as FakeHandle;
	assert.equal(h.cwd, join(dir, "pebble"));
	assert.ok(existsSync(join(dir, "pebble")));
	assert.deepEqual(h.received, [{ type: "prompt", text: "hello ring", mode: "send" }]);
	const again = await svc.startRingSession("again");
	assert.notEqual(again, id);
	svc.close();
});

test("newSession creates an empty session in ~/pebble, with no prompt, listed for the watch", async () => {
	const { registry, svc, dir } = setup();
	const id = await svc.newSession();
	const h = registry.get(id) as FakeHandle;
	assert.equal(h.cwd, join(dir, "pebble"));
	assert.ok(existsSync(join(dir, "pebble")));
	assert.deepEqual(h.received, []);
	assert.ok(svc.pending().sessions.some((s) => s.id === id));
	svc.close();
});

test("newSession starts on the same model choice as a ring session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "watch-test-"));
	const index = new SessionIndex(dir);
	const models: unknown[] = [];
	let n = 0;
	const registry = new Registry({
		factory: {
			startRpc: async (o) => {
				models.push(o.model);
				return new FakeHandle(`s-${++n}`, o.cwd, null);
			},
		},
		lookup: index,
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const m = (id: string): ModelInfo => ({ id, name: id, provider: "fake", reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1 });
	const catalog = { get: async () => ({ models: [m("fake-a"), m("fake-b")], piDefault: { provider: "fake", modelId: "fake-a", thinking: null }, levels: {} }) };
	const lastModel = new LastModelStore(join(dir, "last-model.json"));
	lastModel.set({ provider: "fake", modelId: "fake-b", thinking: null });
	const svc = new WatchService({ registry, index, viewers: new Viewers(), home: dir, catalog, lastModel });
	await svc.newSession();
	await svc.startRingSession("hi");
	assert.deepEqual(models, [{ provider: "fake", modelId: "fake-b", thinking: null }, { provider: "fake", modelId: "fake-b", thinking: null }]);
	svc.close();
});

test("subscribers get one pending frame per burst and text tails for the shown session only", async () => {
	const { registry, svc, clock } = setup();
	const h = await session(registry);
	const other = await session(registry);
	await tick();
	const frames: WatchStreamFrame[] = [];
	const off = svc.subscribe((f) => frames.push(f));
	assert.equal(svc.subscriberCount(), 1);
	svc.showing({ queryId: null, sessionId: "s-1" });
	await tick();
	assert.equal(frames.filter((f) => f.type === "pending").length, 1);
	assert.deepEqual((frames[0] as { showing: unknown }).showing, { queryId: null, sessionId: "s-1" });
	const stream = (fh: FakeHandle, text: string) => {
		fh.conv.partial = { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
		fh.conv.streaming = true;
		fh.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } }));
	};
	stream(h, "a".repeat(300));
	stream(other, "zzz");
	await tick();
	const texts = () => frames.filter((f) => f.type === "text");
	assert.deepEqual(texts(), [{ type: "text", sessionId: "s-1", text: "a".repeat(240), streaming: true }]);
	clock.t += 100;
	stream(h, "a".repeat(301)); // inside the 250 ms tick: no frame
	await tick();
	assert.equal(texts().length, 1);
	clock.t += 200;
	stream(h, "b".repeat(10));
	await tick();
	assert.equal(texts().length, 2);
	h.conv.partial = null;
	h.conv.streaming = false;
	h.push(ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
	await tick();
	assert.deepEqual(texts()[2], { type: "text", sessionId: "s-1", text: "done", streaming: false });
	off();
	assert.equal(svc.subscriberCount(), 0);
	clock.t += 1000;
	stream(h, "c");
	await tick();
	assert.equal(texts().length, 3);
	svc.close();
});

test("moving showing onto a session mid-reply sends its tail at once", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await tick();
	h.conv.partial = { role: "assistant", content: [{ type: "text", text: "half a reply" }] } as AgentMessage;
	h.conv.streaming = true;
	const frames: WatchStreamFrame[] = [];
	svc.subscribe((f) => frames.push(f));
	svc.showing({ queryId: null, sessionId: "s-1" });
	await tick();
	assert.deepEqual(frames.filter((f) => f.type === "text"), [{ type: "text", sessionId: "s-1", text: "half a reply", streaming: true }]);
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }));
	await tick();
	assert.equal(frames.filter((f) => f.type === "text").length, 1);
	svc.close();
});

test("message_end for a user or toolResult message sends no text frame", async () => {
	const { registry, svc } = setup();
	const h = await session(registry);
	await tick();
	const frames: WatchStreamFrame[] = [];
	svc.subscribe((f) => frames.push(f));
	svc.showing({ queryId: null, sessionId: "s-1" });
	await tick();
	h.push(ev({ type: "message_end", message: { role: "user", content: "hi" } }));
	h.push(ev({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } }));
	await tick();
	assert.equal(frames.filter((f) => f.type === "text").length, 0);
	svc.close();
});

test("an empty tail sends no text frame: thinking or tool-call-only partials, a tool-call-only message_end, showing mid-thought", async () => {
	const { registry, svc, clock } = setup();
	const h = await session(registry);
	await tick();
	h.conv.partial = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } as AgentMessage;
	h.conv.streaming = true;
	const frames: WatchStreamFrame[] = [];
	svc.subscribe((f) => frames.push(f));
	const texts = () => frames.filter((f) => f.type === "text");
	svc.showing({ queryId: null, sessionId: "s-1" });
	await tick();
	assert.equal(texts().length, 0, "showing mid-thought sends no empty tail");
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "m" } } as PiEvent));
	clock.t += 300;
	h.conv.partial = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } as AgentMessage;
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{" } } as PiEvent));
	await tick();
	assert.equal(texts().length, 0, "thinking and tool-call partials send nothing");
	h.conv.partial = null;
	h.conv.streaming = false;
	h.push(ev({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" } as AgentMessage }));
	await tick();
	assert.equal(texts().length, 0, "a tool-call-only message_end sends no final frame");

	// Text then a tool call: the text still goes out, streaming and final, with no throttle left over.
	const both = [{ type: "text", text: "Let me look." }, { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } }];
	h.conv.partial = { role: "assistant", content: both } as AgentMessage;
	h.conv.streaming = true;
	h.push(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." } } as PiEvent));
	await tick();
	assert.deepEqual(texts(), [{ type: "text", sessionId: "s-1", text: "Let me look.", streaming: true }]);
	h.conv.partial = null;
	h.conv.streaming = false;
	h.push(ev({ type: "message_end", message: { role: "assistant", content: both, stopReason: "toolUse" } as AgentMessage }));
	await tick();
	assert.deepEqual(texts()[1], { type: "text", sessionId: "s-1", text: "Let me look.", streaming: false });
	svc.close();
});

test("onNewQuery fires once per query: external at once, a pi dialog when no app holds it back", async () => {
	const { registry, viewers, svc } = setup();
	const seen: string[] = [];
	svc.onNewQuery((q) => seen.push(q.id));
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const leave = viewers.add();
	raise(h, push); // held while an app is open
	await tick();
	assert.deepEqual(seen, []);
	const q = svc.queries.raise({ source: "ring-profile", label: "ring", text: "t", options: [], timeoutMs: 60_000, onOutcome: () => {} });
	await tick();
	assert.deepEqual(seen, [q.id]);
	leave();
	await tick();
	assert.deepEqual(seen, [q.id, "dialog:s-1:d1"]);
	svc.queries.markDelivered(q.id); // other changes do not repeat anything
	await tick();
	assert.equal(seen.length, 2);
	settle(h, "d1");
	await tick();
	raise(h, push); // the same id again after it ended is a new question
	await tick();
	assert.equal(seen.length, 3);
	svc.close();
});

test("a throwing onNewQuery listener is logged, not thrown, and the others still run", async () => {
	const { svc } = setup();
	const seen: string[] = [];
	svc.onNewQuery(() => {
		throw new Error("boom");
	});
	svc.onNewQuery((q) => seen.push(q.id));
	const q = svc.queries.raise({ source: "ring-profile", label: "ring", text: "t", options: [], timeoutMs: 60_000, onOutcome: () => {} });
	await tick();
	assert.deepEqual(seen, [q.id]);
	svc.close();
});
