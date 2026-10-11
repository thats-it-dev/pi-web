import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import type { AgentMessage, StreamMessage } from "../../shared/src/protocol.ts";
import { HttpError } from "../src/errors.ts";
import type { HandleEvent } from "../src/handle.ts";
import { RpcHandle } from "../src/rpc-handle.ts";
import { type FakeModel, type FakeScript, HELLO, startFakeModel } from "./support/fake-model.ts";
import { makePiEnv } from "./support/pi-env.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

async function startHandle(t: TestContext, script: FakeScript = HELLO, sessionFile?: string, env = makePiEnv({ modelUrl: model.url })) {
	model.setScript(script);
	const h = await RpcHandle.start({ piBin: env.piBin, cwd: env.workDir, sessionFile, exportDir: join(env.root, "exports"), env: env.env, promptAckMs: 500 });
	t.after(() => {
		h.close();
		if (!sessionFile) env.cleanup();
	});
	return { h, env };
}

// Records everything a subscriber sees and lets a test wait for a match.
function watch(h: RpcHandle) {
	const seen: StreamMessage[] = [];
	let consumed = 0; // seen[0..consumed) have been handed out already
	const waiters: Array<{ pred: (m: StreamMessage) => boolean; resolve: (m: StreamMessage) => void }> = [];
	h.subscribe((m) => {
		seen.push(m);
		for (const w of [...waiters]) {
			if (!w.pred(m)) continue;
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(m);
		}
	});
	return {
		seen,
		// Returns the first not-yet-consumed message already seen that matches, else waits for a new one.
		next(pred: (m: StreamMessage) => boolean, timeoutMs = 15_000): Promise<StreamMessage> {
			const idx = seen.findIndex((m, i) => i >= consumed && pred(m));
			if (idx >= 0) {
				consumed = idx + 1;
				return Promise.resolve(seen[idx]);
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timed out waiting for stream message")), timeoutMs);
				waiters.push({
					pred,
					resolve: (m) => {
						clearTimeout(timer);
						consumed = seen.length;
						resolve(m);
					},
				});
			});
		},
	};
}
const isEvent = (type: string) => (m: StreamMessage) => m.type === "event" && m.event.type === type;
const lastAssistant = (msgs: AgentMessage[]) => msgs.findLast((m) => m.role === "assistant");
const textOf = (m?: AgentMessage) => (Array.isArray(m?.content) ? m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("") : "");

test("boots a new session with models, commands and thinking levels", async (t) => {
	const { h } = await startHandle(t);
	const s = h.snapshot();
	assert.ok(s.sessionId);
	assert.equal(s.handleKind, "rpc");
	assert.equal(s.capabilities.dialogs, "here");
	assert.equal(s.state.model?.id, "fake-a");
	assert.deepEqual(s.models.map((m) => m.id), ["fake-a", "fake-b"]);
	assert.ok(s.commands.some((c) => c.name === "ask"));
	assert.ok(s.thinkingLevels.includes("off"));
	assert.equal(h.liveState(), "idle");
});

test("streams a prompt, settles, and refreshes stats", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const states: HandleEvent[] = [];
	h.onEvent((e) => states.push(e));
	assert.deepEqual(await h.command({ type: "prompt", text: "hi", mode: "send" }), { ok: true, data: { disposition: "started" } });
	await w.next(isEvent("agent_settled"));
	const meta = await w.next((m) => m.type === "meta");
	assert.equal(meta.type === "meta" && meta.stats?.contextUsage?.contextWindow, 1000);
	assert.equal(textOf(lastAssistant(h.snapshot().conv.messages)), "Hello world");
	assert.ok(states.some((e) => e.type === "state_changed"));
	assert.equal(h.isBusy(), false);
});

