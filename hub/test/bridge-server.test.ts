import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { BridgeHello } from "../../shared/src/bridge.ts";
import { lineSplitter } from "../../shared/src/jsonl.ts";
import type { StreamMessage } from "../../shared/src/protocol.ts";
import type { BridgeHandle } from "../src/bridge-handle.ts";
import { startBridgeServer } from "../src/bridge-server.ts";
import type { HandleEvent } from "../src/handle.ts";
import { Recorder } from "./support/recorder.ts";

const state = (id: string) => ({ model: null, thinkingLevel: "off" as const, isStreaming: false, isCompacting: false, sessionId: id, messageCount: 0, pendingMessageCount: 0, autoCompactionEnabled: true });
const hello = (id: string, pid = 500, protocol = 1): BridgeHello => ({
	type: "hello",
	protocol,
	sessionId: id,
	sessionFile: null,
	cwd: "/w",
	pid,
	piVersion: "1.0.2",
	prompt: null,
	sync: { state: state(id), stats: null, thinkingLevels: ["off"], models: [], commands: [], messages: [] },
});

async function setup(t: TestContext, verdict: "attached" | "waiting" | "ignored" = "attached") {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-bsrv-"));
	const socketPath = join(dir, "data", "bridge.sock");
	const attached: BridgeHandle[] = []; // each handle once
	const calls: BridgeHandle[] = []; // every attachBridge call
	const attachBridge = (h: BridgeHandle) => {
		calls.push(h);
		if (!attached.includes(h)) attached.push(h);
		return verdict;
	};
	const server = await startBridgeServer({ socketPath, switchGraceMs: 150, helloTimeoutMs: 150, registry: { attachBridge } });
	t.after(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir, socketPath, attached, calls, server };
}

async function client(path: string) {
	const sock: Socket = createConnection(path);
	const got = new Recorder<any>();
	const closed = new Promise<void>((r) => sock.on("close", () => r()));
	sock.setEncoding("utf8");
	sock.on("data", lineSplitter((l) => got.push(JSON.parse(l))));
	sock.on("error", () => {});
	await new Promise<void>((r) => sock.on("connect", () => r()));
	return { sock, got, closed, send: (m: unknown) => sock.write(`${JSON.stringify(m)}\n`) };
}

function watch(h: BridgeHandle) {
	const stream = new Recorder<StreamMessage>();
	const events = new Recorder<HandleEvent>();
	h.subscribe((m) => stream.push(m));
	h.onEvent((e) => events.push(e));
	return { stream, events };
}

const until = async (cond: () => boolean) => {
	for (let i = 0; i < 200 && !cond(); i++) await sleep(5);
	assert.ok(cond(), "condition never became true");
};

test("the socket is private: 0600 inside a 0700 directory", async (t) => {
	const { socketPath } = await setup(t);
	assert.equal(statSync(socketPath).mode & 0o777, 0o600);
	assert.equal(statSync(join(socketPath, "..")).mode & 0o777, 0o700);
});

test("a stale socket file is replaced; a live hub on the socket is refused", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-bsrv-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const socketPath = join(dir, "bridge.sock");
	writeFileSync(socketPath, "left over by a crashed hub");
	const registry = { attachBridge: () => "attached" as const };
	const first = await startBridgeServer({ socketPath, registry });
	await assert.rejects(startBridgeServer({ socketPath, registry }), /Another pi-web hub/);
	await first.close();
});

test("hello attaches a BridgeHandle; events, commands and results flow both ways", async (t) => {
	const { socketPath, attached } = await setup(t);
	const c = await client(socketPath);
	c.send(hello("s-1"));
	await until(() => attached.length === 1);
	const h = attached[0];
	assert.deepEqual([h.sessionId, h.pid], ["s-1", 500]);
	const { stream } = watch(h);
	c.send({ type: "event", event: { type: "agent_start" } });
	await stream.next((m) => m.type === "event");
	const result = h.command({ type: "abort" });
	const cmd = await c.got.next((m) => m.type === "cmd");
	assert.deepEqual(cmd.command, { type: "abort" });
	c.send({ type: "result", id: cmd.id, ok: true });
	assert.equal((await result).ok, true);
	c.sock.destroy();
});

test("a connection that never says hello is dropped; a newer protocol is told to update", async (t) => {
	const { socketPath, attached } = await setup(t);
	const silent = await client(socketPath);
	await silent.closed;
	const future = await client(socketPath);
	future.send(hello("s-1", 500, 99));
	assert.match((await future.got.next((m) => m.type === "notice")).text, /protocol/);
	await future.closed;
	assert.equal(attached.length, 0);
});

