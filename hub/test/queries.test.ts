import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryOutcome } from "../../shared/src/protocol.ts";
import { QueryStore } from "../src/queries.ts";

// Timers run only when the test says so.
function setup() {
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let n = 0;
	const changes = { n: 0 };
	const store = new QueryStore({
		now: () => 5000,
		setTimer: ((fn: () => void, ms: number) => {
			timers.set(++n, { fn, ms });
			return n;
		}) as unknown as typeof setTimeout,
		clearTimer: ((id: number) => {
			timers.delete(id);
		}) as unknown as typeof clearTimeout,
		onChange: () => changes.n++,
	});
	const outcomes: QueryOutcome[] = [];
	const input = (label = "ring") => ({ source: "ring-profile" as const, label, text: "ok?", options: ["yes", "no"], timeoutMs: 60_000, onOutcome: (o: QueryOutcome) => outcomes.push(o) });
	return { store, timers, changes, outcomes, input };
}

test("raise assigns rp:1, rp:2 and lists them oldest first", () => {
	const { store, input, changes } = setup();
	const a = store.raise(input("a"));
	const b = store.raise(input("b"));
	assert.deepEqual([a.id, b.id], ["rp:1", "rp:2"]);
	assert.deepEqual(store.external().map((q) => q.id), ["rp:1", "rp:2"]);
	assert.deepEqual(a, { id: "rp:1", source: "ring-profile", sessionId: null, label: "a", text: "ok?", options: ["yes", "no"], createdAt: 5000 });
	assert.equal(changes.n, 2);
});

test("resolve fires onOutcome exactly once and removes the query", () => {
	const { store, input, outcomes, timers } = setup();
	const q = store.raise(input());
	assert.equal(store.resolve(q.id, { kind: "option", option: "yes" }), true);
	assert.equal(store.resolve(q.id, { kind: "skip" }), false);
	assert.deepEqual(outcomes, [{ kind: "option", option: "yes" }]);
	assert.deepEqual(store.external(), []);
	assert.equal(timers.size, 0);
});

test("timeout resolves expired-undelivered when never delivered", () => {
	const { store, input, outcomes, timers } = setup();
	store.raise(input());
	assert.equal([...timers.values()][0]!.ms, 60_000);
	[...timers.values()][0]!.fn();
	assert.deepEqual(outcomes, [{ kind: "expired-undelivered" }]);
	assert.deepEqual(store.external(), []);
});

test("timeout resolves expired-delivered after markDelivered", () => {
	const { store, input, outcomes, timers } = setup();
	const q = store.raise(input());
	assert.equal(store.delivered(q.id), false);
	store.markDelivered(q.id);
	assert.equal(store.delivered(q.id), true);
	[...timers.values()][0]!.fn();
	assert.deepEqual(outcomes, [{ kind: "expired-delivered" }]);
});

test("close clears timers without outcomes", () => {
	const { store, input, outcomes, timers } = setup();
	store.raise(input());
	store.raise(input());
	store.close();
	assert.equal(timers.size, 0);
	assert.deepEqual(outcomes, []);
	assert.deepEqual(store.external(), []);
});