test("runs a tool call and records the result", async (t) => {
	const script: FakeScript = (req) =>
		req.messages.at(-1)?.role === "tool" ? { text: "done" } : { toolCalls: [{ id: "call_1", name: "bash", args: { command: "echo hi-from-tool" } }] };
	const { h } = await startHandle(t, script);
	const w = watch(h);
	await h.command({ type: "prompt", text: "run it", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const conv = h.snapshot().conv;
	assert.equal(conv.tools.call_1?.running, false);
	const result = conv.messages.find((m) => m.role === "toolResult");
	assert.match(textOf(result), /hi-from-tool/);
	assert.equal(textOf(lastAssistant(conv.messages)), "done");
});

test("switches model and thinking level", async (t) => {
	const { h } = await startHandle(t);
	assert.equal((await h.command({ type: "set_model", provider: "fake", modelId: "fake-b" })).ok, true);
	assert.equal(h.snapshot().state.model?.id, "fake-b");
	assert.deepEqual(h.snapshot().thinkingLevels, ["off"]);
	await h.command({ type: "set_model", provider: "fake", modelId: "fake-a" });
	await h.command({ type: "set_thinking", level: "high" });
	assert.equal(h.snapshot().state.thinkingLevel, "high");
	assert.equal((await h.command({ type: "set_model", provider: "fake", modelId: "nope" })).ok, false);
});

test("a prompt that opens a dialog returns pending quickly; the answer reaches the extension", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const started = Date.now();
	const result = await h.command({ type: "prompt", text: "/ask", mode: "send" });
	assert.equal(result.ok, true);
	assert.ok(Date.now() - started < 2000, "command must not wait for the dialog");
	const d = await w.next((m) => m.type === "dialog");
	assert.ok(d.type === "dialog" && d.dialog.title === "Pick one" && d.dialog.method === "select");
	assert.equal(h.liveState(), "needs_you");
	assert.equal((await h.command({ type: "dialog_response", id: d.dialog.id, value: "blue" })).ok, true);
	const n = await w.next((m) => m.type === "notify");
	assert.ok(n.type === "notify" && n.message === "picked blue");
	assert.equal((await h.command({ type: "dialog_response", id: d.dialog.id, value: "red" })).ok, false);
});

test("abort stops a slow reply", async (t) => {
	const { h } = await startHandle(t, () => ({ text: "word ".repeat(80), chunkDelayMs: 50 }));
	const w = watch(h);
	await h.command({ type: "prompt", text: "talk", mode: "send" });
	await w.next((m) => m.type === "event" && m.event.assistantMessageEvent?.type === "text_delta");
	assert.equal((await h.command({ type: "abort" })).ok, true);
	await w.next(isEvent("agent_settled"));
	assert.equal(lastAssistant(h.snapshot().conv.messages)?.stopReason, "aborted");
});

test("reopens an existing session file with its history", async (t) => {
	const env = makePiEnv({ modelUrl: model.url });
	t.after(() => env.cleanup());
	const first = await RpcHandle.start({ piBin: env.piBin, cwd: env.workDir, exportDir: join(env.root, "exports"), env: env.env });
	const w = watch(first);
	await first.command({ type: "prompt", text: "remember me", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const { sessionId, sessionFile } = first.snapshot();
	assert.ok(sessionFile);
	const exited = new Promise((r) => first.onEvent((e) => e.type === "exit" && r(e)));
	first.close();
	await exited;
	const { h } = await startHandle(t, HELLO, sessionFile, env);
	assert.equal(h.sessionId, sessionId);
	assert.ok(h.snapshot().conv.messages.some((m) => m.role === "user" && textOf(m) === "remember me"));
});

test("fork moves the handle to a new session and announces it", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	await h.command({ type: "prompt", text: "fork from here", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const points = await h.command({ type: "get_fork_points" });
	const first = (points.data as { messages: Array<{ entryId: string; text: string }> }).messages[0];
	assert.equal(first.text, "fork from here");
	const changed = new Promise<HandleEvent>((r) => h.onEvent((e) => e.type === "session_changed" && r(e)));
	const before = h.sessionId;
	assert.equal((await h.command({ type: "fork", entryId: first.entryId })).ok, true);
	const e = await changed;
	assert.ok(e.type === "session_changed" && e.from === before && e.to === h.sessionId && e.to !== before);
	assert.ok(w.seen.some((m) => m.type === "snapshot" && m.snapshot.sessionId === h.sessionId));
	assert.deepEqual(h.snapshot().conv.tools, {});
	assert.deepEqual(h.snapshot().conv.queue, { steering: [], followUp: [] });
});

test("reports pi exiting unexpectedly", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const exit = new Promise<HandleEvent>((r) => h.onEvent((e) => e.type === "exit" && r(e)));
	process.kill(h.pid, "SIGKILL");
	const gone = await w.next((m) => m.type === "handle_gone");
	assert.ok(gone.type === "handle_gone" && gone.reason === "exit");
	const e = await exit;
	assert.ok(e.type === "exit" && e.closedByHub === false);
	assert.equal((await h.command({ type: "abort" })).ok, false);
});

test("close() is reported as a clean shutdown", async (t) => {
	const { h } = await startHandle(t);
	const w = watch(h);
	const exit = new Promise<HandleEvent>((r) => h.onEvent((e) => e.type === "exit" && r(e)));
	h.close();
	const gone = await w.next((m) => m.type === "handle_gone");
	assert.ok(gone.type === "handle_gone" && gone.reason === "closed");
	assert.ok(((await exit) as { closedByHub: boolean }).closedByHub);
});

test("fails fast with a 502 when pi can't start", async () => {
	const env = makePiEnv({ modelUrl: model.url });
	try {
		const started = Date.now();
		await assert.rejects(
			RpcHandle.start({ piBin: "/nonexistent/pi", cwd: env.workDir, exportDir: env.root, env: env.env }),
			(e: unknown) => e instanceof HttpError && e.status === 502 && /Couldn't start pi/.test(e.message),
		);
		assert.ok(Date.now() - started < 5000);
	} finally {
		env.cleanup();
	}
});

test("export writes an HTML file and returns its name", async (t) => {
	const { h, env } = await startHandle(t);
	const w = watch(h);
	await h.command({ type: "prompt", text: "hi", mode: "send" });
	await w.next(isEvent("agent_settled"));
	const r = await h.command({ type: "export" });
	assert.equal(r.ok, true);
	const name = (r.data as { name: string }).name;
	assert.match(name, /\.html$/);
	assert.ok(existsSync(join(env.root, "exports", name)));
});

test("a pi that crashes on startup fails fast with its stderr in the 502", async () => {
	const env = makePiEnv({ modelUrl: model.url });
	const fake = join(env.root, "crashing-pi.sh");
	writeFileSync(fake, "#!/bin/sh\necho 'boom: bad config' >&2\nexit 3\n", { mode: 0o755 });
	try {
		const started = Date.now();
		await assert.rejects(
			RpcHandle.start({ piBin: fake, cwd: env.workDir, exportDir: env.root, env: env.env }),
			(e: unknown) => e instanceof HttpError && e.status === 502 && /boom: bad config/.test(e.message),
		);
		assert.ok(Date.now() - started < 5000);
	} finally {
		env.cleanup();
	}
});

test("a throwing subscriber does not stop other subscribers", async (t) => {
	const { h } = await startHandle(t);
	const errors = t.mock.method(console, "error", () => {});
	const unsubscribe = h.subscribe(() => {
		throw new Error("bad subscriber");
	});
	const w = watch(h);
	await h.command({ type: "prompt", text: "hi", mode: "send" });
	await w.next(isEvent("agent_settled"));
	assert.ok(errors.mock.callCount() > 0);
	unsubscribe();
});
