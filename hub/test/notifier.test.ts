import assert from "node:assert/strict";
import { test } from "node:test";
import type { Dialog, PushPayload, Snapshot, WatchQuery } from "../../shared/src/protocol.ts";
import { Notifier } from "../src/notifier.ts";
import type { TurnOutcome } from "../src/turns.ts";
import { dialogQueryId } from "../src/watch.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup(o: { enabled?: boolean; pushOk?: boolean; pushThrows?: boolean; viewing?: (id: string) => boolean; isPending?: (id: string) => boolean } = {}) {
	const pushed: PushPayload[] = [];
	const delivered: string[] = [];
	const logs: string[] = [];
	const timers: { fn: () => void; ms: number }[] = [];
	const n = new Notifier({
		enabled: o.enabled ?? true,
		push: async (p) => {
			pushed.push(p);
			if (o.pushThrows) throw new Error("push boom");
			return o.pushOk ?? true;
		},
		viewing: o.viewing ?? (() => false),
		markDelivered: (id) => delivered.push(id),
		isPending: o.isPending ?? (() => true),
		log: (m) => logs.push(m),
		setTimer: (fn, ms) => {
			timers.push({ fn, ms });
			return {};
		},
	});
	return { n, pushed, delivered, logs, timers };
}

function snap(sessionId = "s-1", cwd = "/work/x", dialogs: Dialog[] = []): Snapshot {
	const h = new FakeHandle(sessionId, cwd);
	h.dialogs = dialogs;
	return h.snapshot();
}

const finished = (text: string, sessionId = "s-1"): TurnOutcome => ({ sessionId, kind: "finished", messageIndex: 1, text });
const confirm: Dialog = { id: "d1", method: "confirm", title: "Run tests?", message: "npm test" };
const select: Dialog = { id: "d2", method: "select", title: "Which branch?", options: ["main", "dev"] };
const piQuery: WatchQuery = { id: "dialog:s-1:d1", source: "pi", sessionId: "s-1", label: "pi · fix", text: "Run tests?", options: ["yes", "no"], createdAt: 1 };
const ringQuery: WatchQuery = { id: "rp:1", source: "ring-profile", sessionId: null, label: "ring · follow-up", text: "How did you sleep?", options: [], createdAt: 1 };

test("finished with a TL;DR: the summary alone, no title", async () => {
	const t = setup();
	await t.n.turn(finished("Fixed the upload limit.\n\nTL;DR [413 fixed]: Notes 413 fixed."), snap());
	assert.deepEqual(t.pushed, [{ sessionId: "s-1", kind: "finished", body: "Notes 413 fixed." }]);
});

test("finished without a TL;DR: the clipped reply", async () => {
	const t = setup();
	await t.n.turn(finished("y".repeat(300)), snap("s-1", "/work/proj"));
	assert.equal(t.pushed.length, 1);
	assert.equal(t.pushed[0].kind, "finished");
	assert.equal(t.pushed[0].body, `${"y".repeat(159)}…`);
	assert.ok(!("title" in t.pushed[0]));
});

test("dialog: body is the dialog message, no title", async () => {
	const t = setup();
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	await t.n.dialog("s-1", select, snap("s-1", "/work/x", [confirm, select]));
	assert.deepEqual(t.pushed, [
		{ sessionId: "s-1", kind: "needs_you", tag: dialogQueryId("s-1", confirm), body: "Run tests?\nnpm test" },
		{ sessionId: "s-1", kind: "needs_you", tag: dialogQueryId("s-1", select), body: "Which branch?" },
	]);
});

test("a second dialog in a session already waiting is pushed and marked delivered too", async () => {
	const t = setup();
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	await t.n.dialog("s-1", select, snap("s-1", "/work/x", [confirm, select]));
	assert.equal(t.pushed.length, 2);
	assert.deepEqual(t.delivered, [dialogQueryId("s-1", confirm), dialogQueryId("s-1", select)]);
});

test("a dialog push marks the dialog delivered only when the push went out", async () => {
	const t = setup();
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	assert.deepEqual(t.delivered, [dialogQueryId("s-1", confirm)]);
	const u = setup({ pushOk: false });
	await u.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	assert.deepEqual(u.delivered, []);
});

