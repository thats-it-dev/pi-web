import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HubConfig } from "../src/config.ts";
import { type NotesBody, type Outbox, createNotesOutbox, createOutbox } from "../src/notes-outbox.ts";
import { Viewers } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { WatchService } from "../src/watch.ts";
import { FakeHandle } from "./support/fake-handle.ts";

const NOW = 1_700_000_000_000;
const now = () => NOW;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// ---- the outbox ----

test("outbox retries until 2xx", async () => {
	const dir = tmp("pi-web-outbox-");
	const results = [false, false, true];
	const posted: NotesBody[] = [];
	let successes = 0;
	const box = createOutbox(dir, async (b) => {
		posted.push(b);
		const ok = results.shift() ?? false;
		if (ok) successes++;
		return ok;
	}, { intervalMs: 60_000 });
	after(() => box.stop());
	const body = { dedupeKey: "k/1", recordedAt: NOW, receivedAt: NOW, transcript: "hi", webhook: "notes" as const };
	assert.equal(await box.add("k/1", body), false); // the immediate try fails
	assert.deepEqual(readdirSync(dir), ["k_1.json"]);
	await box.flush(); // fails again
	assert.deepEqual(readdirSync(dir), ["k_1.json"]);
	await box.flush(); // succeeds
	assert.deepEqual(readdirSync(dir), []);
	await box.flush(); // nothing left to send
	assert.equal(successes, 1);
	assert.equal(posted.length, 3);
	assert.deepEqual(posted[2], body);
});

test("outbox: a thrown post counts as a failure; flushes never overlap", async () => {
	const dir = tmp("pi-web-outbox-");
	let calls = 0;
	let release: (ok: boolean) => void = () => {};
	let mode: "throw" | "hold" = "throw";
	const box = createOutbox(dir, (async () => {
		calls++;
		if (mode === "throw") throw new Error("ECONNREFUSED");
		return new Promise<boolean>((r) => (release = r));
	}), { intervalMs: 60_000 });
	after(() => box.stop());
	assert.equal(await box.add("a", { dedupeKey: "a", recordedAt: NOW, receivedAt: NOW, transcript: "", webhook: "notes" }), false);
	assert.ok(existsSync(join(dir, "a.json")));
	mode = "hold";
	const f1 = box.flush();
	const f2 = box.flush();
	assert.equal(f1, f2);
	await sleep(5);
	assert.equal(calls, 2);
	release(true);
	await f1;
	assert.ok(!existsSync(join(dir, "a.json")));
});

test("outbox: the interval retries on its own", async () => {
	const dir = tmp("pi-web-outbox-");
	let ok = false;
	let calls = 0;
	const box = createOutbox(dir, async () => (calls++, ok), { intervalMs: 20 });
	after(() => box.stop());
	await box.add("t", { dedupeKey: "t", recordedAt: NOW, receivedAt: NOW, transcript: "", webhook: "notes" });
	ok = true;
	await sleep(80);
	assert.ok(!existsSync(join(dir, "t.json")));
	box.stop();
	const n = calls;
	await sleep(50);
	assert.equal(calls, n);
});

test("createNotesOutbox: an empty ringProfileUrl makes no outbox", () => {
	const dir = tmp("pi-web-outbox-");
	assert.equal(createNotesOutbox("", dir), undefined);
	assert.ok(!existsSync(join(dir, "index", "outbox")));
	const box = createNotesOutbox("http://127.0.0.1:1", dir);
	assert.ok(box);
	box.stop();
	assert.ok(existsSync(join(dir, "index", "outbox")));
});

// ---- the route ----

const root = tmp("pi-web-notes-");
mkdirSync(join(root, "sessions"));
const cfg: HubConfig = { port: 0, internalPort: 0, hostname: "hub.test:7878", allowedLogin: "me@github", allowedOrigins: ["https://pi.thatsit.app"], idleMinutes: 20, maxHeadless: 6, piBin: "pi", dev: false, approvalMode: "manual",
	watchAlert: "auto", ringProfileUrl: "http://127.0.0.1:7880", dataDir: root };
