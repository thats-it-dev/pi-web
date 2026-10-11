import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeHello, HubToBridge } from "../../shared/src/bridge.ts";
import type { AppCommand, StreamMessage } from "../../shared/src/protocol.ts";
import { BridgeHandle, UNAVAILABLE_IN_TERMINAL } from "../src/bridge-handle.ts";
import type { HandleEvent } from "../src/handle.ts";

const state = (id: string, extra = {}) => ({ model: null, thinkingLevel: "off" as const, isStreaming: false, isCompacting: false, sessionId: id, sessionFile: `/s/${id}.jsonl`, messageCount: 1, pendingMessageCount: 0, autoCompactionEnabled: true, ...extra });

function hello(id = "t-1", extra: Partial<BridgeHello> = {}): BridgeHello {
	return {
		type: "hello",
		protocol: 1,
		sessionId: id,
		sessionFile: `/s/${id}.jsonl`,
		cwd: "/work",
		pid: 777,
		piVersion: "1.0.2",
		prompt: null,
		sync: { state: state(id), stats: null, thinkingLevels: ["off"], models: [], commands: [{ name: "ask", source: "extension" }], messages: [{ role: "user", content: "earlier", timestamp: 1 }] },
		...extra,
	};
}

function setup(h0 = hello()) {
	const sent: HubToBridge[] = [];
	const conn = { send: (m: HubToBridge) => void sent.push(m), close: () => {} };
	const h = new BridgeHandle(conn, h0);
	const stream: StreamMessage[] = [];
	const events: HandleEvent[] = [];
	h.subscribe((m) => stream.push(m));
	h.onEvent((e) => events.push(e));
	return { h, sent, stream, events, conn };
}

test("the snapshot comes from hello: a terminal-owned session with its conversation", () => {
	const { h } = setup();
	const s = h.snapshot();
	assert.equal(s.handleKind, "bridge");
	assert.deepEqual(s.capabilities, { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false });
	assert.equal(s.conv.messages.length, 1);
	assert.equal(s.terminalPrompt, null);
	assert.deepEqual([h.sessionId, h.sessionFile, h.cwd, h.pid, h.kind], ["t-1", "/s/t-1.jsonl", "/work", 777, "bridge"]);
	assert.equal(h.liveState(), "idle");
});

test("events run through the reducer, reach subscribers, and move the live state", () => {
	const { h, stream, events } = setup();
	h.receive({ type: "event", event: { type: "agent_start" } });
	assert.equal(h.liveState(), "running");
	assert.equal(h.isBusy(), true);
	h.receive({ type: "event", event: { type: "message_end", message: { role: "user", content: "now" } } });
	h.receive({ type: "event", event: { type: "agent_settled" } });
	assert.equal(h.liveState(), "idle");
	assert.equal(h.snapshot().conv.messages.length, 2);
	assert.equal(stream.filter((m) => m.type === "event").length, 3);
	assert.equal(events.filter((e) => e.type === "state_changed").length, 2);
});

test("app commands the terminal can run are forwarded and answered by id", async () => {
	const { h, sent } = setup();
	const pending = h.command({ type: "prompt", text: "hi", mode: "send" });
	const cmd = sent.at(-1) as Extract<HubToBridge, { type: "cmd" }>;
	assert.deepEqual(cmd.command, { type: "prompt", text: "hi", mode: "send" });
	h.receive({ type: "result", id: cmd.id, ok: true });
	assert.deepEqual(await pending, { ok: true, data: undefined });
	const failing = h.command({ type: "rename", name: "x" });
	h.receive({ type: "result", id: (sent.at(-1) as { id: string }).id, ok: false, error: "nope" });
	assert.deepEqual(await failing, { ok: false, error: "nope" });
});

