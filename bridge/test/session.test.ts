import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AgentMessage } from "../../shared/src/protocol.ts";
import { fakeHub } from "../../hub/test/support/fake-hub.ts";
import { BridgeSession, type CtxLike, type PiLike } from "../session.ts";
import type { EntryLike, ModelLike } from "../wire.ts";

const MODELS: ModelLike[] = [
	{ id: "a", name: "A", provider: "p", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 },
	{ id: "nokey", name: "No key", provider: "p", reasoning: false, input: ["text"], contextWindow: 2000, maxTokens: 100 },
];

function fakes() {
	const calls: unknown[][] = [];
	const world = { idle: true, name: undefined as string | undefined, thinking: "medium", model: MODELS[0] as ModelLike | undefined, compact: "ok" as "ok" | "fail" };
	const entries: EntryLike[] = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "yo" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } } },
	];
	const pi: PiLike = {
		sendUserMessage: (content, options) => void calls.push(["send", content, options]),
		setModel: async (m) => {
			calls.push(["setModel", m.id]);
			if (m.id === "nokey") return false;
			world.model = m;
			return true;
		},
		getThinkingLevel: () => world.thinking as never,
		setThinkingLevel: (level) => void (world.thinking = level),
		getSessionName: () => world.name,
		setSessionName: (name) => void (world.name = name),
		getCommands: () => [
			{ name: "ask", source: "extension" },
			{ name: "greet", description: "greet", source: "prompt" },
		],
	};
	const ctx: CtxLike = {
		cwd: "/work",
		hasUI: true,
		ui: { notify: (message, type) => void calls.push(["notify", message, type]) },
		get model() {
			return world.model;
		},
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/s/sess-1.jsonl", getLeafId: () => "leaf", getEntries: () => entries },
		modelRegistry: { getAvailable: () => MODELS, find: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id) },
		isIdle: () => world.idle,
		hasPendingMessages: () => false,
		abort: () => void calls.push(["abort"]),
		getContextUsage: () => ({ tokens: 15, contextWindow: 1000, percent: 1.5 }),
		compact: (o) => {
			calls.push(["compact", o.customInstructions]);
			setTimeout(() => (world.compact === "ok" ? o.onComplete?.({}) : o.onError?.(new Error("Nothing to compact"))), 5);
		},
	};
	return { pi, ctx, calls, world };
}

// pi 1.0.2 invalidates an extension ctx after session_shutdown: every getter throws from then on.
function staleAfter(ctx: CtxLike, flag: { stale: boolean }): CtxLike {
	return new Proxy(ctx, {
		get(target, key, receiver) {
			if (flag.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return Reflect.get(target, key, receiver);
		},
	});
}

async function setup(t: TestContext, wrap: (ctx: CtxLike) => CtxLike = (ctx) => ctx) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-session-"));
	const path = join(dir, "bridge.sock");
	const hub = await fakeHub(path);
	const f = fakes();
	const session = new BridgeSession(f.pi, wrap(f.ctx), {
		socketPath: path,
		piVersion: "1.0.2",
		pid: 4321,
		minDelayMs: 20,
		maxDelayMs: 50,
		buildMessages: (entries) => entries.map((e) => e.message as AgentMessage),
		thinkingLevels: (model) => (model?.reasoning ? ["off", "low", "high"] : ["off"]),
	});
	t.after(async () => {
		session.stop("quit");
		await hub.close();
		rmSync(dir, { recursive: true, force: true });
	});
	session.start();
	const hello = await hub.messages.next((m) => m.type === "hello");
	return { ...f, hub, session, hello };
}

test("hello carries the ids and a full sync: state, stats, models, commands, messages", async (t) => {
	const { hello } = await setup(t);
	assert.equal(hello.protocol, 1);
	assert.deepEqual([hello.sessionId, hello.sessionFile, hello.cwd, hello.pid, hello.piVersion], ["sess-1", "/s/sess-1.jsonl", "/work", 4321, "1.0.2"]);
	assert.equal(hello.prompt, null);
	assert.equal(hello.sync.state.model.id, "a");
	assert.equal(hello.sync.state.thinkingLevel, "medium");
	assert.equal(hello.sync.state.isStreaming, false);
	assert.equal(hello.sync.stats.tokens.total, 15);
	assert.equal(hello.sync.stats.cost, 0.25);
	assert.deepEqual(hello.sync.stats.contextUsage, { tokens: 15, contextWindow: 1000, percent: 1.5 });
	assert.deepEqual(hello.sync.thinkingLevels, ["off", "low", "high"]);
	assert.deepEqual(hello.sync.models.map((m: { id: string }) => m.id), ["a", "nokey"]);
	assert.deepEqual(hello.sync.commands.map((c: { name: string }) => c.name), ["ask", "greet"]);
	assert.equal(hello.sync.messages.length, 2);
});