test("a dialog raised while its session is viewed is held, then pushed when viewing ends if still pending", async () => {
	let viewed = true;
	const pending = new Set([dialogQueryId("s-1", confirm)]);
	const t = setup({ viewing: (id) => viewed && id === "s-1", isPending: (id) => pending.has(id) });
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	await t.n.dialog("s-1", select, snap("s-1", "/work/x", [confirm, select])); // answered in the app before it left
	await t.n.dialog("s-2", select, snap("s-2", "/work/y", [select])); // another session isn't held
	assert.deepEqual(t.pushed.map((p) => p.sessionId), ["s-2"]);
	viewed = false;
	await t.n.viewingEnded("s-1");
	assert.deepEqual(t.pushed.map((p) => p.body), ["Which branch?", "Run tests?\nnpm test"]);
	assert.deepEqual(t.delivered, [dialogQueryId("s-2", select), dialogQueryId("s-1", confirm)]);
	await t.n.viewingEnded("s-1"); // held ones are gone, pushed or dropped
	assert.equal(t.pushed.length, 2);
});

test("turn with needs_you sends nothing (dialogs alert through dialog())", async () => {
	const t = setup();
	await t.n.turn({ sessionId: "s-1", kind: "needs_you" }, snap("s-1", "/work/x", [confirm]));
	assert.deepEqual(t.pushed, []);
	assert.deepEqual(t.delivered, []);
});

test("error: the error text", async () => {
	const t = setup();
	await t.n.turn({ sessionId: "s-1", kind: "error", messageIndex: 1, text: "model unreachable" }, snap());
	assert.deepEqual(t.pushed, [{ sessionId: "s-1", kind: "error", body: "model unreachable" }]);
});

test("a session being viewed gets no push; another session still does", async () => {
	const t = setup({ viewing: (id) => id === "s-1" });
	await t.n.turn(finished("done", "s-1"), snap("s-1"));
	await t.n.turn(finished("done", "s-2"), snap("s-2"));
	assert.deepEqual(t.pushed.map((p) => p.sessionId), ["s-2"]);
});

test("a ring-profile query pushes its text and is marked delivered, whatever is being viewed", async () => {
	const t = setup({ viewing: () => true });
	await t.n.query(ringQuery);
	assert.deepEqual(t.pushed, [{ sessionId: "", kind: "query", tag: "rp:1", body: "How did you sleep?" }]);
	assert.deepEqual(t.delivered, ["rp:1"]);
});

test("a pi-source query sends nothing (dialogs alert through dialog())", async () => {
	const t = setup();
	await t.n.query(piQuery);
	assert.deepEqual(t.pushed, []);
	assert.deepEqual(t.delivered, []);
});

test("enabled: false sends nothing at all", async () => {
	const t = setup({ enabled: false });
	await t.n.turn(finished("done"), snap());
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	await t.n.viewingEnded("s-1");
	await t.n.query(ringQuery);
	await t.n.ringAlert({ kind: "miss", query: piQuery });
	await t.n.ringAlert({ kind: "answered", query: piQuery, option: "yes" });
	assert.deepEqual(t.pushed, []);
	assert.deepEqual(t.delivered, []);
});

test("ring miss and answered receipts", async () => {
	const t = setup();
	await t.n.ringAlert({ kind: "miss", query: piQuery });
	await t.n.ringAlert({ kind: "answered", query: piQuery, option: "yes" });
	await t.n.ringAlert({ kind: "answered", query: piQuery, option: "a very long option text indeed" });
	assert.deepEqual(t.pushed.slice(0, 2), [
		{ sessionId: "s-1", kind: "query", tag: piQuery.id, body: "Didn't catch that. pi · fix: yes, no" },
		{ sessionId: "s-1", kind: "query", tag: piQuery.id, body: "Answered yes: pi · fix" },
	]);
	assert.equal(t.pushed[2].body, "Answered a very long option text indeed: pi · fix");
});

test("a throwing push never throws out", async () => {
	const t = setup({ pushThrows: true });
	await t.n.turn(finished("done"), snap());
	await t.n.query(ringQuery);
	await t.n.ringAlert({ kind: "miss", query: piQuery });
	assert.ok(t.logs.length >= 3);
	assert.deepEqual(t.delivered, []);
});

test("a pending dialog gets one 'waiting' push after 15 minutes", async () => {
	const t = setup();
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	assert.equal(t.timers.length, 1);
	assert.equal(t.timers[0].ms, 900_000);
	t.timers[0].fn();
	await new Promise((r) => setImmediate(r));
	assert.equal(t.pushed.length, 2);
	assert.deepEqual(t.pushed[1], { sessionId: "s-1", kind: "needs_you", tag: dialogQueryId("s-1", confirm), body: "Still waiting: Run tests?\nnpm test" });
});