const RING = { host: "hub.test:7878", "tailscale-user-login": "me@github" };
const logs: string[] = [];
const idx = new SessionIndex(join(root, "sessions"));
const started: FakeHandle[] = [];
const registry = new Registry({
	factory: { startRpc: async (o) => { const h = new FakeHandle(`s-${started.length + 1}`, o.cwd, o.sessionFile ?? null); started.push(h); return h; } },
	lookup: idx,
	maxHeadless: 10,
	idleMs: 60_000,
});
const watch = new WatchService({ registry, index: idx, viewers: new Viewers(), home: root });
const touched: string[] = [];
watch.prompt = (async () => (touched.push("prompt"), { ok: false })) as never;
watch.answer = (async () => (touched.push("answer"), { ok: false, reason: "gone" })) as never;
watch.startRingSession = (async () => (touched.push("start"), "never")) as never;

const forwarded: NotesBody[] = [];
let accept = true;
const outbox: Outbox = createOutbox(join(root, "index", "outbox"), async (b) => {
	forwarded.push(b);
	return accept;
}, { intervalMs: 60_000 });
const server = createHubServer({ cfg, registry, index: idx, version: "t", home: root, log: (m) => logs.push(m), watch, now, notesOutbox: outbox });
const disabledRoot = tmp("pi-web-notes-off-");
const disabled = createHubServer({ cfg: { ...cfg, ringProfileUrl: "", dataDir: disabledRoot }, registry, index: idx, version: "t", home: root, log: (m) => logs.push(m), now, notesOutbox: createNotesOutbox("", disabledRoot) });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => disabled.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
after(() => {
	outbox.stop();
	watch.close();
	server.close();
	disabled.close();
});

const BOUNDARY = "----ring";
function multipart(fields: Record<string, string>, audio?: Buffer): Buffer {
	const chunks: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
	if (audio) chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="audio"; filename="a.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`), audio, Buffer.from("\r\n"));
	chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
	return Buffer.concat(chunks);
}
function headers(delivery?: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		...RING,
		"content-type": `multipart/form-data; boundary=${BOUNDARY}`,
		"x-index-webhook-version": "1",
		"x-index-trigger": "double-click-hold",
		...(delivery ? { "x-index-delivery": delivery } : {}),
		...extra,
	};
}
function post(p: number, h: Record<string, string>, body: Buffer, path = "/api/index/notes"): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: p, method: "POST", path, headers: { ...h, "content-length": String(body.length) } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
		});
		req.on("error", reject);
		req.end(body);
	});
}
const sidecar = (dir: string, key: string) => JSON.parse(readFileSync(join(dir, "index", `${key}.json`), "utf8"));
// The forward runs after the 200; wait for its log line.
async function logged(line: string): Promise<void> {
	for (let i = 0; i < 100 && !logs.includes(line); i++) await sleep(5);
	assert.ok(logs.includes(line), `missing log line: ${line}`);
}

test("notes webhook forwards and never touches sessions", async () => {
	const { h } = await (async () => {
		const h = (await registry.create("/work/proj")) as FakeHandle;
		return { h };
	})();
	watch.showing({ queryId: null, sessionId: h.sessionId }); // a session is open on the watch
	const audio = Buffer.from("m4a-bytes");
	const b = multipart({ transcription: " remember the dentist \n", recordedAt: "1699999990", client: "ios" }, audio);
	const r = await post(port, headers("n-1"), b);
	assert.deepEqual(r, { status: 200, body: "" });
	await logged("notes: n-1 forwarded");
	watch.showing({ queryId: null, sessionId: null });
	assert.deepEqual(touched, []);
	assert.equal(started.length, 1); // only the one this test made
	assert.deepEqual(h.received, []);
	assert.deepEqual(forwarded.at(-1), {
		dedupeKey: "n-1",
		deliveryId: "n-1",
		recordedAt: 1_699_999_990_000,
		receivedAt: NOW,
		transcript: "remember the dentist",
		audioBase64: audio.toString("base64"),
		webhook: "notes",
	});
	const j = sidecar(root, "n-1");
	assert.equal(j.action, "forwarded");
	assert.equal(j.transcription, "remember the dentist");
	assert.equal(j.recordedMs, 1_699_999_990_000);
	assert.equal(j.client, "ios");
	assert.equal(j.headers.delivery, "n-1");
	assert.deepEqual(readFileSync(join(root, "index", "n-1.m4a")), audio);
	assert.deepEqual(readdirSync(join(root, "index", "outbox")), []);
});

