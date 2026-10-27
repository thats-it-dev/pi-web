import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import type { AgentMessage, Dialog, WatchStreamFrame } from "../../shared/src/protocol.ts";
import type { HubConfig } from "../src/config.ts";
import { Viewers } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { attachWatchStream } from "../src/watch-stream.ts";
import { WatchService } from "../src/watch.ts";
import { FakeHandle } from "./support/fake-handle.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-watch-stream-"));
mkdirSync(join(root, "sessions"));
const cfg: HubConfig = {
	port: 0,
	internalPort: 0,
	hostname: "hub.test:7878",
	allowedLogin: "me@github",
	allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	dev: false,
	approvalMode: "manual",
	watchAlert: "auto",
	dataDir: root,
};
const WATCH = { host: "hub.test:7878", "tailscale-user-login": "me@github" };

let n = 0;
const index = new SessionIndex(join(root, "sessions"));
const registry = new Registry({ factory: { startRpc: async (o) => new FakeHandle(`s-${++n}`, o.cwd, o.sessionFile ?? null) }, lookup: index, maxHeadless: 6, idleMs: 60_000 });
const watch = new WatchService({ registry, index, viewers: new Viewers(), home: root });
const server = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, log: () => {}, watch });
const logs: string[] = [];
const stream = attachWatchStream(server, { watch, cfg, log: (m) => logs.push(m), pingMs: 20 });
let port = 0;
before(async () => {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as AddressInfo).port;
});
after(() => {
	watch.close();
	server.close();
});

const ask: Dialog = { id: "d1", method: "select", title: "Allow git push?", message: "origin feat/x", options: ["allow", "deny"] };

async function raise(): Promise<{ h: FakeHandle; requestId: string }> {
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.dialogs = [{ ...ask }];
	h.state = "needs_you";
	h.busy = true;
	h.fire({ type: "state_changed" });
	return { h, requestId: `dialog:${h.sessionId}:d1` };
}

async function connect(headers: Record<string, string>, opts: { autoPong?: boolean } = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/watch/stream`, { headers, ...opts });
	const frames: WatchStreamFrame[] = [];
	const waiters: (() => void)[] = [];
	ws.on("message", (m) => {
		frames.push(JSON.parse(String(m)) as WatchStreamFrame);
		for (const w of waiters.splice(0)) w();
	});
	await new Promise<void>((r, rej) => {
		ws.once("open", () => r());
		ws.once("error", rej);
	});
	const next = async (pred: (f: any) => boolean, ms = 2000): Promise<any> => {
		const deadline = Date.now() + ms;
		for (;;) {
			const hit = frames.find(pred);
			if (hit) return hit;
			const left = deadline - Date.now();
			if (left <= 0) throw new Error("timed out waiting for a frame");
			await new Promise<void>((r) => {
				waiters.push(r);
				setTimeout(r, left).unref();
			});
		}
	};
	return { ws, frames, next };
}

test("an upgrade without the tailnet identity is refused with 403, and an unknown path with 404", async () => {
	const status = (path: string, headers: Record<string, string>) =>
		new Promise<number>((r) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
			ws.on("unexpected-response", (_req, res) => r(res.statusCode ?? 0));
			ws.on("error", () => {});
		});
	assert.equal(await status("/api/watch/stream", { host: "hub.test:7878" }), 403);
	assert.equal(await status("/api/watch/stream", { ...WATCH, host: "evil.test" }), 403);
	assert.equal(await status("/api/elsewhere", WATCH), 404);
	assert.equal(stream.clientCount(), 0);
	assert.ok(logs.some((l) => l.startsWith("rejected UPGRADE /api/watch/stream: ")));
});

test("a client gets the current pending frame on connect, then one per change", async () => {
	const c = await connect(WATCH);
	const first = await c.next((f) => f.type === "pending");
	assert.deepEqual(first.queries, []);
	assert.equal(stream.clientCount(), 1);
	assert.equal(watch.subscriberCount(), 1);
	const { h, requestId } = await raise();
	const f = await c.next((x) => x.type === "pending" && x.queries.length === 1);
	assert.equal(f.queries[0].id, requestId);
	h.close();
	c.ws.close();
});

test("a showing frame sets the hub's showing and selects the text session", async () => {
	const c = await connect(WATCH);
	const { h, requestId } = await raise();
	c.ws.send(JSON.stringify({ type: "showing", queryId: requestId, sessionId: h.sessionId }));
	await c.next((x) => x.type === "pending" && x.showing?.queryId === requestId);
	assert.equal(watch.pending().showing?.queryId, requestId);
	h.conv.partial = { role: "assistant", content: [{ type: "text", text: "streaming…" }] } as AgentMessage;
	h.conv.streaming = true;
	h.push({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } } });
	const t = await c.next((x) => x.type === "text");
	assert.deepEqual(t, { type: "text", sessionId: h.sessionId, text: "streaming…", streaming: true });
	h.close();
	c.ws.close();
});

test("a bad frame is ignored and logged; the socket stays open", async () => {
	const c = await connect(WATCH);
	await c.next((f) => f.type === "pending");
	const before = logs.filter((l) => l.includes("watch stream: ignored frame")).length;
	c.ws.send("not json");
	c.ws.send(JSON.stringify({ type: "nope" }));
	c.ws.send(JSON.stringify({ type: "showing", queryId: 5 }));
	const { h, requestId } = await raise();
	const f = await c.next((x) => x.type === "pending" && x.queries.some((r: { id: string }) => r.id === requestId));
	assert.ok(f);
	const ignored = () => logs.filter((l) => l.includes("watch stream: ignored frame")).length - before;
	for (let i = 0; i < 50 && ignored() < 3; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(ignored(), 3);
	h.close();
	c.ws.close();
});

test("a closed client is forgotten", async () => {
	const c = await connect(WATCH);
	await c.next((f) => f.type === "pending");
	c.ws.close();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(stream.clientCount(), 0);
	assert.equal(watch.subscriberCount(), 0);
});

test("the hub pings on the configured interval", async () => {
	const c = await connect(WATCH);
	const pinged = new Promise<void>((r) => c.ws.once("ping", () => r()));
	await Promise.race([pinged, new Promise((_, rej) => setTimeout(() => rej(new Error("no ping")), 500))]);
	c.ws.close();
});

test("a socket is dropped after two unanswered pings, not one", async () => {
	const slow = createServer();
	const slowStream = attachWatchStream(slow, { watch, cfg, log: () => {}, pingMs: 100 });
	await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
	const ws = new WebSocket(`ws://127.0.0.1:${(slow.address() as AddressInfo).port}/api/watch/stream`, { headers: WATCH, autoPong: false });
	const pings: number[] = [];
	ws.on("ping", () => pings.push(Date.now()));
	try {
		const closedAt = await new Promise<number>((r) => ws.on("close", () => r(Date.now())));
		assert.equal(pings.length, 2);
		assert.ok(closedAt - pings[0] >= 160, `closed ${closedAt - pings[0]} ms after the first ping`);
	} finally {
		slowStream.close();
		slow.close();
	}
});

test("stream.close() closes every client with 1001", async () => {
	const c = await connect(WATCH);
	const code = new Promise<number>((r) => c.ws.on("close", (code) => r(code)));
	stream.close();
	assert.equal(await code, 1001);
});
