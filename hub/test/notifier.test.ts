import assert from "node:assert/strict";
import { test } from "node:test";
import type { PushPayload, WatchQuery } from "../../shared/src/protocol.ts";
import { Notifier } from "../src/notifier.ts";

const APP = "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b";

function setup(o: { mode?: "auto" | "notification" | "push" | "off"; phone?: string | null; appOpen?: boolean; sendOk?: boolean; pushOk?: boolean; sendThrows?: boolean; pushThrows?: boolean } = {}) {
	const sent: [string, Uint8Array][] = [];
	const pushed: PushPayload[] = [];
	const delivered: string[] = [];
	const logs: string[] = [];
	const n = new Notifier({
		mode: o.mode ?? "auto",
		appUuid: APP,
		phone: () => (o.phone === undefined ? "100.64.0.9" : o.phone),
		appOpen: () => o.appOpen ?? false,
		send: async (h, f) => {
			sent.push([h, f]);
			if (o.sendThrows) throw new Error("boom");
			return o.sendOk ?? true;
		},
		push: async (p) => {
			pushed.push(p);
			if (o.pushThrows) throw new Error("push boom");
			return o.pushOk ?? true;
		},
		markDelivered: (id) => delivered.push(id),
		log: (m) => logs.push(m),
	});
	return { n, sent, pushed, delivered, logs };
}

const piQuery: WatchQuery = { id: "dialog:s-1:d1", source: "pi", sessionId: "s-1", label: "pi · fix", text: "Run tests?", options: ["yes", "no"], createdAt: 1 };
const ringQuery: WatchQuery = { id: "rp:1", source: "ring-profile", sessionId: null, label: "ring · follow-up", text: "Secret question text", options: [], createdAt: 1 };
const alert: PushPayload = { sessionId: "s-1", kind: "finished", title: "fix", body: "All done" };

test("app open → no alert, query is delivered by showing only", async () => {
	const t = setup({ appOpen: true });
	await t.n.query(piQuery);
	await t.n.turnPush(alert);
	assert.equal(t.sent.length, 0);
	assert.equal(t.pushed.length, 0);
	assert.deepEqual(t.delivered, []);
});

test("app closed, mode notification → one frame sent to phone and markDelivered called", async () => {
	const t = setup({ mode: "notification" });
	await t.n.query(piQuery);
	assert.equal(t.sent.length, 1);
	assert.equal(t.sent[0][0], "100.64.0.9");
	assert.equal(t.sent[0][1][0], 0x01);
	assert.equal(t.pushed.length, 0);
	assert.deepEqual(t.delivered, [piQuery.id]);
});

test("notification mode, phone unreachable → no push, not delivered", async () => {
	const t = setup({ mode: "notification", sendOk: false });
	await t.n.query(piQuery);
	assert.equal(t.pushed.length, 0);
	assert.deepEqual(t.delivered, []);
});

test("auto, phone unreachable → one Web Push with kind query, delivered when push returns true", async () => {
	for (const phone of [null, "100.64.0.9"]) {
		const t = setup({ phone, sendOk: false });
		await t.n.query(piQuery);
		assert.equal(t.pushed.length, 1);
		assert.deepEqual(t.pushed[0], { sessionId: "s-1", title: "pi · fix", kind: "query", body: "Run tests?" });
		assert.deepEqual(t.delivered, [piQuery.id]);
	}
});

test("auto, ring-profile query → push payload has no query text", async () => {
	const t = setup({ phone: null });
	await t.n.query(ringQuery);
	assert.deepEqual(t.pushed, [{ sessionId: "", title: "ring · follow-up", kind: "query", body: "Question waiting" }]);
	assert.ok(!JSON.stringify(t.pushed).includes("Secret"));
});

test("auto, phone unreachable and push fails → no throw, not delivered, no retry", async () => {
	for (const pushThrows of [false, true]) {
		const t = setup({ phone: null, pushOk: false, pushThrows });
		await t.n.query(piQuery);
		assert.equal(t.pushed.length, 1);
		assert.deepEqual(t.delivered, []);
	}
});

test("a throwing send or push never throws out", async () => {
	const t = setup({ sendThrows: true, pushThrows: true });
	await t.n.query(piQuery);
	await t.n.turnPush(alert);
	assert.ok(t.logs.length > 0);
	const p = setup({ mode: "push", pushThrows: true });
	await p.n.query(ringQuery);
});

test("mode push → push only, no frame", async () => {
	const t = setup({ mode: "push" });
	await t.n.query(piQuery);
	assert.equal(t.sent.length, 0);
	assert.equal(t.pushed.length, 1);
	assert.deepEqual(t.delivered, [piQuery.id]);
});

test("finished turn, phone reachable → one frame, zero pushes", async () => {
	const t = setup();
	await t.n.turnPush(alert);
	assert.equal(t.sent.length, 1);
	assert.equal(t.pushed.length, 0);
});

test("finished turn, phone unreachable → one push with the reply excerpt body", async () => {
	for (const o of [{ phone: null }, { sendOk: false }, { mode: "push" as const }]) {
		const t = setup(o);
		await t.n.turnPush(alert);
		assert.deepEqual(t.pushed, [alert]);
	}
	const n = setup({ mode: "notification", phone: null });
	await n.n.turnPush(alert);
	assert.equal(n.pushed.length, 0);
});

