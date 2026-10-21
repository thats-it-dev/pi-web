import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeHub } from "../../hub/test/support/fake-hub.ts";
import { type FakeModel, type FakeScript, HELLO, startFakeModel } from "../../hub/test/support/fake-model.ts";
import { makePiEnv } from "../../hub/test/support/pi-env.ts";
import { startTerminalPi } from "../../hub/test/support/terminal-pi.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

async function setup(t: TestContext, opts: { settings?: Record<string, unknown>; extraEnv?: Record<string, string>; noHub?: boolean } = {}) {
	model.setScript(HELLO);
	const env = makePiEnv({ modelUrl: model.url, settings: opts.settings });
	const sock = opts.noHub ? join(env.root, "missing", "bridge.sock") : join(env.root, "bridge.sock");
	const hub = opts.noHub ? null : await fakeHub(sock);
	const term = startTerminalPi({ piBin: env.piBin, cwd: env.workDir, env: env.env, socketPath: sock, extraEnv: opts.extraEnv });
	t.after(async () => {
		await term.quit();
		await hub?.close();
		env.cleanup();
	});
	return { env, hub, term };
}

const userText = (r: any) => (typeof r.message?.content === "string" ? r.message.content : JSON.stringify(r.message?.content ?? ""));

test("a terminal pi introduces itself with its session, models, levels and commands", async (t) => {
	const { hub, term } = await setup(t);
	const hello = await hub!.messages.waitFor((m) => m.type === "hello");
	const state = await term.call({ type: "get_state" });
	assert.equal(hello.sessionId, state.data.sessionId);
	assert.equal(hello.pid, term.pid);
	assert.match(hello.piVersion, /^\d+\.\d+\.\d+/);
	assert.deepEqual(hello.sync.models.map((m: { id: string }) => m.id).sort(), ["fake-a", "fake-b"]);
	assert.ok(hello.sync.thinkingLevels.includes("off") && hello.sync.thinkingLevels.includes("high"));
	assert.ok(hello.sync.commands.some((c: { name: string; source: string }) => c.name === "ask" && c.source === "extension"));
	assert.equal(hello.sync.state.model.id, "fake-a");
});

test("a prompt typed in the terminal streams to the hub in RPC shapes", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	term.send({ type: "prompt", message: "from the terminal" });
	const ev = (type: string, pred: (e: any) => boolean = () => true) => hub!.messages.next((m) => m.type === "event" && m.event.type === type && pred(m.event));
	await ev("agent_start");
	assert.match(userText((await ev("message_end", (e) => e.message.role === "user")).event), /from the terminal/);
	const update = await ev("message_update");
	assert.equal("message" in update.event, false);
	assert.equal("partial" in update.event.assistantMessageEvent, false);
	assert.match(userText((await ev("message_end", (e) => e.message.role === "assistant")).event), /Hello world/);
	await ev("agent_settled");
	const sync = await hub!.messages.next((m) => m.type === "sync" && m.sync.state.isStreaming === false);
	assert.equal(sync.sync.stats.assistantMessages, 1);
});

test("the hub's commands take effect in the terminal pi", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	const cmd = async (id: string, command: Record<string, unknown>) => {
		hub!.send({ type: "cmd", id, command });
		return hub!.messages.waitFor((m) => m.type === "result" && m.id === id);
	};
	assert.equal((await cmd("1", { type: "prompt", text: "from the app", mode: "send" })).ok, true);
	await term.records.waitFor((r) => r.type === "message_end" && r.message?.role === "user" && /from the app/.test(userText(r)));
	await term.records.waitFor((r) => r.type === "agent_settled");

	assert.equal((await cmd("2", { type: "set_model", provider: "fake", modelId: "fake-b" })).ok, true);
	await hub!.messages.waitFor((m) => m.type === "sync" && m.sync.state.model?.id === "fake-b");
	assert.equal((await term.call({ type: "get_state" })).data.model.id, "fake-b");

	assert.equal((await cmd("3", { type: "rename", name: "named from the app" })).ok, true);
	await hub!.messages.waitFor((m) => m.type === "sync" && m.sync.state.sessionName === "named from the app");

	const ask = await cmd("4", { type: "prompt", text: "/ask", mode: "send" });
	assert.equal(ask.ok, false);
	assert.match(ask.error, /extension command/);
	assert.ok(model.requests.every((r) => !JSON.stringify(r.messages).includes("/ask")));

	assert.match((await cmd("5", { type: "set_model", provider: "fake", modelId: "nope" })).error, /Model not found/);
});

