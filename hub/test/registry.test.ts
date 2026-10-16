import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ListMessage } from "../../shared/src/protocol.ts";
import { HttpError } from "../src/errors.ts";
import { BUSY_NOTICE, ELSEWHERE_NOTICE, FREE_NOTICE, Registry, type RegistryOptions } from "../src/registry.ts";
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

test("an observer does not keep an idle headless session from being reaped", async () => {
	const { registry, started, setClock } = setup();
	const h = (await registry.ensure("disk-1")) as FakeHandle;
	for (const x of started) x.lastActive = 0;
	h.observe(() => {});
	setClock(2000);
	registry.reap();
	assert.equal(h.closed, true);
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

const bridge = (id: string, pid = 900) => new FakeHandle(id, "/w", `/s/${id}.jsonl`, { kind: "bridge", pid });

test("a terminal pi on a session nobody holds is attached as a bridge", async () => {
	const { registry, changes } = setup();
	const b = bridge("disk-1");
	assert.equal(registry.attachBridge(b), "attached");
	assert.equal(registry.get("disk-1"), b);
	assert.deepEqual(registry.info("disk-1"), { live: true, handleKind: "bridge", state: "idle" });
	assert.ok(changes.some((m) => m.type === "session_state" && m.sessionId === "disk-1" && m.handleKind === "bridge"));
});

test("an idle headless pi gives way to the terminal", async () => {
	const { registry, started } = setup();
	await registry.ensure("disk-1");
	const b = bridge("disk-1");
	assert.equal(registry.attachBridge(b), "attached");
	assert.equal(started[0].closed, true);
	assert.equal(registry.get("disk-1"), b);
	assert.deepEqual(b.notices, []);
});

// A waiting terminal loaded the session file before the holder's latest turns, and pi never
// re-reads it. So a waiter is never promoted: it is told the session is free, and its /resume
// (a fresh hello from the same terminal) claims the session like any terminal would.
test("a busy headless pi keeps the session; once it settles the terminal is told it is free, and its /resume takes over", async () => {
	const { registry, started } = setup();
	const rpc = (await registry.ensure("disk-1")) as FakeHandle;
	rpc.busy = true;
	const b = bridge("disk-1");
	assert.equal(registry.attachBridge(b), "waiting");
	assert.deepEqual(b.notices, [BUSY_NOTICE]);
	assert.equal(registry.get("disk-1"), rpc);
	rpc.state = "running";
	rpc.fire({ type: "state_changed" }); // still busy: nothing changes
	assert.deepEqual(b.notices, [BUSY_NOTICE]);
	rpc.busy = false;
	rpc.state = "idle";
	rpc.fire({ type: "state_changed" });
	assert.deepEqual(b.notices, [BUSY_NOTICE, FREE_NOTICE]);
	assert.equal(started[0].closed, false);
	assert.equal(registry.get("disk-1"), rpc); // the settled headless pi still holds it
	rpc.fire({ type: "state_changed" });
	assert.equal(b.notices.length, 2); // told once
	assert.equal(registry.attachBridge(b), "attached"); // the terminal's /resume: an idle headless pi gives way
	assert.equal(started[0].closed, true);
	assert.equal(registry.get("disk-1"), b);
});

test("a waiting terminal is told when a busy headless pi exits", async () => {
	const { registry } = setup();
	const rpc = (await registry.ensure("disk-1")) as FakeHandle;
	rpc.busy = true;
	const b = bridge("disk-1");
	registry.attachBridge(b);
	rpc.fire({ type: "exit", code: 1, stderr: "boom", closedByHub: false });
	assert.deepEqual(b.notices, [BUSY_NOTICE, FREE_NOTICE]);
	assert.equal(registry.get("disk-1"), undefined);
});

test("a second terminal on the same session waits until the first one leaves, then is told to /resume", async () => {
	const { registry } = setup();
	const first = bridge("disk-1", 901);
	const second = bridge("disk-1", 902);
	registry.attachBridge(first);
	assert.equal(registry.attachBridge(second), "waiting");
	assert.deepEqual(second.notices, [ELSEWHERE_NOTICE]);
	first.leave();
	assert.deepEqual(second.notices, [ELSEWHERE_NOTICE, FREE_NOTICE]);
	assert.equal(registry.get("disk-1"), undefined);
	assert.equal(registry.attachBridge(second), "attached");
	assert.equal(registry.get("disk-1"), second);
});

test("a waiting terminal is told when the terminal holding the session moves to another one", async () => {
	const { registry } = setup();
	const first = bridge("disk-1", 901);
	const second = bridge("disk-1", 902);
	registry.attachBridge(first);
	registry.attachBridge(second);
	first.sessionId = "disk-2";
	first.fire({ type: "session_changed", from: "disk-1", to: "disk-2" });
	assert.deepEqual(second.notices, [ELSEWHERE_NOTICE, FREE_NOTICE]);
	assert.equal(registry.get("disk-1"), undefined);
	assert.equal(registry.get("disk-2"), first);
});

test("a waiting terminal that quits is forgotten", async () => {
	const { registry } = setup();
	const first = bridge("disk-1", 901);
	const second = bridge("disk-1", 902);
	registry.attachBridge(first);
	registry.attachBridge(second);
	second.leave();
	first.leave();
	assert.equal(registry.get("disk-1"), undefined);
	assert.deepEqual(second.notices, [ELSEWHERE_NOTICE]);
});

test("a repeated hello from a terminal the registry already tracks changes nothing", async () => {
	const { registry, changes } = setup();
	const first = bridge("disk-1", 901);
	const second = bridge("disk-1", 902);
	assert.equal(registry.attachBridge(first), "attached");
	assert.equal(registry.attachBridge(first), "attached");
	assert.equal(registry.attachBridge(second), "waiting");
	assert.equal(registry.attachBridge(second), "waiting");
	assert.deepEqual(second.notices, [ELSEWHERE_NOTICE]);
	const before = changes.length;
	first.fire({ type: "state_changed" });
	assert.equal(changes.length - before, 1); // subscribed once
});

test("a terminal that attaches while a headless pi is still starting for the session keeps it", async () => {
	const { registry, started } = setup();
	const starting = registry.ensure("disk-1");
	await sleep(1); // the lookup is done; the headless pi is starting
	const b = bridge("disk-1");
	assert.equal(registry.attachBridge(b), "attached");
	assert.equal(await starting, b);
	assert.equal(started.length, 1);
	assert.equal(started[0].closed, true);
	assert.equal(registry.get("disk-1"), b);
});

test("the hub's own headless child is never taken for a terminal", async () => {
	const { registry } = setup();
	const rpc = await registry.ensure("disk-1");
	assert.equal(registry.attachBridge(bridge("disk-2", rpc.pid)), "ignored");
	assert.equal(registry.get("disk-2"), undefined);
});

test("bridges are never reaped, evicted or closed, and don't count toward maxHeadless", async () => {
	const { registry, setClock } = setup({ maxHeadless: 1 });
	const b = bridge("disk-2");
	registry.attachBridge(b);
	await registry.ensure("disk-1"); // the one headless slot
	setClock(1_000_000);
	registry.reap();
	registry.close("disk-2");
	registry.closeAll();
	assert.equal(b.closed, false);
	assert.equal(registry.get("disk-2"), b);
});

test("a terminal that switches onto a session an idle headless pi holds takes it over", async () => {
	const { registry, started } = setup();
	const b = bridge("disk-2");
	registry.attachBridge(b);
	await registry.ensure("disk-1");
	b.sessionId = "disk-1";
	b.fire({ type: "session_changed", from: "disk-2", to: "disk-1" });
	assert.equal(started[0].closed, true);
	assert.equal(registry.get("disk-1"), b);
	assert.equal(registry.get("disk-2"), undefined);
});
