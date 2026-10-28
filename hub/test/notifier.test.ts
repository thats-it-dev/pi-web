import assert from "node:assert/strict";
import { test } from "node:test";
import type { Dialog, PushPayload, Snapshot, WatchQuery } from "../../shared/src/protocol.ts";
import { Notifier, shortTitle } from "../src/notifier.ts";
import type { TurnOutcome } from "../src/turns.ts";
import { dialogQueryId } from "../src/watch.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup(o: { enabled?: boolean; pushOk?: boolean; pushThrows?: boolean; viewing?: (id: string) => boolean; isPending?: (id: string) => boolean } = {}) {
	const pushed: PushPayload[] = [];
	const delivered: string[] = [];
	const logs: string[] = [];
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
	});
	return { n, pushed, delivered, logs };
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

test("shortTitle joins project and event, cutting the project to fit 24 characters", () => {
	assert.equal(shortTitle("pi-web", "approve?"), "pi-web · approve?");
	const long = shortTitle("ring-profile-experiments-2026", "done");
	assert.ok(long.length <= 24, long);
	assert.ok(long.endsWith(" · done"), long);
	assert.ok(long.includes("…"), long);
	assert.equal(shortTitle("", "error"), "pi · error");
});

test("finished with a TL;DR: the agent's title and summary", async () => {
	const t = setup();
	await t.n.turn(finished("Fixed the upload limit.\n\nTL;DR [413 fixed]: Notes 413 fixed."), snap());
	assert.deepEqual(t.pushed, [{ sessionId: "s-1", title: "413 fixed", kind: "finished", body: "Notes 413 fixed." }]);
});

test("finished without a TL;DR: '<project> · done' and the clipped reply", async () => {
	const t = setup();
	await t.n.turn(finished("y".repeat(300)), snap("s-1", "/work/proj"));
	assert.equal(t.pushed.length, 1);
	assert.equal(t.pushed[0].title, "proj · done");
	assert.equal(t.pushed[0].kind, "finished");
	assert.equal(t.pushed[0].body, `${"y".repeat(159)}…`);
});

test("a TL;DR title over 24 characters is cut to 24", async () => {
	const t = setup();
	await t.n.turn(finished(`TL;DR [${"t".repeat(40)}]: short.`), snap());
	assert.ok(t.pushed[0].title.length <= 24);
	assert.ok(t.pushed[0].title.startsWith("tttt"));
});

test("dialog: confirm says approve?, select says question; body is the dialog message", async () => {
	const t = setup();
	await t.n.dialog("s-1", confirm, snap("s-1", "/work/x", [confirm]));
	await t.n.dialog("s-1", select, snap("s-1", "/work/x", [confirm, select]));
	assert.deepEqual(t.pushed, [
		{ sessionId: "s-1", title: "x · approve?", kind: "needs_you", body: "Run tests?\nnpm test" },
		{ sessionId: "s-1", title: "x · question", kind: "needs_you", body: "Which branch?" },
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
	assert.deepEqual(t.pushed.map((p) => p.title), ["y · question", "x · approve?"]);
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

test("error: '<project> · error' with the error text", async () => {
	const t = setup();
	await t.n.turn({ sessionId: "s-1", kind: "error", messageIndex: 1, text: "model unreachable" }, snap());
	assert.deepEqual(t.pushed, [{ sessionId: "s-1", title: "x · error", kind: "error", body: "model unreachable" }]);
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
	assert.deepEqual(t.pushed, [{ sessionId: "", title: "ring · question", kind: "query", body: "How did you sleep?" }]);
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
		{ sessionId: "s-1", title: "Didn't catch that", kind: "query", body: "pi · fix: yes, no" },
		{ sessionId: "s-1", title: "Answered: yes", kind: "query", body: "pi · fix" },
	]);
	assert.ok(t.pushed[2].title.length <= 24);
	assert.ok(t.pushed[2].title.startsWith("Answered: a very"));
});

test("a throwing push never throws out", async () => {
	const t = setup({ pushThrows: true });
	await t.n.turn(finished("done"), snap());
	await t.n.query(ringQuery);
	await t.n.ringAlert({ kind: "miss", query: piQuery });
	assert.ok(t.logs.length >= 3);
	assert.deepEqual(t.delivered, []);
});