test("turn with the watch app open → nothing; needs_you is the query path's job", async () => {
	const t = setup({ appOpen: true });
	await t.n.turnPush(alert);
	const u = setup();
	await u.n.turnPush({ sessionId: "s-1", title: "fix", kind: "needs_you", body: "Allow?" });
	for (const x of [t, u]) assert.equal(x.sent.length + x.pushed.length, 0);
});

test("pi dialog, app closed: phone unreachable → exactly one push; reachable → one frame, no push", async () => {
	const a = setup({ phone: null });
	await a.n.query(piQuery);
	assert.equal(a.pushed.length, 1);
	const b = setup();
	await b.n.query(piQuery);
	assert.equal(b.sent.length, 1);
	assert.equal(b.pushed.length, 0);
});

test("the frame title is clipped to 64 characters", async () => {
	const t = setup();
	await t.n.query({ ...piQuery, label: "L".repeat(100) });
	assert.ok(!Buffer.from(t.sent[0][1]).includes("L".repeat(65)));
	assert.ok(Buffer.from(t.sent[0][1]).includes(`${"L".repeat(63)}…`));
});

test("mode off → nothing sent", async () => {
	const t = setup({ mode: "off" });
	await t.n.query(piQuery);
	await t.n.turnPush(alert);
	assert.equal(t.sent.length, 0);
	assert.equal(t.pushed.length, 0);
});

test("turn alert uses a session launch code (high bit set); queries do not", async () => {
	const t = setup();
	await t.n.query(piQuery);
	await t.n.turnPush(alert);
	assert.equal(t.sent.length, 2);
	const codes = [...t.n.launchCodes()];
	const q = codes.find(([, v]) => "queryId" in v)!;
	const s = codes.find(([, v]) => "sessionId" in v)!;
	assert.ok(q[0] < 0x80000000);
	assert.ok(s[0] >= 0x80000000 && s[0] <= 0xffffffff);
	assert.deepEqual(t.n.launchTarget(q[0]), { queryId: piQuery.id });
	assert.deepEqual(t.n.launchTarget(s[0]), { sessionId: "s-1" });
	assert.equal(t.n.launchTarget(12345), null);
});

test("launch codes start at a random point, so a restarted hub doesn't reuse an old notification's code", async () => {
	const a = setup();
	const b = setup();
	await a.n.query(piQuery);
	await b.n.query(piQuery);
	const [ca] = [...a.n.launchCodes()][0]!;
	const [cb] = [...b.n.launchCodes()][0]!;
	assert.notEqual(ca, cb);
	assert.ok(ca > 0 && cb > 0);
});

test("the launch table keeps the last 32 entries", async () => {
	const t = setup();
	for (let i = 0; i < 40; i++) await t.n.query({ ...piQuery, id: `q${i}` });
	assert.equal([...t.n.launchCodes()].length, 32);
	assert.deepEqual([...t.n.launchCodes()].at(-1)![1], { queryId: "q39" });
});

test("ring miss: a frame titled \"Didn't catch that\" naming the dialog and its options, launching the query", async () => {
	const t = setup({ mode: "notification" });
	await t.n.ringAlert({ kind: "miss", query: piQuery });
	assert.equal(t.sent.length, 1);
	const text = Buffer.from(t.sent[0][1]).toString("utf8");
	assert.ok(text.includes("Didn't catch that"));
	assert.ok(text.includes("pi · fix: yes, no"));
	const code = [...t.n.launchCodes()].find(([, v]) => "queryId" in v && v.queryId === piQuery.id);
	assert.ok(code && code[0] < 0x80000000);
	assert.equal(t.pushed.length, 0);
	assert.deepEqual(t.delivered, []);
});

test("ring miss: auto with the phone unreachable → one push; off or app open → nothing", async () => {
	const t = setup({ phone: null });
	await t.n.ringAlert({ kind: "miss", query: piQuery });
	assert.deepEqual(t.pushed, [{ sessionId: "s-1", title: "Didn't catch that", kind: "query", body: "pi · fix: yes, no" }]);
	for (const o of [{ mode: "off" as const }, { appOpen: true }]) {
		const u = setup(o);
		await u.n.ringAlert({ kind: "miss", query: piQuery });
		await u.n.ringAlert({ kind: "answered", query: piQuery, option: "yes" });
		assert.equal(u.sent.length + u.pushed.length, 0);
	}
});

test("ring answered: one receipt naming the option and the dialog, launching its session", async () => {
	const t = setup({ mode: "notification" });
	await t.n.ringAlert({ kind: "answered", query: piQuery, option: "yes" });
	assert.equal(t.sent.length, 1);
	const text = Buffer.from(t.sent[0][1]).toString("utf8");
	assert.ok(text.includes("Answered: yes"));
	assert.ok(text.includes("pi · fix"));
	assert.ok([...t.n.launchCodes()].some(([c, v]) => "sessionId" in v && v.sessionId === "s-1" && c >= 0x80000000));
	const u = setup({ phone: null });
	await u.n.ringAlert({ kind: "answered", query: piQuery, option: "yes" });
	assert.deepEqual(u.pushed, [{ sessionId: "s-1", title: "Answered: yes", kind: "query", body: "pi · fix" }]);
});
