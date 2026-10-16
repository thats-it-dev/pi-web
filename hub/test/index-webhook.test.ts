import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Dialog } from "../../shared/src/protocol.ts";
import type { HubConfig } from "../src/config.ts";
import { type IndexHeaders, ReplayCache, handleIndexWebhook, readIndexHeaders, signIndex, verifyIndex } from "../src/index-webhook.ts";
import { Viewers } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { WatchService } from "../src/watch.ts";
import { FakeHandle } from "./support/fake-handle.ts";

const body = Buffer.from("x");
const secret = "s3c";
const now = () => 1_700_000_000_000;
const good = (over: Partial<IndexHeaders> = {}): IndexHeaders => ({
	version: "1",
	trigger: "single-click-hold",
	timestamp: "1700000000",
	delivery: "d-1",
	signature: signIndex(secret, "1700000000", "d-1", "single-click-hold", false, body),
	...over,
});

test("a correctly signed request passes once; the same delivery id is a 409 replay", () => {
	const cache = new ReplayCache(undefined, now);
	assert.deepEqual(verifyIndex(good(), body, secret, cache, now), { ok: true, isTest: false });
	const again = verifyIndex(good(), body, secret, cache, now);
	assert.deepEqual(again, { ok: false, status: 409, reason: "Duplicate delivery" });
});

test("test events sign with '1' and pass as isTest", () => {
	const signature = signIndex(secret, "1700000000", "d-1", "test-event", true, body);
	const h = good({ test: "true", trigger: "test-event", signature });
	assert.deepEqual(verifyIndex(h, body, secret, new ReplayCache(), now), { ok: true, isTest: true });
	const wrong = good({ test: "true", trigger: "test-event" });
	assert.equal(verifyIndex(wrong, body, secret, new ReplayCache(), now).ok, false);
});

test("wrong version, stale timestamp, bad and missing signature, bad timestamp", () => {
	const run = (h: IndexHeaders) => verifyIndex(h, body, secret, new ReplayCache(), now);
	assert.deepEqual(run(good({ version: "2" })), { ok: false, status: 400, reason: "Unsupported webhook version" });
	const stale = signIndex(secret, "1699999699", "d-1", "single-click-hold", false, body);
	assert.deepEqual(run(good({ timestamp: "1699999699", signature: stale })), { ok: false, status: 401, reason: "Expired request" });
	const edge = signIndex(secret, "1699999700", "d-1", "single-click-hold", false, body);
	assert.equal(run(good({ timestamp: "1699999700", signature: edge })).ok, true);
	assert.deepEqual(run(good({ signature: "00" })), { ok: false, status: 401, reason: "Invalid signature" });
	assert.deepEqual(run(good({ signature: undefined })), { ok: false, status: 401, reason: "Missing signature" });
	assert.deepEqual(run(good({ timestamp: "abc" })), { ok: false, status: 400, reason: "Invalid timestamp" });
});

test("signIndex matches the documented prefix", () => {
	const want = createHmac("sha256", secret).update(Buffer.concat([Buffer.from("v1\n1700000000\nd-1\nsingle-click-hold\n0\n", "utf8"), body])).digest("hex");
	assert.equal(signIndex(secret, "1700000000", "d-1", "single-click-hold", false, body), want);
});

test("replay cache forgets ids after the ttl", () => {
	let t = 0;
	const cache = new ReplayCache(1000, () => t);
	assert.equal(cache.seen("a"), false);
	t = 999;
	assert.equal(cache.seen("a"), true);
	t = 2000;
	assert.equal(cache.seen("a"), false);
});

test("readIndexHeaders reads lowercase names and takes the first array element", () => {
	const h = readIndexHeaders({
		"x-index-webhook-version": "1",
		"x-index-trigger": ["double-click-hold", "x"],
		"x-index-test": "true",
		"x-index-signature": "ab",
		"x-index-timestamp": "5",
		"x-index-delivery": "d",
		"x-audio-size": "9",
	});
	assert.deepEqual(h, { version: "1", trigger: "double-click-hold", test: "true", signature: "ab", timestamp: "5", delivery: "d", audioSize: "9" });
});

// ---- the route ----

