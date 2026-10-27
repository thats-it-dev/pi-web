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
const alert = { sessionId: "s-1", kind: "finished" as const, title: "fix", text: "All done" };

test("app open → no alert, query is delivered by showing only", async () => {
	const t = setup({ appOpen: true });
	await t.n.query(piQuery);
	await t.n.turn(alert);
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
	await t.n.turn(alert);
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

test("turn alert with phone unreachable → no push (watchPush already sent one)", async () => {
	for (const o of [{ phone: null }, { sendOk: false }, { mode: "push" as const }]) {
		const t = setup(o);
		await t.n.turn(alert);
		assert.equal(t.pushed.length, 0);
	}
});

test("mode off → nothing sent", async () => {
	const t = setup({ mode: "off" });
	await t.n.query(piQuery);
	await t.n.turn(alert);
	assert.equal(t.sent.length, 0);
	assert.equal(t.pushed.length, 0);
});

test("turn alert uses a session launch code (high bit set); queries do not", async () => {
	const t = setup();
	await t.n.query(piQuery);
	await t.n.turn(alert);
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

test("the launch table keeps the last 32 entries", async () => {
	const t = setup();
	for (let i = 0; i < 40; i++) await t.n.query({ ...piQuery, id: `q${i}` });
	assert.equal([...t.n.launchCodes()].length, 32);
	assert.deepEqual([...t.n.launchCodes()].at(-1)![1], { queryId: "q39" });
});
