import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, LiveState } from "../../shared/src/protocol.ts";
import { Registry } from "../src/registry.ts";
import { type TurnOutcome, watchTurns } from "../src/turns.ts";
import { FakeHandle } from "./support/fake-handle.ts";

function setup() {
	let n = 0;
	const registry = new Registry({
		factory: { startRpc: async (o) => new FakeHandle(`s-${++n}`, o.cwd) },
		lookup: { find: async () => null },
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const outcomes: TurnOutcome[] = [];
	const titles: string[] = [];
	const stop = watchTurns(registry, (o, snap) => {
		outcomes.push(o);
		titles.push(snap.cwd);
	});
	return { registry, outcomes, titles, stop };
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });
const reply = (stopReason = "stop", extra: Partial<AgentMessage> = {}): AgentMessage => ({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason, ...extra });

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

test("a finished run yields finished with the last assistant text and index", async () => {
	const { registry, outcomes, titles } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h);
	assert.deepEqual(outcomes, [{ sessionId: "s-1", kind: "finished", messageIndex: 1, text: "done" }]);
	assert.deepEqual(titles, ["/work/proj"]);
});

test("an error stopReason yields error, with errorMessage when there is one", async () => {
	const { registry, outcomes } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h, reply("error"));
	await run(h, reply("error", { errorMessage: "rate limited" }));
	assert.deepEqual(outcomes, [
		{ sessionId: "s-1", kind: "error", messageIndex: 1, text: "done" },
		{ sessionId: "s-1", kind: "error", messageIndex: 3, text: "rate limited" },
	]);
});

test("needs_you yields needs_you", async () => {
	const { registry, outcomes } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	to(h, "needs_you");
	h.fire({ type: "state_changed" });
	assert.deepEqual(outcomes, [{ sessionId: "s-1", kind: "needs_you" }]);
});

test("an aborted run yields nothing; a bridge handle yields nothing", async () => {
	const { registry, outcomes } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	await run(h, reply("aborted"));
	const t = new FakeHandle("term-1", "/work/proj", null, { kind: "bridge", pid: 999 });
	assert.equal(registry.attachBridge(t), "attached");
	await run(t);
	to(t, "needs_you");
	assert.deepEqual(outcomes, []);
});

test("a run that adds no new assistant message yields nothing; stop() ends watching", async () => {
	const { registry, outcomes, stop } = setup();
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.conv.messages.push(user("earlier"), reply());
	to(h, "running");
	to(h, "idle");
	stop();
	await run(h);
	assert.deepEqual(outcomes, []);
});