const root = mkdtempSync(join(tmpdir(), "pi-web-index-"));
mkdirSync(join(root, "sessions"));
const cfg: HubConfig = { port: 0, hostname: "hub.test:7878", allowedLogin: "me@github", allowedOrigins: ["https://pi.thatsit.app"], idleMinutes: 20, maxHeadless: 6, piBin: "pi", dev: false, approvalMode: "manual", dataDir: root };
const RING = { host: "hub.test:7878", "tailscale-user-login": "me@github" };
const secrets = { token: "t0k", indexSecret: secret };
const logs: string[] = [];
let n = 0;
const created: FakeHandle[] = [];
const idx = new SessionIndex(join(root, "sessions"));
const registry = new Registry({
	factory: { startRpc: async (o) => { const h = new FakeHandle(`s-${++n}`, o.cwd, o.sessionFile ?? null); created.push(h); return h; } },
	lookup: idx,
	maxHeadless: 6,
	idleMs: 60_000,
});
const watch = new WatchService({ registry, index: idx, viewers: new Viewers(), home: root });
const server = createHubServer({ cfg, registry, index: idx, version: "t", home: root, log: (m) => logs.push(m), watch, secrets, now });
const bare = createHubServer({ cfg, registry, index: idx, version: "t", home: root, log: () => {} });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
after(() => {
	watch.close();
	server.close();
	bare.close();
});

const BOUNDARY = "----ring";
function multipart(fields: Record<string, string>, audio?: Buffer): Buffer {
	const chunks: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
	if (audio) chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="audio"; filename="a.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`), audio, Buffer.from("\r\n"));
	chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
	return Buffer.concat(chunks);
}

interface Sent { status: number; body: string }
function post(p: number, headers: Record<string, string>, body: Buffer): Promise<Sent> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: p, method: "POST", path: "/api/index/webhook", headers: { ...headers, "content-length": String(body.length) } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

