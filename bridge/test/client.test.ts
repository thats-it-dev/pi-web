import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeHub } from "../../hub/test/support/fake-hub.ts";
import { Recorder } from "../../hub/test/support/recorder.ts";
import { BridgeClient, socketPath } from "../client.ts";

test("socket path: env override, then data dir, then ~/.config/pi-web", () => {
	assert.equal(socketPath({ PI_WEB_BRIDGE_SOCKET: "/x/s.sock", PI_WEB_DATA_DIR: "/d" }), "/x/s.sock");
	assert.equal(socketPath({ PI_WEB_DATA_DIR: "/d" }), "/d/bridge.sock");
	assert.match(socketPath({}), /\/\.config\/pi-web\/bridge\.sock$/);
});

function setup(t: import("node:test").TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-client-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "bridge.sock");
	const opened: number[] = [];
	const received = new Recorder<any>();
	const client = new BridgeClient({ path, minDelayMs: 20, maxDelayMs: 80, onOpen: () => opened.push(Date.now()), onMessage: (m) => received.push(m) });
	t.after(() => client.stop());
	return { path, client, opened, received };
}

test("with no hub it keeps retrying quietly, then connects once the hub appears", async (t) => {
	const { path, client, opened } = setup(t);
	client.start();
	assert.equal(client.send({ type: "bye", reason: "quit" }), false); // nothing to send to yet
	await sleep(150);
	assert.equal(opened.length, 0);
	const hub = await fakeHub(path);
	t.after(() => hub.close());
	for (let i = 0; i < 50 && opened.length === 0; i++) await sleep(10);
	assert.equal(opened.length, 1);
	assert.equal(client.send({ type: "bye", reason: "quit" }), true);
	assert.deepEqual(await hub.messages.next((m) => m.type === "bye"), { type: "bye", reason: "quit" });
});

test("messages from the hub arrive parsed, one per line", async (t) => {
	const { path, client, received } = setup(t);
	const hub = await fakeHub(path);
	t.after(() => hub.close());
	client.start();
	for (let i = 0; i < 50 && hub.connections() === 0; i++) await sleep(10);
	hub.send({ type: "notice", text: "a b" }); // U+2028 must not split the record
	hub.send({ type: "cmd", id: "1", command: { type: "abort" } });
	assert.deepEqual(await received.next((m) => m.type === "notice"), { type: "notice", text: "a b" });
	assert.equal((await received.next((m) => m.type === "cmd")).id, "1");
});

test("a dropped connection reconnects and opens again; stop() ends retrying", async (t) => {
	const { path, client, opened } = setup(t);
	const hub = await fakeHub(path);
	t.after(() => hub.close());
	client.start();
	for (let i = 0; i < 50 && opened.length < 1; i++) await sleep(10);
	hub.dropClients();
	for (let i = 0; i < 100 && opened.length < 2; i++) await sleep(10);
	assert.equal(opened.length, 2);
	client.stop();
	hub.dropClients();
	await sleep(200);
	assert.equal(opened.length, 2);
	assert.equal(hub.connections(), 2);
});

test("data that arrives after stop() never reaches onMessage", async (t) => {
	const { path, client, opened, received } = setup(t);
	const hub = await fakeHub(path);
	t.after(() => hub.close());
	client.start();
	for (let i = 0; i < 50 && opened.length === 0; i++) await sleep(10);
	hub.send({ type: "notice", text: "too late" }); // still in flight when the client stops
	client.stop();
	await sleep(100);
	assert.deepEqual(received.items, []);
});
