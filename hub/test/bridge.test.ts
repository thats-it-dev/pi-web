import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { ListMessage, StreamMessage } from "../../shared/src/protocol.ts";
import type { HubConfig } from "../src/config.ts";
import { startBridgeServer } from "../src/bridge-server.ts";
import type { SessionHandle } from "../src/handle.ts";
import { Registry } from "../src/registry.ts";
import { RpcHandle } from "../src/rpc-handle.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { type FakeModel, HELLO, startFakeModel } from "./support/fake-model.ts";
import { openSse } from "./support/http.ts";
import { makePiEnv } from "./support/pi-env.ts";
import { Recorder } from "./support/recorder.ts";
import { BRIDGE_ENTRY, startTerminalPi } from "./support/terminal-pi.ts";

let model: FakeModel;
before(async () => {
	model = await startFakeModel();
});
after(() => model.close());

const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };

// A hub with the bridge loaded for every pi in this config, the hub's own children included.
async function setup(t: TestContext) {
	model.setScript(HELLO);
	const env = makePiEnv({ modelUrl: model.url, settings: { extensions: [BRIDGE_ENTRY] } });
	const socketPath = join(env.root, "hub", "bridge.sock");
	const index = new SessionIndex(join(env.agentDir, "sessions"));
	const registry = new Registry({
		factory: { startRpc: (o) => RpcHandle.start({ ...o, piBin: env.piBin, exportDir: join(env.root, "exports"), env: env.env }) },
		lookup: index,
		maxHeadless: 6,
		idleMs: 60_000,
	});
	const list = new Recorder<ListMessage>();
	registry.onChange((m) => list.push(m));
	const bridge = await startBridgeServer({ socketPath, registry, switchGraceMs: 3000 });
	const cfg: HubConfig = {
		port: 0,
		internalPort: 0,
		hostname: "hub.test:7878",
		allowedLogin: "me@github",
		allowedOrigins: ["https://pi.thatsit.app"],
		idleMinutes: 20,
		maxHeadless: 6,
		piBin: env.piBin,
		dev: false,
		approvalMode: "manual",
	watchAlert: "auto",
	ringProfileUrl: "",
		dataDir: env.root,
	};
	const server = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: env.workDir, log: () => {} });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const sse: Array<{ close(): void }> = [];
	const openStream = async (id: string) => {
		const c = await openSse(port, `/api/sessions/${id}/stream`, GOOD);
		sse.push(c);
		return c;
	};
	const terminals: ReturnType<typeof startTerminalPi>[] = [];
	const terminal = (sessionFile?: string) => {
		const term = startTerminalPi({ piBin: env.piBin, cwd: env.workDir, env: env.env, socketPath, sessionFile, loadBridge: false });
		terminals.push(term);
		return term;
	};
	t.after(async () => {
		for (const c of sse) c.close();
		server.closeAllConnections();
		server.close();
		await Promise.all(terminals.map((x) => x.quit()));
		registry.closeAll();
		await bridge.close();
		await sleep(300);
		env.cleanup();
	});
	return { env, registry, list, terminal, openStream };
}

const until = async (cond: () => boolean, timeoutMs = 15_000) => {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error("condition never became true");
		await sleep(20);
	}
};

const bridgeFor = (registry: Registry, pid: number) => registry.all().find((h) => h.kind === "bridge" && h.pid === pid);

function watch(h: SessionHandle) {
	const r = new Recorder<StreamMessage>();
	h.subscribe((m) => r.push(m));
	return r;
}

const text = (m: any) => JSON.stringify(m?.content ?? "");