test("pi events are forwarded in RPC shape; turns and settles push a state sync", async (t) => {
	const { hub, session, ctx, world } = await setup(t);
	world.idle = false;
	session.onPiEvent({ type: "agent_start" }, ctx);
	session.onPiEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } }, ctx);
	session.onPiEvent({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "agent_start" });
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }); // undefined usage is dropped by JSON
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "turn_end", turnIndex: 0 });
	const sync = await hub.messages.next((m) => m.type === "sync");
	assert.equal(sync.sync.state.isStreaming, true);
	assert.equal(sync.sync.messages, undefined); // state only
	world.idle = true;
	session.onPiEvent({ type: "agent_settled" }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "sync")).sync.state.isStreaming, false);
});

test("compaction: start and end events, isCompacting while it runs, and a full sync afterwards", async (t) => {
	const { hub, session, ctx } = await setup(t);
	session.onPiEvent({ type: "session_before_compact", reason: "manual", preparation: {}, branchEntries: [] }, ctx);
	assert.deepEqual((await hub.messages.next((m) => m.type === "event")).event, { type: "compaction_start", reason: "manual" });
	session.onPiEvent({ type: "turn_end", turnIndex: 0 }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "sync")).sync.state.isCompacting, true);
	session.onPiEvent({ type: "session_compact", reason: "manual", willRetry: false, compactionEntry: {} }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "event")).event.type, "compaction_end");
	const full = await hub.messages.next((m) => m.type === "sync");
	assert.equal(full.sync.state.isCompacting, false);
	assert.equal(full.sync.messages.length, 2);
});