test("a dialog resolved before the timer sends no reminder", async () => {
	let pending = true;
	const t = setup({ isPending: () => pending });
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	pending = false;
	t.timers[0].fn();
	await new Promise((r) => setImmediate(r));
	assert.equal(t.pushed.length, 1);
});

test("a session viewed when the timer fires gets no reminder", async () => {
	let viewing = false;
	const t = setup({ viewing: () => viewing });
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	viewing = true;
	t.timers[0].fn();
	await new Promise((r) => setImmediate(r));
	assert.equal(t.pushed.length, 1);
	assert.equal(t.timers.length, 1);
});

test("the same dialog pushed again schedules no second timer", async () => {
	const t = setup();
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	assert.equal(t.timers.length, 1);
});

test("a ring-profile query gets a 'Still waiting' reminder too", async () => {
	const t = setup();
	await t.n.query(ringQuery);
	assert.equal(t.timers.length, 1);
	t.timers[0].fn();
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(t.pushed[1], { sessionId: "", kind: "query", tag: "rp:1", body: "Still waiting: How did you sleep?" });
});

test("no timer when the push did not go out", async () => {
	const t = setup({ pushOk: false });
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	await t.n.query(ringQuery);
	assert.equal(t.timers.length, 0);
});

test("a dialog, its reminder, a ring question and its receipts are tagged by query id; finished and error are not", async () => {
	const t = setup();
	await t.n.turn(finished("done"), snap());
	await t.n.turn({ sessionId: "s-1", kind: "error", messageIndex: 1, text: "boom" }, snap());
	assert.equal(t.pushed[0].tag, undefined);
	assert.equal(t.pushed[1].tag, undefined);
	const id = dialogQueryId("s-1", confirm);
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	t.timers[0].fn();
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(t.pushed.slice(2).map((p) => p.tag), [id, id]);
});

test("an empty body becomes a per-kind fallback", async () => {
	const t = setup();
	await t.n.turn(finished(""), snap());
	await t.n.turn({ sessionId: "s-1", kind: "error", messageIndex: 1, text: "  " }, snap());
	await t.n.dialog("s-1", { id: "d9", method: "confirm", title: "" }, snap("s-1", "/work/x"));
	await t.n.query({ ...ringQuery, text: "" });
	await t.n.query({ ...ringQuery, id: "rp:2", text: "", label: "" });
	assert.deepEqual(t.pushed.map((p) => p.body), ["(no text)", "The model returned an error.", "Needs you.", "ring · follow-up", "Question waiting"]);
});

function grace(t: ReturnType<typeof setup>) {
	return t.timers.filter((x) => x.ms === 5000);
}

test("viewing ends then resumes within 5 s: the held dialog is not pushed", async () => {
	let viewed = true;
	const t = setup({ viewing: () => viewed });
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	viewed = false;
	t.n.viewingChanged("s-1", false);
	assert.equal(grace(t).length, 1);
	viewed = true;
	t.n.viewingChanged("s-1", true);
	grace(t)[0].fn();
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(t.pushed, []);
});

test("viewing ends and stays ended for 5 s: the held dialog is pushed", async () => {
	let viewed = true;
	const t = setup({ viewing: () => viewed });
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	viewed = false;
	t.n.viewingChanged("s-1", false);
	assert.deepEqual(t.pushed, []);
	grace(t)[0].fn();
	await new Promise((r) => setImmediate(r));
	assert.deepEqual((t.pushed as PushPayload[]).map((p) => p.body), ["Run tests?\nnpm test"]);
});

test("false, true, false: only the last grace period flushes", async () => {
	let viewed = true;
	const t = setup({ viewing: () => viewed });
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	viewed = false;
	t.n.viewingChanged("s-1", false);
	t.n.viewingChanged("s-1", true);
	t.n.viewingChanged("s-1", false);
	const [first, second] = grace(t);
	assert.equal(grace(t).length, 2);
	first.fn(); // superseded
	await new Promise((r) => setImmediate(r));
	assert.equal(t.pushed.length, 0);
	second.fn();
	await new Promise((r) => setImmediate(r));
	assert.equal(t.pushed.length, 1);
});