test("a terminal pi is live in the hub; prompts from the app and the terminal both stream", async (t) => {
	const { registry, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	assert.deepEqual(registry.info(h.sessionId), { live: true, handleKind: "bridge", state: "idle" });
	const stream = watch(h);

	assert.equal((await h.command({ type: "prompt", text: "from the app", mode: "send" })).ok, true);
	await stream.next((m) => m.type === "event" && m.event.type === "message_end" && m.event.message.role === "assistant");
	await stream.next((m) => m.type === "event" && m.event.type === "agent_settled");
	await term.records.waitFor((r) => r.type === "message_end" && r.message?.role === "user" && /from the app/.test(text(r.message)));

	term.send({ type: "prompt", message: "from the terminal" });
	await stream.next((m) => m.type === "event" && m.event.type === "message_end" && m.event.message.role === "user" && /from the terminal/.test(text(m.event.message)));
	await stream.next((m) => m.type === "event" && m.event.type === "agent_settled");
	assert.deepEqual(
		h.snapshot().conv.messages.map((m) => m.role),
		["user", "assistant", "user", "assistant"],
	);
});

test("model and name changes from the app come back as state; a terminal dialog is needs_you", async (t) => {
	const { registry, list, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	assert.equal((await h.command({ type: "set_model", provider: "fake", modelId: "fake-b" })).ok, true);
	await until(() => h.snapshot().state.model?.id === "fake-b");
	assert.equal((await h.command({ type: "rename", name: "from the app" })).ok, true);
	await until(() => h.snapshot().state.sessionName === "from the app");
	await list.waitFor((m) => m.type === "session_list_changed");

	term.send({ type: "prompt", message: "/ask" });
	await until(() => h.liveState() === "needs_you");
	assert.equal(h.snapshot().terminalPrompt?.title, "Pick one");
	const req = await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "select");
	term.send({ type: "extension_ui_response", id: req.id, value: "red" });
	await until(() => h.liveState() === "idle");
	assert.match((await h.command({ type: "prompt", text: "/ask", mode: "send" })).error ?? "", /extension command/);
});

test("the hub's own headless children load the bridge but never attach as terminals", async (t) => {
	const { env, registry } = await setup(t);
	const rpc = await registry.create(env.workDir);
	await sleep(1500);
	assert.equal(registry.get(rpc.sessionId)?.kind, "rpc");
	assert.equal(registry.all().filter((h) => h.kind === "bridge").length, 0);
});

test("a terminal resuming a session a busy headless pi holds waits, is told when it is free, and takes over on /resume with the latest messages", async (t) => {
	const { env, registry, terminal } = await setup(t);
	// A session with a file on disk, held by a headless pi.
	const rpc = await registry.create(env.workDir);
	const id = rpc.sessionId;
	const done = watch(rpc);
	await rpc.command({ type: "prompt", text: "first", mode: "send" });
	await done.next((m) => m.type === "event" && m.event.type === "agent_settled");
	const file = rpc.sessionFile as string;

	// Busy: the headless pi is mid-reply when the terminal opens the same file.
	model.setScript(() => ({ text: "a slow reply in many small pieces", chunkDelayMs: 150 }));
	await rpc.command({ type: "prompt", text: "second", mode: "send" });
	await until(() => rpc.isBusy());
	const term = terminal(file);
	await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && /running in pi-web/.test(r.message));
	assert.equal(registry.get(id), rpc);

	// Once it settles, the terminal is told the session is free; the settled headless pi keeps it.
	await term.records.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && /free now/.test(r.message), 30_000);
	assert.equal(registry.get(id), rpc);
	assert.equal(rpc.isBusy(), false);

	// The terminal's /resume of the same session (RPC switch_session runs the TUI /resume path) re-reads the file and takes over.
	assert.equal((await term.call({ type: "switch_session", sessionPath: file })).success, true);
	await until(() => registry.get(id)?.kind === "bridge");
	const h = registry.get(id) as SessionHandle;
	assert.equal(h.pid, term.pid);
	await until(() => registry.all().filter((x) => x.kind === "rpc").length === 0);
	assert.ok(h.snapshot().conv.messages.some((m) => m.role === "assistant" && /a slow reply in many small pieces/.test(text(m))));
});

test("a terminal resuming a session an idle headless pi holds takes it over, and the app's open stream follows without reconnecting", async (t) => {
	const { env, registry, terminal, openStream } = await setup(t);
	const rpc = await registry.create(env.workDir);
	const id = rpc.sessionId;
	const done = watch(rpc);
	await rpc.command({ type: "prompt", text: "first", mode: "send" });
	await done.next((m) => m.type === "event" && m.event.type === "agent_settled");
	const file = rpc.sessionFile as string;
	assert.equal(rpc.isBusy(), false);

	// The app has the session open over the real HTTP stream while the headless pi holds it.
	const sse = await openStream(id);
	const before = (await sse.next((m) => m.type === "snapshot")) as any;
	assert.equal(before.snapshot.handleKind, "rpc");

	const term = terminal(file);
	// The same connection gets a snapshot from the terminal's bridge, with no reload.
	const after = (await sse.next((m) => m.type === "snapshot" && (m as any).snapshot.handleKind === "bridge", 20_000)) as any;
	assert.equal(after.snapshot.sessionId, id);
	assert.equal(registry.get(id)?.kind, "bridge");
	assert.equal(registry.get(id)?.pid, term.pid);
	await until(() => registry.all().filter((h) => h.kind === "rpc").length === 0);

	// A prompt typed in the terminal now arrives as events on that same connection.
	term.send({ type: "prompt", message: "typed after takeover" });
	await sse.next((m) => m.type === "event" && (m as any).event.type === "message_end" && (m as any).event.message.role === "user" && /typed after takeover/.test(text((m as any).event.message)), 20_000);
	await sse.next((m) => m.type === "event" && (m as any).event.type === "agent_settled", 20_000);
});

test("a /new in the terminal moves the app's stream to the new session", async (t) => {
	const { registry, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	const from = h.sessionId;
	const stream = watch(h);
	assert.equal((await term.call({ type: "new_session" })).success, true);
	const snap = await stream.next((m) => m.type === "snapshot");
	const to = (snap as Extract<StreamMessage, { type: "snapshot" }>).snapshot.sessionId;
	assert.notEqual(to, from);
	assert.equal(registry.get(to), h);
	assert.equal(registry.get(from), undefined);
	await sleep(500);
	assert.equal(stream.items.some((m) => m.type === "handle_gone"), false);
	assert.equal(registry.all().filter((x) => x.kind === "bridge").length, 1);
});

test("quitting the terminal ends the session's live state", async (t) => {
	const { registry, terminal } = await setup(t);
	const term = terminal();
	await until(() => Boolean(bridgeFor(registry, term.pid)));
	const h = bridgeFor(registry, term.pid) as SessionHandle;
	const stream = watch(h);
	await term.quit();
	await stream.next((m) => m.type === "handle_gone");
	assert.deepEqual(registry.info(h.sessionId), { live: false, handleKind: null, state: "idle" });
});