test("a compaction still marked running when the agent settles is closed out", async (t) => {
	const { hub, session, ctx } = await setup(t);
	session.onPiEvent({ type: "session_before_compact", reason: "threshold" }, ctx);
	session.onPiEvent({ type: "agent_settled" }, ctx);
	await hub.messages.next((m) => m.type === "event" && m.event.type === "compaction_start");
	assert.deepEqual((await hub.messages.next((m) => m.type === "event" && m.event.type === "compaction_end")).event, { type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
	assert.equal((await hub.messages.next((m) => m.type === "sync")).sync.state.isCompacting, false);
});

test("terminal dialogs open and close as prompt_state", async (t) => {
	const { hub, session, ctx } = await setup(t);
	session.onPiEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick one" }, ctx);
	assert.deepEqual((await hub.messages.next((m) => m.type === "prompt_state")).prompt, { kind: "select", title: "Pick one" });
	session.onPiEvent({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Pick one" }, ctx);
	assert.equal((await hub.messages.next((m) => m.type === "prompt_state")).prompt, null);
});

test("prompts: plain send when idle, follow-up while busy, steer on request, images as content blocks", async (t) => {
	const { session, calls, world } = await setup(t);
	assert.deepEqual(await session.run({ type: "prompt", text: "/greet Bob", mode: "send" }), { ok: true });
	world.idle = false;
	await session.run({ type: "prompt", text: "more", mode: "send" });
	await session.run({ type: "prompt", text: "turn left", mode: "steer" });
	await session.run({ type: "prompt", text: "look", images: [{ data: "AAAA", mimeType: "image/png" }], mode: "followUp" });
	assert.deepEqual(
		calls.filter((c) => c[0] === "send"),
		[
			["send", "/greet Bob", { expandPromptTemplates: true }],
			["send", "more", { expandPromptTemplates: true, deliverAs: "followUp" }],
			["send", "turn left", { expandPromptTemplates: true, deliverAs: "steer" }],
			["send", [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], { expandPromptTemplates: true, deliverAs: "followUp" }],
		],
	);
});

test("an extension command is refused instead of being sent to the model as text", async (t) => {
	const { session, calls } = await setup(t);
	const r = await session.run({ type: "prompt", text: "/ask", mode: "send" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /\/ask is an extension command\. Run it in the terminal\./);
	assert.equal(calls.filter((c) => c[0] === "send").length, 0);
});

test("model, thinking, rename, abort and compact run through the extension API", async (t) => {
	const { session, calls, world } = await setup(t);
	assert.deepEqual(await session.run({ type: "set_model", provider: "p", modelId: "missing" }), { ok: false, error: "Model not found: p/missing" });
	assert.deepEqual(await session.run({ type: "set_model", provider: "p", modelId: "nokey" }), { ok: false, error: "No API key for p/nokey" });
	assert.deepEqual(await session.run({ type: "set_model", provider: "p", modelId: "a" }), { ok: true });
	assert.deepEqual(await session.run({ type: "set_thinking", level: "high" }), { ok: true });
	assert.equal(world.thinking, "high");
	assert.deepEqual(await session.run({ type: "rename", name: "  " }), { ok: false, error: "Session name cannot be empty" });
	assert.deepEqual(await session.run({ type: "rename", name: " katsu " }), { ok: true });
	assert.equal(world.name, "katsu");
	assert.deepEqual(await session.run({ type: "abort" }), { ok: true });
	assert.deepEqual(await session.run({ type: "compact", instructions: "short" }), { ok: true });
	world.compact = "fail";
	assert.deepEqual(await session.run({ type: "compact" }), { ok: false, error: "Nothing to compact" });
	assert.deepEqual(
		calls.filter((c) => c[0] === "abort" || c[0] === "compact"),
		[["abort"], ["compact", "short"], ["compact", undefined]],
	);
});

test("commands from the hub are answered with a result; notices go to the terminal", async (t) => {
	const { hub, calls } = await setup(t);
	hub.send({ type: "cmd", id: "7", command: { type: "rename", name: "from the hub" } });
	assert.deepEqual(await hub.messages.next((m) => m.type === "result"), { type: "result", id: "7", ok: true });
	hub.send({ type: "notice", text: "hello terminal" });
	for (let i = 0; i < 50 && !calls.some((c) => c[0] === "notify"); i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(
		calls.find((c) => c[0] === "notify"),
		["notify", "hello terminal", "info"],
	);
});

test("a TUI /tree move resyncs the hub in full, like a compaction", async (t) => {
	const { hub, session, ctx } = await setup(t);
	session.onPiEvent({ type: "session_tree", newLeafId: "leaf", oldLeafId: "older" }, ctx);
	const full = await hub.messages.next((m) => m.type === "sync" || m.type === "event");
	assert.equal(full.type, "sync");
	assert.equal(full.sync.messages.length, 2);
});

// Socket callbacks run outside pi's handler try/catch, and interactive pi exits on any uncaught error.
function trapUncaught(t: TestContext): unknown[] {
	const caught: unknown[] = [];
	const onErr = (err: unknown) => void caught.push(err);
	process.on("uncaughtException", onErr);
	process.on("unhandledRejection", onErr);
	t.after(() => {
		process.off("uncaughtException", onErr);
		process.off("unhandledRejection", onErr);
	});
	return caught;
}

test("a notice that arrives after pi made the ctx stale is dropped without throwing", async (t) => {
	const caught = trapUncaught(t);
	const flag = { stale: false };
	const { hub, calls } = await setup(t, (ctx) => staleAfter(ctx, flag));
	flag.stale = true;
	hub.send({ type: "notice", text: "too late" });
	hub.send({ type: "cmd", id: "8", command: { type: "abort" } });
	assert.deepEqual(await hub.messages.next((m) => m.type === "result"), { type: "result", id: "8", ok: false, error: "This extension ctx is stale after session replacement or reload." });
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(caught, []);
	assert.equal(calls.some((c) => c[0] === "notify"), false);
});

test("a reconnect after pi made the ctx stale sends no hello and throws nothing", async (t) => {
	const caught = trapUncaught(t);
	const flag = { stale: false };
	const { hub } = await setup(t, (ctx) => staleAfter(ctx, flag));
	flag.stale = true;
	hub.dropClients();
	for (let i = 0; i < 50 && hub.connections() < 2; i++) await new Promise((r) => setTimeout(r, 10));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(hub.connections(), 2);
	assert.equal(hub.messages.items.filter((m) => m.type === "hello").length, 1);
	assert.deepEqual(caught, []);
});

test("after the hub restarts, the bridge reconnects and introduces itself again in full", async (t) => {
	const { hub } = await setup(t);
	hub.dropClients();
	const again = await hub.messages.next((m) => m.type === "hello");
	assert.equal(again.sessionId, "sess-1");
	assert.equal(again.sync.messages.length, 2);
});

test("stop says bye with pi's reason", async (t) => {
	const { hub, session } = await setup(t);
	session.stop("new");
	assert.deepEqual(await hub.messages.next((m) => m.type === "bye"), { type: "bye", reason: "new" });
});