test("without recordedAt the forward uses the hub's receivedAt; without a delivery id the key is the content key", async () => {
	const b = multipart({ transcription: "no time" }, Buffer.from("aud"));
	assert.equal((await post(port, headers(), b)).status, 200);
	const f = forwarded.at(-1);
	assert.ok(f);
	assert.match(f.dedupeKey, /^content-[0-9a-f]{32}$/);
	assert.equal(f.deliveryId, undefined);
	assert.equal(f.recordedAt, NOW);
	await logged(`notes: ${f.dedupeKey} forwarded`);
});

test("same content twice → forwarded once", async () => {
	const before = forwarded.length;
	const b = multipart({ transcription: "twice", recordedAt: "1700000000000" }, Buffer.from("same"));
	assert.equal((await post(port, headers(), b)).status, 200);
	assert.equal((await post(port, headers(), b)).status, 200);
	await sleep(20);
	assert.equal(forwarded.length, before + 1);
	assert.ok(logs.includes("notes: duplicate delivery ignored"));
	// The same delivery id again is acknowledged too.
	const c = multipart({ transcription: "by id" });
	assert.equal((await post(port, headers("n-dup"), c)).status, 200);
	assert.equal((await post(port, headers("n-dup"), c)).status, 200);
	await sleep(20);
	assert.equal(forwarded.length, before + 2);
});

test("a failed forward is queued in the outbox and still 200", async () => {
	accept = false;
	const b = multipart({ transcription: "later", recordedAt: "1700000000001" });
	assert.deepEqual(await post(port, headers("n-q"), b), { status: 200, body: "" });
	await logged("notes: n-q queued");
	assert.deepEqual(readdirSync(join(root, "index", "outbox")), ["n-q.json"]);
	assert.equal(sidecar(root, "n-q").action, "forwarded");
	accept = true;
	await outbox.flush();
	assert.deepEqual(readdirSync(join(root, "index", "outbox")), []);
});

test("ringProfileUrl \"\" → stored, not forwarded", async () => {
	const before = forwarded.length;
	const b = multipart({ transcription: "kept here", recordedAt: "1700000000002" }, Buffer.from("a"));
	assert.equal((await post((disabled.address() as AddressInfo).port, headers("n-off"), b)).status, 200);
	await logged("notes: n-off stored");
	assert.equal(forwarded.length, before);
	assert.equal(sidecar(disabledRoot, "n-off").action, "stored");
	assert.ok(existsSync(join(disabledRoot, "index", "n-off.m4a")));
	assert.ok(!existsSync(join(disabledRoot, "index", "outbox")));
});

test("notes: tailnet identity required; wrong version 400; test event 200 and nothing forwarded", async () => {
	const before = forwarded.length;
	const b = multipart({ transcription: "x" });
	assert.equal((await post(port, { ...headers("n-x"), "tailscale-user-login": "" }, b)).status, 403);
	assert.equal((await post(port, headers("n-v", { "x-index-webhook-version": "2" }), b)).status, 400);
	assert.deepEqual(await post(port, headers("n-t", { "x-index-test": "true" }), b), { status: 200, body: "" });
	assert.ok(logs.includes("notes: test event ok"));
	assert.equal((await post(port, { ...headers("n-p"), "content-type": "text/plain" }, b)).status, 200);
	await sleep(20);
	assert.equal(forwarded.length, before);
});