let seq = 0;
function signed(body: Buffer, o: { delivery?: string; test?: boolean; contentType?: string } = {}) {
	const delivery = o.delivery ?? `del-${++seq}`;
	const trigger = o.test ? "test-event" : "single-click-hold";
	return {
		delivery,
		headers: {
			...RING,
			"content-type": o.contentType ?? `multipart/form-data; boundary=${BOUNDARY}`,
			"x-index-webhook-version": "1",
			"x-index-trigger": trigger,
			"x-index-timestamp": "1700000000",
			"x-index-delivery": delivery,
			"x-index-signature": signIndex(secret, "1700000000", delivery, trigger, !!o.test, body),
			...(o.test ? { "x-index-test": "true" } : {}),
		} as Record<string, string>,
	};
}
const sidecar = (delivery: string) => JSON.parse(readFileSync(join(root, "index", `${delivery}.json`), "utf8"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ask: Dialog = { id: "d1", method: "select", title: "Allow git push?", message: "origin feat/x", options: ["allow", "deny"] };

async function raise(): Promise<{ h: FakeHandle; requestId: string }> {
	const h = (await registry.create("/work/proj")) as FakeHandle;
	h.dialogs = [{ ...ask }];
	h.state = "needs_you";
	h.busy = true;
	h.fire({ type: "state_changed" });
	return { h, requestId: `dialog:${h.sessionId}:d1` };
}
const settle = (h: FakeHandle) => {
	h.dialogs = [];
	h.state = "idle";
	h.busy = false;
	h.fire({ type: "state_changed" });
};

test("rejects without the tailnet identity (403) and with a bad signature (401); a replayed delivery is 409", async () => {
	const b = multipart({ transcription: "allow" });
	const s = signed(b, { delivery: "rej-1" });
	assert.equal((await post(port, { ...s.headers, "tailscale-user-login": "" }, b)).status, 403);
	assert.equal((await post(port, { ...s.headers, "x-index-signature": "00" }, b)).status, 401);
	assert.equal((await post(port, { ...s.headers, "x-index-signature": "00" }, b)).body, JSON.stringify({ error: "Invalid signature" }));
	assert.equal((await post((bare.address() as AddressInfo).port, s.headers, b)).status, 503);
	const emptyB = multipart({ transcription: "" });
	const e = signed(emptyB, { delivery: "rej-2" });
	assert.equal((await post(port, e.headers, emptyB)).status, 200);
	assert.equal((await post(port, e.headers, emptyB)).status, 409);
	assert.ok(logs.some((l) => l === "index: rejected (Invalid signature)"));
});

test("a test event is 200 with an empty body and writes nothing", async () => {
	const b = multipart({ transcription: "allow" });
	const s = signed(b, { test: true });
	const before = existsSync(join(root, "index")) ? readdirSync(join(root, "index")).length : 0;
	const r = await post(port, s.headers, b);
	assert.deepEqual(r, { status: 200, body: "" });
	assert.equal(existsSync(join(root, "index")) ? readdirSync(join(root, "index")).length : 0, before);
	assert.ok(logs.includes("index: test event ok"));
});

test("with a dialog showing, the transcription answers it", async () => {
	const { h, requestId } = await raise();
	watch.showing(requestId, h.sessionId);
	const b = multipart({ transcription: " allow \n", recordedAt: "1700000000000", client: "ios" });
	const s = signed(b);
	assert.deepEqual(await post(port, s.headers, b), { status: 200, body: "" });
	assert.ok(h.received.some((c) => c.type === "dialog_response" && (c as { value?: string }).value === "allow"));
	const j = sidecar(s.delivery);
	assert.equal(j.action, "answered");
	assert.equal(j.requestId, requestId);
	assert.equal(j.transcription, "allow");
	assert.equal(j.client, "ios");
	assert.equal(j.headers.signature, undefined);
	assert.equal(j.headers.delivery, s.delivery);
	watch.showing(null);
});

test("with nothing pending, a session is created in <home>/pebble (folder made) and the transcription is its first prompt", async () => {
	const before = created.length;
	const b = multipart({ transcription: "what is the weather" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.ok(existsSync(join(root, "pebble")));
	assert.equal(created.length, before + 1);
	const h = created[created.length - 1];
	assert.equal(h.cwd, join(root, "pebble"));
	assert.deepEqual(h.received, [{ type: "prompt", text: "what is the weather", mode: "send" }]);
	const j = sidecar(s.delivery);
	assert.equal(j.action, "new_session");
	assert.equal(j.sessionId, h.sessionId);
});

test("a transcription that matches no option is logged and nothing reaches pi", async () => {
	const { h, requestId } = await raise();
	watch.showing(requestId, h.sessionId);
	const b = multipart({ transcription: "banana" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.equal(h.received.filter((c) => c.type === "dialog_response").length, 0);
	const j = sidecar(s.delivery);
	assert.equal(j.action, "no_match");
	assert.equal(j.requestId, requestId);
	assert.equal(typeof j.reason, "string");
	watch.showing(null);
	settle(h);
});

test("empty transcription keeps the audio and does nothing else", async () => {
	const audio = Buffer.from([0, 1, 2, 255, 13, 10, 7]);
	const before = created.length;
	const b = multipart({ transcription: "  " }, audio);
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.ok(readFileSync(join(root, "index", `${s.delivery}.m4a`)).equals(audio));
	assert.equal(sidecar(s.delivery).action, "kept_audio");
	assert.equal(created.length, before);
});

test("a non-multipart body or one with neither transcription nor audio is 200, logged, and sends nothing", async () => {
	const before = created.length;
	const plain = Buffer.from("hello");
	const p = signed(plain, { contentType: "text/plain" });
	assert.deepEqual(await post(port, p.headers, plain), { status: 200, body: "" });
	const b = multipart({ client: "ios" });
	const s = signed(b);
	assert.deepEqual(await post(port, s.headers, b), { status: 200, body: "" });
	assert.equal(sidecar(s.delivery).action, "kept_audio");
	assert.equal(created.length, before);
	assert.ok(logs.some((l) => l.startsWith("index: ") && l.includes("multipart")));
});

test("a pi failure is logged and still 200, with the sidecar recording the error", async () => {
	const failing = new WatchService({ registry, index: idx, viewers: new Viewers(), home: root });
	failing.startRingSession = async () => { throw new Error("pi is down"); };
	const lines: string[] = [];
	const srv = createServer((req, res) => void handleIndexWebhook(req, res, { watch: failing, secret, dataDir: root, now, log: (m) => lines.push(m) }));
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const b = multipart({ transcription: "go" });
	const s = signed(b);
	const r = await post((srv.address() as AddressInfo).port, s.headers, b);
	srv.close();
	failing.close();
	assert.deepEqual(r, { status: 200, body: "" });
	assert.equal(sidecar(s.delivery).action, "error");
	assert.equal(sidecar(s.delivery).reason, "pi is down");
	assert.ok(lines.some((l) => l === "index: decide: pi is down"));
});

test("a body over 25 MB is 413", async () => {
	const big = Buffer.alloc(25 * 1024 * 1024 + 1);
	const s = signed(big);
	const r = await post(port, s.headers, big).catch(() => ({ status: 413, body: "" }));
	assert.equal(r.status, 413);
});

test("only the newest `keep` deliveries are kept", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-index-keep-"));
	const srv = createServer((req, res) => void handleIndexWebhook(req, res, { watch, secret, dataDir: dir, now, keep: 2 }));
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	for (const d of ["k-1", "k-2", "k-3"]) {
		const b = multipart({ transcription: "" }, Buffer.from(d));
		const s = signed(b, { delivery: d });
		assert.equal((await post((srv.address() as AddressInfo).port, s.headers, b)).status, 200);
		await sleep(10);
	}
	srv.close();
	assert.deepEqual(readdirSync(join(dir, "index")).sort(), ["k-2.json", "k-2.m4a", "k-3.json", "k-3.m4a"]);
});