test("rpc-only commands are refused here, without bothering the terminal", async () => {
	const { h, sent } = setup();
	const table: Array<[AppCommand, string | null]> = [
		[{ type: "attach" }, null],
		[{ type: "fork", entryId: "e" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "get_fork_points" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "clone" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "new_session" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "bash", command: "ls", excludeFromContext: false }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "export" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "clear_queue" }, UNAVAILABLE_IN_TERMINAL],
		[{ type: "dialog_response", id: "d", cancelled: true }, "That dialog is open in the terminal."],
	];
	for (const [cmd, error] of table) assert.deepEqual(await h.command(cmd), error ? { ok: false, error } : { ok: true }, cmd.type);
	assert.equal(sent.length, 0);
});

test("a terminal dialog makes the session need you, and shows in meta and snapshots", () => {
	const { h, stream, events } = setup();
	h.receive({ type: "prompt_state", prompt: { kind: "confirm", title: "Allow rm?" } });
	assert.equal(h.liveState(), "needs_you");
	assert.deepEqual((stream.at(-1) as { terminalPrompt: unknown }).terminalPrompt, { kind: "confirm", title: "Allow rm?" });
	assert.deepEqual(h.snapshot().terminalPrompt, { kind: "confirm", title: "Allow rm?" });
	h.receive({ type: "prompt_state", prompt: null });
	assert.equal(h.liveState(), "idle");
	assert.equal(events.filter((e) => e.type === "state_changed").length, 2);
});

test("a state sync updates meta; a full sync replaces the conversation; a new name announces itself", () => {
	const { h, stream, events } = setup();
	h.receive({ type: "sync", sync: { state: state("t-1", { sessionName: "katsu" }), stats: null, thinkingLevels: ["off", "high"] } });
	assert.equal(stream.at(-1)?.type, "meta");
	assert.deepEqual(h.snapshot().thinkingLevels, ["off", "high"]);
	assert.ok(events.some((e) => e.type === "renamed"));
	h.receive({ type: "sync", sync: { state: state("t-1", { sessionName: "katsu" }), stats: null, thinkingLevels: ["off"], models: [], commands: [], messages: [{ role: "compactionSummary", summary: "s" }] } });
	assert.equal(stream.at(-1)?.type, "snapshot");
	assert.deepEqual(h.snapshot().conv.messages.map((m) => m.role), ["compactionSummary"]);
	assert.equal(events.filter((e) => e.type === "renamed").length, 1);
});

test("during a runtime switch commands wait for nothing and fail clearly; rebind re-keys and resnapshots", async () => {
	const { h, sent, stream, events } = setup();
	const inFlight = h.command({ type: "abort" });
	h.detach();
	assert.match((await inFlight).error ?? "", /switching sessions/);
	assert.match((await h.command({ type: "abort" })).error ?? "", /switching sessions/);
	const sent2: HubToBridge[] = [];
	h.rebind({ send: (m) => void sent2.push(m), close: () => {} }, hello("t-2"));
	assert.equal(h.sessionId, "t-2");
	assert.equal((stream.at(-1) as { snapshot: { sessionId: string } }).snapshot.sessionId, "t-2");
	assert.deepEqual(events.find((e) => e.type === "session_changed"), { type: "session_changed", from: "t-1", to: "t-2" });
	void h.command({ type: "abort" });
	assert.equal(sent2.length, 1);
	assert.equal(sent.length, 1);
});

test("gone: pending commands fail, subscribers get handle_gone, and the registry gets a clean exit", async () => {
	const { h, stream, events } = setup();
	const inFlight = h.command({ type: "abort" });
	h.gone();
	assert.equal((await inFlight).ok, false);
	assert.deepEqual(stream.at(-1), { type: "handle_gone", reason: "closed" });
	assert.deepEqual(events.at(-1), { type: "exit", code: 0, stderr: "", closedByHub: false });
	h.gone();
	assert.equal(events.filter((e) => e.type === "exit").length, 1);
});

test("notice goes to the terminal; close() leaves the terminal pi alone", () => {
	const { h, sent, stream } = setup();
	h.notice("hello");
	assert.deepEqual(sent, [{ type: "notice", text: "hello" }]);
	h.close();
	assert.equal(stream.some((m) => m.type === "handle_gone"), false);
});
