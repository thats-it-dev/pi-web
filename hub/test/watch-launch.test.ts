import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { launchFrame, launchOnPhone } from "../src/watch-launch.ts";

const UUID = "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b";

test("launchFrame is RelayToWatch + a framed AppRunState start for the uuid", () => {
	const f = launchFrame(UUID);
	assert.equal(f.length, 22);
	assert.equal(Buffer.from(f).toString("hex"), "01" + "0011" + "0034" + "01" + "6d55f4ea2ff6419ea2be1ebdfd4f8f0b");
});

test("launchFrame rejects a malformed uuid", () => {
	assert.throws(() => launchFrame("not-a-uuid"), /uuid/);
});

test("launchOnPhone sends exactly one binary frame to ws://host:port/ and resolves ok", async () => {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((r) => wss.once("listening", r));
	const got: { data: Buffer; binary: boolean }[] = [];
	let url = "";
	wss.on("connection", (ws, req) => {
		url = req.url ?? "";
		ws.on("message", (data, binary) => got.push({ data: data as Buffer, binary }));
	});
	const port = (wss.address() as AddressInfo).port;
	const r = await launchOnPhone("127.0.0.1", UUID, { port });
	assert.deepEqual(r, { ok: true });
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(url, "/");
	assert.equal(got.length, 1);
	assert.equal(got[0].binary, true);
	assert.deepEqual(new Uint8Array(got[0].data), launchFrame(UUID));
	await new Promise((r) => wss.close(r));
});

test("launchOnPhone resolves unreachable when nothing listens, within the timeout", async () => {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as AddressInfo).port;
	await new Promise((r) => s.close(r));
	const t = Date.now();
	const r = await launchOnPhone("127.0.0.1", UUID, { port, timeoutMs: 500 });
	assert.deepEqual(r, { ok: false, reason: "unreachable" });
	assert.ok(Date.now() - t < 1000);
});

test("launchOnPhone times out on a listener that never completes the handshake", async () => {
	const socks: Socket[] = [];
	const s = createServer((c) => socks.push(c));
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as AddressInfo).port;
	const t = Date.now();
	const r = await launchOnPhone("127.0.0.1", UUID, { port, timeoutMs: 200 });
	assert.deepEqual(r, { ok: false, reason: "unreachable" });
	assert.ok(Date.now() - t < 1000);
	for (const c of socks) c.destroy();
	await new Promise((r) => s.close(r));
});