test("a dialog open in the terminal is reported, and cleared once answered", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	term.send({ type: "prompt", message: "/ask" });
	assert.deepEqual((await hub!.messages.next((m) => m.type === "prompt_state")).prompt, { kind: "select", title: "Pick one" });
	const req = await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "select");
	term.send({ type: "extension_ui_response", id: req.id, value: "red" });
	assert.equal((await hub!.messages.next((m) => m.type === "prompt_state")).prompt, null);
});

test("hub notices reach the terminal UI", async (t) => {
	const { hub, term } = await setup(t);
	await hub!.messages.next((m) => m.type === "hello");
	hub!.send({ type: "notice", text: "hello from the hub" });
	await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && r.message === "hello from the hub");
});

test("compacting from the hub sends compaction events and a full sync", async (t) => {
	const { hub } = await setup(t, { settings: { compaction: { enabled: false, keepRecentTokens: 10 } } });
	await hub!.messages.next((m) => m.type === "hello");
	for (const [i, text] of ["one", "two", "three"].entries()) {
		hub!.send({ type: "cmd", id: `p${i}`, command: { type: "prompt", text, mode: "send" } });
		await hub!.messages.next((m) => m.type === "event" && m.event.type === "agent_settled");
	}
	hub!.send({ type: "cmd", id: "c", command: { type: "compact", instructions: "keep it short" } });
	await hub!.messages.waitFor((m) => m.type === "event" && m.event.type === "compaction_start");
	await hub!.messages.waitFor((m) => m.type === "event" && m.event.type === "compaction_end");
	assert.equal((await hub!.messages.waitFor((m) => m.type === "result" && m.id === "c", 30_000)).ok, true);
	const full = await hub!.messages.waitFor((m) => m.type === "sync" && Array.isArray(m.sync.messages));
	assert.equal(full.sync.messages[0].role, "compactionSummary");
});

test("a /new in the terminal says bye and introduces the new session", async (t) => {
	const { hub, term } = await setup(t);
	const first = await hub!.messages.next((m) => m.type === "hello");
	assert.equal((await term.call({ type: "new_session" })).success, true);
	assert.deepEqual(await hub!.messages.next((m) => m.type === "bye"), { type: "bye", reason: "new" });
	const second = await hub!.messages.next((m) => m.type === "hello");
	assert.notEqual(second.sessionId, first.sessionId);
	assert.equal(second.pid, first.pid);
});

test("the hub's own headless children (PI_WEB=1) never connect", async (t) => {
	const { hub, term } = await setup(t, { extraEnv: { PI_WEB: "1" } });
	assert.equal((await term.call({ type: "get_state" })).success, true);
	await sleep(1500);
	assert.equal(hub!.connections(), 0);
});

test("with no hub, pi starts and works normally and the bridge stays silent", async (t) => {
	const { term } = await setup(t, { noHub: true });
	assert.equal((await term.call({ type: "get_state" })).success, true);
	term.send({ type: "prompt", message: "hi" });
	await term.records.waitFor((r) => r.type === "agent_settled");
	assert.doesNotMatch(term.stderr(), /pi-web|bridge|ENOENT|ECONNREFUSED/i);
	assert.equal(term.records.items.filter((r) => r.type === "extension_error").length, 0);
});

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const showImageScript = (): FakeScript => (req) => (req.messages.at(-1)?.role !== "tool" ? { toolCalls: [{ id: "call_img", name: "show_image", args: { path: "shot.png" } }] } : { text: "done" });

test("show_image puts the image in the transcript", async (t) => {
	const { env, hub, term } = await setup(t);
	writeFileSync(join(env.workDir, "shot.png"), PNG_1PX);
	model.setScript(showImageScript());
	await hub!.messages.next((m) => m.type === "hello");
	term.send({ type: "prompt", message: "show it" });
	const end = await hub!.messages.waitFor((m) => m.type === "event" && m.event.type === "tool_execution_end");
	assert.equal(end.event.isError, false);
	assert.equal(end.event.result.content[1].type, "image");
	assert.equal(end.event.result.content[1].mimeType, "image/png");
});

test("show_image exists in the hub's own headless children (PI_WEB=1)", async (t) => {
	const { env, hub, term } = await setup(t, { extraEnv: { PI_WEB: "1" } });
	writeFileSync(join(env.workDir, "shot.png"), PNG_1PX);
	model.setScript(showImageScript());
	term.send({ type: "prompt", message: "show it" });
	const end = await term.records.waitFor((r) => r.type === "tool_execution_end", 30_000);
	assert.equal(end.toolName, "show_image");
	assert.equal(end.isError, false);
	assert.equal(end.result.content[1].type, "image");
	assert.equal(hub!.connections(), 0);
});