test("bye(new) then hello on a new connection: the same handle follows the terminal to its new session", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const h = attached[0];
	const { stream, events } = watch(h);
	a.send({ type: "bye", reason: "new" });
	a.sock.end();
	const b = await client(socketPath);
	b.send(hello("s-2"));
	assert.deepEqual(await events.next((e) => e.type === "session_changed"), { type: "session_changed", from: "s-1", to: "s-2" });
	assert.equal(attached.length, 1);
	assert.equal(h.sessionId, "s-2");
	await sleep(250); // past the grace period
	assert.equal(stream.items.some((m) => m.type === "handle_gone"), false);
	b.sock.destroy();
});

test("the new runtime's hello can arrive before the old runtime's bye", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const { stream } = watch(attached[0]);
	const b = await client(socketPath);
	b.send(hello("s-2"));
	await stream.next((m) => m.type === "snapshot");
	a.send({ type: "bye", reason: "new" }); // late, from the replaced runtime: ignored
	a.send({ type: "event", event: { type: "agent_start" } });
	await sleep(250);
	assert.equal(attached[0].liveState(), "idle");
	assert.equal(stream.items.some((m) => m.type === "handle_gone"), false);
	b.send({ type: "event", event: { type: "agent_start" } });
	await stream.next((m) => m.type === "event");
	assert.equal(attached.length, 1);
	b.sock.destroy();
});

test("every hello from a terminal goes to the registry, so a terminal it let go can claim again with /resume", async (t) => {
	const { socketPath, attached, calls } = await setup(t, "waiting");
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => calls.length === 1);
	const { stream } = watch(attached[0]);
	a.send({ type: "bye", reason: "resume" });
	a.sock.end();
	const b = await client(socketPath);
	b.send(hello("s-1")); // the same session, re-read from disk
	await stream.next((m) => m.type === "snapshot");
	await until(() => calls.length === 2);
	assert.equal(calls[1], calls[0]); // the same handle, rebound first
	b.sock.destroy();
});

test("a switch that never completes ends the handle after the grace period", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const { stream } = watch(attached[0]);
	a.send({ type: "bye", reason: "resume" });
	a.sock.end();
	await stream.next((m) => m.type === "handle_gone");
});

test("quitting, or dropping the connection, ends the handle at once", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1", 1));
	const b = await client(socketPath);
	b.send(hello("s-2", 2));
	await until(() => attached.length === 2);
	const wa = watch(attached.find((h) => h.pid === 1) as BridgeHandle);
	const wb = watch(attached.find((h) => h.pid === 2) as BridgeHandle);
	a.send({ type: "bye", reason: "quit" });
	await wa.stream.next((m) => m.type === "handle_gone");
	b.sock.destroy();
	await wb.stream.next((m) => m.type === "handle_gone");
});

test("a connection the registry ignores is left alone", async (t) => {
	const { socketPath, attached } = await setup(t, "ignored");
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const { stream } = watch(attached[0]);
	a.send({ type: "event", event: { type: "agent_start" } });
	a.send(hello("s-1")); // a second hello on an ignored connection does nothing
	await sleep(100);
	assert.equal(stream.items.length, 0);
	assert.equal(attached.length, 1);
	a.sock.destroy();
});

test("a duplicate hello for a pid keeps one handle and delivers events once", async (t) => {
	const { socketPath, attached } = await setup(t);
	const a = await client(socketPath);
	a.send(hello("s-1"));
	await until(() => attached.length === 1);
	const { stream } = watch(attached[0]);
	const b = await client(socketPath);
	b.send(hello("s-1"));
	await stream.next((m) => m.type === "snapshot");
	b.send(hello("s-1")); // again, on the same connection
	await sleep(50);
	const before = stream.items.length;
	b.send({ type: "event", event: { type: "agent_start" } });
	await until(() => stream.items.length > before);
	await sleep(50);
	assert.equal(stream.items.length - before, 1);
	assert.equal(stream.items.filter((m) => m.type === "handle_gone").length, 0);
	assert.equal(attached.length, 1);
	b.sock.destroy();
});

test("a malformed message drops only that connection", async (t) => {
	const { socketPath, attached } = await setup(t);
	const bad = await client(socketPath);
	bad.sock.write("null\n");
	await bad.closed;
	const bad2 = await client(socketPath);
	const { sync: _sync, ...noSync } = hello("s-9", 9);
	bad2.send(noSync);
	await bad2.closed;
	const good = await client(socketPath);
	good.send(hello("s-1"));
	await until(() => attached.length >= 1);
	assert.equal(attached.at(-1)?.sessionId, "s-1");
	good.sock.destroy();
});
