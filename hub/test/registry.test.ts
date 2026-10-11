import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ListMessage } from "../../shared/src/protocol.ts";
import { HttpError } from "../src/errors.ts";
import { Registry, type RegistryOptions } from "../src/registry.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup(opts: Partial<RegistryOptions> = {}) {
	const files: Record<string, { cwd: string; file: string }> = {
		"disk-1": { cwd: "/w", file: "/s/disk-1.jsonl" },
		"disk-2": { cwd: "/w", file: "/s/disk-2.jsonl" },
	};
	const started: FakeHandle[] = [];
	let n = 0;
	let clock = 0;
	const changes: ListMessage[] = [];
	const registry = new Registry({
		factory: {
			async startRpc(o) {
				await sleep(5);
				const id = o.sessionFile ? o.sessionFile.replace(/^.*\/|\.jsonl$/g, "") : `new-${++n}`;
				const h = new FakeHandle(id, o.cwd, o.sessionFile ?? null);
				started.push(h);
				return h;
			},
		},
		lookup: { find: async (id) => files[id] ?? null },
		maxHeadless: 6,
		idleMs: 1000,
		now: () => clock,
		...opts,
	});
	registry.onChange((m) => changes.push(m));
	return { registry, started, changes, setClock: (t: number) => (clock = t) };
}

test("concurrent ensure() starts one process per session", async () => {
	const { registry, started } = setup();
	const [a, b] = await Promise.all([registry.ensure("disk-1"), registry.ensure("disk-1")]);
	assert.equal(a, b);
	assert.equal(started.length, 1);
	assert.deepEqual(registry.info("disk-1"), { live: true, handleKind: "rpc", state: "idle" });
	assert.equal(await registry.ensure("disk-1"), a);
});

test("ensure() of an unknown session is a 404", async () => {
	const { registry } = setup();
	await assert.rejects(registry.ensure("nope"), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test("create() registers the new session and announces it", async () => {
	const { registry, changes } = setup();
	const h = await registry.create("/w");
	assert.equal(registry.get(h.sessionId), h);
	assert.ok(changes.some((m) => m.type === "session_state" && m.sessionId === h.sessionId && m.live));
});

test("at the cap, the least recently used idle session is closed; if none is idle, 503", async () => {
	const { registry, started } = setup({ maxHeadless: 2 });
	await registry.ensure("disk-1");
	await registry.ensure("disk-2");
	started[0].lastActive = 1;
	started[1].lastActive = 2;
	await registry.create("/w");
	assert.equal(started[0].closed, true);
	assert.equal(started[1].closed, false);
	assert.equal(registry.get("disk-1"), undefined);
	for (const h of started) h.busy = true;
	await assert.rejects(registry.create("/w"), (e: unknown) => e instanceof HttpError && e.status === 503);
});

test("reap() closes only idle, unwatched sessions past the idle timeout", async () => {
	const { registry, started, setClock } = setup();
	const [idle, busy, watched] = await Promise.all([registry.ensure("disk-1"), registry.ensure("disk-2"), registry.create("/w")]);
	for (const h of started) h.lastActive = 0;
	(busy as FakeHandle).busy = true;
	const unsubscribe = watched.subscribe(() => {});
	setClock(500);
	registry.reap();
	assert.equal((idle as FakeHandle).closed, false);
	setClock(2000);
	registry.reap();
	assert.equal((idle as FakeHandle).closed, true);
	assert.equal((busy as FakeHandle).closed, false);
	assert.equal((watched as FakeHandle).closed, false);
	unsubscribe();
});

test("a session change inside a handle re-keys it", async () => {
	const { registry, changes } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.sessionId = "forked";
	h.fire({ type: "session_changed", from: "disk-1", to: "forked" });
	assert.equal(registry.get("forked"), h);
	assert.equal(registry.get("disk-1"), undefined);
	assert.ok(changes.some((m) => m.type === "session_list_changed"));
});

test("an unexpected exit marks the session as errored until it is started again", async () => {
	const { registry } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.fire({ type: "exit", code: 1, stderr: "extension crashed", closedByHub: false });
	assert.deepEqual(registry.info("disk-1"), { live: false, handleKind: null, state: "error" });
	assert.equal(registry.lastError("disk-1"), "extension crashed");
	await registry.ensure("disk-1");
	assert.equal(registry.info("disk-1").state, "idle");
	assert.equal(registry.lastError("disk-1"), undefined);
});

test("state changes from a handle are announced", async () => {
	const { registry, changes } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.state = "needs_you";
	h.fire({ type: "state_changed" });
	assert.deepEqual(changes.at(-1), { type: "session_state", sessionId: "disk-1", live: true, handleKind: "rpc", state: "needs_you" });
});

test("close() and closeAll() stop headless sessions", async () => {
	const { registry, started } = setup();
	await registry.ensure("disk-1");
	await registry.ensure("disk-2");
	registry.close("disk-1");
	assert.equal(started[0].closed, true);
	registry.closeAll();
	assert.equal(started[1].closed, true);
	assert.deepEqual(registry.all(), []);
});

test("concurrent starts of different sessions never exceed the cap", async () => {
	const { registry, started } = setup({ maxHeadless: 2 });
	const results = await Promise.allSettled([registry.ensure("disk-1"), registry.ensure("disk-2"), registry.create("/w"), registry.create("/w")]);
	const ok = results.filter((r) => r.status === "fulfilled");
	const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
	assert.equal(ok.length, 2);
	assert.ok(rejected.every((r) => r.reason instanceof HttpError && r.reason.status === 503));
	assert.equal(started.length, 2);
	assert.equal(registry.all().length, 2);
});

test("a forgotten handle's late events no longer affect the registry", async () => {
	const { registry, changes } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.deferExit = true;
	registry.close("disk-1");
	const before = changes.length;
	h.sessionId = "late";
	h.fire({ type: "session_changed", from: "disk-1", to: "late" });
	h.fire({ type: "state_changed" });
	assert.equal(registry.get("late"), undefined);
	assert.equal(changes.length, before);
});

test("close() drops the handle immediately, before the process has exited", async () => {
	const { registry, started } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	h.deferExit = true;
	registry.close("disk-1");
	assert.equal(h.closed, true);
	assert.equal(registry.get("disk-1"), undefined);
	const again = await registry.ensure("disk-1");
	assert.notEqual(again, h);
	assert.equal(started.length, 2);
	h.fireExit();
	assert.equal(registry.get("disk-1"), again);
});
