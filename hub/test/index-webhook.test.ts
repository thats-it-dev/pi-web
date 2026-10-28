import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Dialog } from "../../shared/src/protocol.ts";
import type { HubConfig } from "../src/config.ts";
import { type IndexHeaders, ReplayCache, contentKey, handleIndexWebhook, readIndexHeaders, verifyIndex } from "../src/index-webhook.ts";
import { Viewers } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { type RingAlert, WatchService } from "../src/watch.ts";
import { FakeHandle } from "./support/fake-handle.ts";

const now = () => 1_700_000_000_000;
const good = (over: Partial<IndexHeaders> = {}): IndexHeaders => ({
	version: "1",
	trigger: "single-click-hold",
	delivery: "d-1",
	...over,
});

test("a request passes once; the same delivery id is a 409 replay", () => {
	const cache = new ReplayCache(undefined, now);
	assert.deepEqual(verifyIndex(good(), cache), { ok: true, isTest: false });
	assert.deepEqual(verifyIndex(good(), cache), { ok: false, status: 409, reason: "Duplicate delivery" });
});

test("a test event passes as isTest; a missing delivery id is accepted here (the route keys it by content)", () => {
	const cache = new ReplayCache(undefined, now);
	assert.deepEqual(verifyIndex(good({ test: "true", trigger: "test-event" }), cache), { ok: true, isTest: true });
	assert.deepEqual(verifyIndex(good({ delivery: undefined }), cache), { ok: true, isTest: false });
	assert.deepEqual(verifyIndex(good({ delivery: undefined }), cache), { ok: true, isTest: false });
});

test("a wrong version is 400; signature and timestamp headers are ignored", () => {
	assert.deepEqual(verifyIndex(good({ version: "2" }), new ReplayCache()), { ok: false, status: 400, reason: "Unsupported webhook version" });
	assert.deepEqual(verifyIndex(good({ signature: "00", timestamp: "abc" }), new ReplayCache()), { ok: true, isTest: false });
});

test("contentKey: same note same key; recordedAt, words or audio change it; none without recordedAt and audio", () => {
	const a = contentKey("1700000000000", "yes", Buffer.from("x"));
	assert.match(a ?? "", /^content-[0-9a-f]{32}$/);
	assert.equal(contentKey("1700000000000", "yes", Buffer.from("x")), a);
	assert.notEqual(contentKey("1700000000001", "yes", Buffer.from("x")), a);
	assert.notEqual(contentKey("1700000000000", "no", Buffer.from("x")), a);
	assert.notEqual(contentKey("1700000000000", "yes", Buffer.from("y")), a);
	assert.ok(contentKey(undefined, "yes", Buffer.from("x")));
	assert.equal(contentKey(undefined, "yes", undefined), null);
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
const cfg: HubConfig = { port: 0, internalPort: 0, hostname: "hub.test:7878", allowedLogin: "me@github", allowedOrigins: ["https://pi.thatsit.app"], idleMinutes: 20, maxHeadless: 6, piBin: "pi", dev: false, approvalMode: "manual",
	watchAlert: "auto", dataDir: root };
const RING = { host: "hub.test:7878", "tailscale-user-login": "me@github" };
const logs: string[] = [];
let n = 0;
const created: FakeHandle[] = [];
const idx = new SessionIndex(join(root, "sessions"));
const registry = new Registry({
	factory: { startRpc: async (o) => { const h = new FakeHandle(`s-${++n}`, o.cwd, o.sessionFile ?? null); created.push(h); return h; } },
	lookup: idx,
	maxHeadless: 50, // the closed-app tests make many sessions
	idleMs: 60_000,
});
const watch = new WatchService({ registry, index: idx, viewers: new Viewers(), home: root });
const server = createHubServer({ cfg, registry, index: idx, version: "t", home: root, log: (m) => logs.push(m), watch, now });
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
			"x-index-delivery": delivery,
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

test("rejects without the tailnet identity (403) or with the wrong host; no signature is needed; a replayed delivery is acknowledged (200) and ignored", async () => {
	const b = multipart({ transcription: "" });
	const s = signed(b, { delivery: "rej-1" });
	assert.equal((await post(port, { ...s.headers, "tailscale-user-login": "" }, b)).status, 403);
	assert.equal((await post(port, { ...s.headers, host: "evil.test" }, b)).status, 403);
	assert.equal((await post((bare.address() as AddressInfo).port, s.headers, b)).status, 503);
	assert.equal((await post(port, { ...s.headers, "x-index-signature": "00" }, b)).status, 200);
	assert.equal((await post(port, s.headers, b)).status, 200); // acknowledged, ignored
	assert.equal((await post(port, s.headers, b)).body, "");
	assert.ok(logs.some((l) => l === "index: duplicate delivery ignored"));
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

test("on-screen pi query + \"yes\" answers it", async () => {
	const { h, requestId } = await raise();
	watch.showing({ queryId: requestId, sessionId: h.sessionId });
	const b = multipart({ transcription: " allow \n", recordedAt: "1700000000000", client: "ios" });
	const s = signed(b);
	assert.deepEqual(await post(port, s.headers, b), { status: 200, body: "" });
	assert.ok(h.received.some((c) => c.type === "dialog_response" && (c as { value?: string }).value === "allow"));
	const j = sidecar(s.delivery);
	assert.equal(j.action, "answered");
	assert.equal(j.queryId, requestId);
	assert.equal(j.transcription, "allow");
	assert.equal(j.client, "ios");
	assert.equal(j.headers.signature, undefined);
	assert.equal(j.headers.delivery, s.delivery);
	watch.showing({ queryId: null, sessionId: null });
});

test("nothing on screen → new session: a session is created in <home>/pebble (folder made) and the transcription is its first prompt", async () => {
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

test("on-screen pi query + unmatched text keeps it and emits a notice frame", async () => {
	const { h, requestId } = await raise();
	watch.showing({ queryId: requestId, sessionId: h.sessionId });
	const frames: unknown[] = [];
	const off = watch.subscribe((f) => frames.push(f));
	const b = multipart({ transcription: "banana" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	off();
	assert.deepEqual(frames.filter((f) => (f as { type: string }).type === "notice"), [{ type: "notice", text: "Didn't catch that" }]);
	assert.ok(watch.pending().queries.some((q) => q.id === requestId));
	assert.equal(h.received.filter((c) => c.type === "dialog_response").length, 0);
	const j = sidecar(s.delivery);
	assert.equal(j.action, "no_match");
	assert.equal(j.queryId, requestId);
	assert.equal(typeof j.reason, "string");
	assert.ok(logs.includes(`index: ${s.delivery} no_match ${requestId} (options: allow, deny)`));
	watch.showing({ queryId: null, sessionId: null });
	settle(h);
});

test("on-screen ring-profile query + text resolves ring-answer", async () => {
	const outcomes: unknown[] = [];
	const q = watch.queries.raise({ source: "ring-profile", label: "ring", text: "ok?", options: ["yes", "no"], timeoutMs: 60_000, onOutcome: (o) => outcomes.push(o) });
	watch.showing({ queryId: q.id, sessionId: null });
	const b = multipart({ transcription: "go ahead" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.deepEqual(outcomes, [{ kind: "ring-answer", text: "go ahead" }]);
	assert.equal(sidecar(s.delivery).action, "answered");
	watch.showing({ queryId: null, sessionId: null });
});

test("open session, no query on screen → prompt to that session", async () => {
	const h = (await registry.create("/work/open")) as FakeHandle;
	watch.showing({ queryId: null, sessionId: h.sessionId });
	const before = created.length;
	const b = multipart({ transcription: "and then?" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.equal(created.length, before);
	assert.deepEqual(h.received, [{ type: "prompt", text: "and then?", mode: "send" }]);
	const j = sidecar(s.delivery);
	assert.equal(j.action, "prompted");
	assert.equal(j.sessionId, h.sessionId);
	assert.ok(logs.includes(`index: ${s.delivery} prompted ${h.sessionId}`));
	watch.showing({ queryId: null, sessionId: null });
});

test("a delivery without an id is named by its content key for its log line and files", async () => {
	const h = (await registry.create("/work/noid")) as FakeHandle;
	watch.showing({ queryId: null, sessionId: h.sessionId });
	const b = multipart({ transcription: "go on", recordedAt: "1700000000001" });
	const { "x-index-delivery": _drop, ...headers } = signed(b).headers;
	assert.equal((await post(port, headers, b)).status, 200);
	const line = logs.find((l) => l.endsWith(`prompted ${h.sessionId}`));
	const id = line?.match(/^index: (content-[0-9a-f]{32}) prompted /)?.[1];
	assert.ok(id, logs.slice(-3).join(" | "));
	assert.equal(sidecar(id).action, "prompted");
	watch.showing({ queryId: null, sessionId: null });
});

test("without a delivery id, a re-upload of the same note is acknowledged (200) and acts once; a different note still acts", async () => {
	const h = (await registry.create("/work/noid2")) as FakeHandle;
	watch.showing({ queryId: null, sessionId: h.sessionId });
	const noId = (b: Buffer) => {
		const { "x-index-delivery": _drop, ...headers } = signed(b).headers;
		return headers;
	};
	const audio = Buffer.from("same audio");
	const one = multipart({ transcription: "go on", recordedAt: "1700000000100" }, audio);
	assert.equal((await post(port, noId(one), one)).status, 200);
	const again = await post(port, noId(one), one);
	assert.deepEqual(again, { status: 200, body: "" });
	// Same words at another time, and the same time with other audio, are different notes.
	const later = multipart({ transcription: "go on", recordedAt: "1700000000200" }, audio);
	assert.equal((await post(port, noId(later), later)).status, 200);
	const other = multipart({ transcription: "go on", recordedAt: "1700000000100" }, Buffer.from("other audio"));
	assert.equal((await post(port, noId(other), other)).status, 200);
	assert.equal(h.received.filter((c) => c.type === "prompt").length, 3);
	watch.showing({ queryId: null, sessionId: null });
});

test("a new empty session from the watch, once shown, gets the next ring note as its first prompt", async () => {
	const sid = await watch.newSession();
	const h = registry.get(sid) as FakeHandle;
	assert.deepEqual(h.received, []); // never prompted
	watch.showing({ queryId: null, sessionId: sid });
	const before = created.length;
	const b = multipart({ transcription: "draft the release notes" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.equal(created.length, before);
	assert.deepEqual(h.received, [{ type: "prompt", text: "draft the release notes", mode: "send" }]);
	const j = sidecar(s.delivery);
	assert.equal(j.action, "prompted");
	assert.equal(j.sessionId, sid);
	watch.showing({ queryId: null, sessionId: null });
});

test("on-screen query gone at answer time → no prompt, no new session, notice \"Already answered\"", async () => {
	const h = (await registry.create("/work/race")) as FakeHandle;
	const real = watch.onScreen.bind(watch);
	watch.onScreen = () => ({ queryId: "dialog:gone:d9", sessionId: h.sessionId });
	const frames: unknown[] = [];
	const off = watch.subscribe((f) => frames.push(f));
	const before = created.length;
	const b = multipart({ transcription: "yes" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	off();
	watch.onScreen = real;
	assert.equal(created.length, before);
	assert.deepEqual(h.received, []);
	assert.deepEqual(frames.filter((f) => (f as { type: string }).type === "notice"), [{ type: "notice", text: "Already answered" }]);
	const j = sidecar(s.delivery);
	assert.equal(j.action, "gone");
	assert.equal(j.queryId, "dialog:gone:d9");
});

test("open session gone at prompt time → new session", async () => {
	watch.showing({ queryId: null, sessionId: "no-such-session" });
	const before = created.length;
	const b = multipart({ transcription: "hello again" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.equal(created.length, before + 1);
	assert.equal(sidecar(s.delivery).action, "new_session");
	watch.showing({ queryId: null, sessionId: null });
});

test("app open on Home + pending query not on screen → new session, query untouched", async () => {
	const { h, requestId } = await raise();
	const off = watch.subscribe(() => {}); // the app's stream: open, showing Home
	watch.showing({ queryId: null, sessionId: null });
	const before = created.length;
	const b = multipart({ transcription: "allow" });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	off();
	assert.equal(created.length, before + 1);
	assert.equal(h.received.filter((c) => c.type === "dialog_response").length, 0);
	assert.ok(watch.pending().queries.some((q) => q.id === requestId));
	assert.equal(sidecar(s.delivery).action, "new_session");
	settle(h);
});

// ---- app closed (spec §5): the note answers the oldest alerted select/confirm pi dialog ----

// A second service on its own clock: "closed" needs no app seen for the grace period.
let clock = 1_800_000_000_000;
const cviewers = new Viewers();
const cw = new WatchService({ registry, index: idx, viewers: cviewers, home: root, now: () => clock });
const alerts: RingAlert[] = [];
cw.onRingAlert((a) => alerts.push(a));
const creplays = new ReplayCache(); // one cache for the server, as in createHubServer
const csrv = createServer((req, res) => void handleIndexWebhook(req, res, { watch: cw, dataDir: root, replays: creplays, now: () => clock, log: (m) => logs.push(m) }));
await new Promise<void>((r) => csrv.listen(0, "127.0.0.1", r));
const cport = (csrv.address() as AddressInfo).port;
after(() => {
	cw.close();
	csrv.close();
});
const GRACE = 45_000;
const settleAll = () => {
	for (const h of registry.all()) if ((h as FakeHandle).dialogs?.length) settle(h as FakeHandle);
};
// A dialog on a new handle, seen by cw at the current clock; alerted unless told otherwise.
async function raiseOn(d: Dialog, o: { alert?: boolean } = {}): Promise<{ h: FakeHandle; id: string }> {
	const h = (await registry.create("/work/closed")) as FakeHandle;
	h.dialogs = [{ ...d }];
	h.state = "needs_you";
	h.busy = true;
	h.fire({ type: "state_changed" });
	const id = `dialog:${h.sessionId}:${d.id}`;
	assert.ok(cw.pending().queries.some((q) => q.id === id));
	if (o.alert !== false) cw.markDelivered(id);
	return { h, id };
}
// recordedAt defaults to the clock; null leaves it out, a string is sent as is.
async function ringClosed(transcription: string, recordedAt: number | string | null = clock, p = cport) {
	const b = multipart(recordedAt === null ? { transcription } : { transcription, recordedAt: String(recordedAt) });
	const s = signed(b);
	assert.equal((await post(p, s.headers, b)).status, 200);
	return sidecar(s.delivery);
}
const confirmD: Dialog = { id: "c1", method: "confirm", title: "Run the migration?" };
const inputD: Dialog = { id: "i1", method: "input", title: "Commit message?" };
const fresh = () => {
	settleAll();
	cw.showing({ queryId: null, sessionId: null }); // forget the last report; the clock jump below closes the app
	alerts.length = 0;
	clock += 10 * GRACE;
};

test("app closed + two alerted pi dialogs + a matching note → the oldest is answered, with one receipt", async () => {
	fresh();
	const a = await raiseOn(ask);
	clock += 1000;
	const b2 = await raiseOn(ask);
	const before = created.length;
	const j = await ringClosed("deny");
	assert.equal(created.length, before);
	assert.deepEqual(a.h.received.filter((c) => c.type === "dialog_response"), [{ type: "dialog_response", id: "d1", value: "deny" }]);
	assert.equal(b2.h.received.length, 0);
	assert.equal(j.action, "answered");
	assert.equal(j.queryId, a.id);
	assert.deepEqual(alerts.map((x) => [x.kind, x.query.id, x.kind === "answered" ? x.option : null]), [["answered", a.id, "deny"]]);
	assert.ok(logs.includes(`index: ${j.headers.delivery} answered ${a.id}`));
});

test("app closed + two alerted dialogs: the same note re-uploaded without a delivery id answers only one", async () => {
	fresh();
	const a = await raiseOn(ask);
	clock += 1000;
	const b2 = await raiseOn(ask);
	const body = multipart({ transcription: "allow", recordedAt: String(clock) }, Buffer.from("note audio"));
	const { "x-index-delivery": _drop, ...headers } = signed(body).headers;
	assert.equal((await post(cport, headers, body)).status, 200);
	assert.equal((await post(cport, headers, body)).status, 200); // acknowledged, ignored
	assert.equal(a.h.received.filter((c) => c.type === "dialog_response").length, 1);
	assert.equal(b2.h.received.length, 0);
	assert.deepEqual(alerts.map((x) => [x.kind, x.query.id]), [["answered", a.id]]);
});

test("app closed + unmatched note → no_match, nothing answered, one miss alert", async () => {
	fresh();
	const { h, id } = await raiseOn(ask);
	const before = created.length;
	const j = await ringClosed("banana");
	assert.equal(created.length, before);
	assert.equal(h.received.length, 0);
	assert.ok(cw.pending().queries.some((q) => q.id === id));
	assert.deepEqual(alerts.map((x) => [x.kind, x.query.id, x.query.options]), [["miss", id, ["allow", "deny"]]]);
	assert.equal(j.action, "no_match");
	assert.equal(j.queryId, id);
});

test("app closed + only a ring-profile query → new session, the ring query untouched", async () => {
	fresh();
	const outcomes: unknown[] = [];
	const q = cw.queries.raise({ source: "ring-profile", label: "ring", text: "ok?", options: ["yes", "no"], timeoutMs: 60_000, onOutcome: (o) => outcomes.push(o) });
	cw.markDelivered(q.id);
	const j = await ringClosed("yes");
	assert.deepEqual(outcomes, []);
	assert.deepEqual(alerts, []);
	assert.equal(j.action, "new_session");
	cw.skip(q.id);
});

test("app closed + only an input dialog → new session, the dialog untouched", async () => {
	fresh();
	const { h } = await raiseOn(inputD);
	const j = await ringClosed("remind me to buy milk");
	assert.equal(h.received.length, 0);
	assert.equal(j.action, "new_session");
});

test("app closed + an older input dialog and a newer confirm → the confirm is answered", async () => {
	fresh();
	const i = await raiseOn(inputD);
	clock += 1000;
	const c = await raiseOn(confirmD);
	const j = await ringClosed("yes");
	assert.equal(i.h.received.length, 0);
	assert.deepEqual(c.h.received, [{ type: "dialog_response", id: "c1", confirmed: true }]);
	assert.equal(j.action, "answered");
	assert.equal(j.queryId, c.id);
});

test("app closed + a dialog never alerted → new session, the dialog untouched", async () => {
	fresh();
	const { h } = await raiseOn(ask, { alert: false });
	const j = await ringClosed("allow");
	assert.equal(h.received.length, 0);
	assert.equal(j.action, "new_session");
});

test("app closed + the same note re-uploaded after a hub restart (fresh replay cache) answers nothing more", async () => {
	fresh();
	const a = await raiseOn(ask);
	clock += 1000;
	const b2 = await raiseOn(ask);
	const body = multipart({ transcription: "allow", recordedAt: String(clock) }, Buffer.from("restart audio"));
	const { "x-index-delivery": _drop, ...headers } = signed(body).headers;
	assert.equal((await post(cport, headers, body)).status, 200);
	const srv2 = createServer((req, res) => void handleIndexWebhook(req, res, { watch: cw, dataDir: root, replays: new ReplayCache(), now: () => clock, log: (m) => logs.push(m) }));
	await new Promise<void>((r) => srv2.listen(0, "127.0.0.1", r));
	try {
		assert.equal((await post((srv2.address() as AddressInfo).port, headers, body)).status, 200);
	} finally {
		srv2.close();
	}
	assert.equal(a.h.received.filter((c) => c.type === "dialog_response").length, 1);
	assert.equal(b2.h.received.length, 0);
	assert.ok(logs.includes("index: duplicate delivery ignored"));
});

test("app closed + a note recorded more than 10 min before it arrived → new session, the dialog untouched", async () => {
	fresh();
	const recordedAt = clock;
	const d = await raiseOn(ask);
	clock += 11 * 60_000;
	const j = await ringClosed("allow", recordedAt);
	assert.equal(d.h.received.length, 0);
	assert.equal(j.action, "new_session");
});

test("app closed + a dialog created after the note was recorded (past the skew) → not answered", async () => {
	fresh();
	const recordedAt = clock;
	clock += 5000;
	const late = await raiseOn(ask);
	const j = await ringClosed("allow", recordedAt);
	assert.equal(late.h.received.length, 0);
	assert.equal(j.action, "new_session");
	// Within the skew it is answered.
	fresh();
	const near = await raiseOn(ask);
	const j2 = await ringClosed("allow", clock - 1500);
	assert.equal(j2.action, "answered");
	assert.equal(j2.queryId, near.id);
});

test("a stream blip on a session: a note at once prompts that session; after the grace period it answers the dialog", async () => {
	fresh();
	const { h, id } = await raiseOn(ask);
	const s = (await registry.create("/work/blip")) as FakeHandle;
	const off = cw.subscribe(() => {});
	cw.showing({ queryId: null, sessionId: s.sessionId });
	off(); // the socket drops
	clock += 2000;
	assert.equal(cw.appOpen(), true);
	const j = await ringClosed("yes do it");
	assert.equal(j.action, "prompted");
	assert.equal(j.sessionId, s.sessionId);
	assert.equal(h.received.length, 0);
	clock += GRACE;
	assert.equal(cw.appOpen(), false);
	const j2 = await ringClosed("allow");
	assert.equal(j2.action, "answered");
	assert.equal(j2.queryId, id);
});

test("a stream blip on a query answers that query; on Home the note starts a session", async () => {
	fresh();
	const a = await raiseOn(ask);
	clock += 1000;
	const b2 = await raiseOn(confirmD);
	let off = cw.subscribe(() => {});
	cw.showing({ queryId: b2.id, sessionId: null });
	off();
	const j = await ringClosed("yes");
	assert.equal(j.action, "answered");
	assert.equal(j.queryId, b2.id);
	assert.equal(a.h.received.length, 0);
	// Nothing connected: the answer gets the closed branch's receipt.
	assert.deepEqual(alerts.map((x) => [x.kind, x.query.id, x.kind === "answered" ? x.option : null]), [["answered", b2.id, "yes"]]);
	alerts.length = 0;
	off = cw.subscribe(() => {});
	cw.showing({ queryId: null, sessionId: null });
	off();
	clock += 1000;
	const j2 = await ringClosed("allow");
	assert.equal(j2.action, "new_session");
	assert.equal(a.h.received.length, 0);
	assert.deepEqual(alerts, []);
});

test("a blip on a query: a miss gets the miss alert; with the stream still connected, only the notice", async () => {
	fresh();
	const { h, id } = await raiseOn(ask);
	let off = cw.subscribe(() => {});
	cw.showing({ queryId: id, sessionId: null });
	off();
	const j = await ringClosed("banana");
	assert.equal(j.action, "no_match");
	assert.deepEqual(alerts.map((x) => [x.kind, x.query.id]), [["miss", id]]);
	alerts.length = 0;
	const frames: unknown[] = [];
	off = cw.subscribe((f) => frames.push(f));
	cw.showing({ queryId: id, sessionId: null });
	assert.equal((await ringClosed("allow")).action, "answered");
	off();
	assert.deepEqual(alerts, []);
	assert.equal(h.received.length, 1);
});

test("a query answered elsewhere just before the note, still on the watch: gone and \"Already answered\", no new session", async () => {
	fresh();
	const { h, id } = await raiseOn(ask);
	const frames: unknown[] = [];
	const off = cw.subscribe((f) => frames.push(f));
	cw.showing({ queryId: id, sessionId: null });
	settle(h); // answered in the web app; the watch hasn't reported its next screen yet
	const before = created.length;
	const j = await ringClosed("allow");
	off();
	assert.equal(j.action, "gone");
	assert.equal(j.queryId, id);
	assert.equal(created.length, before);
	assert.deepEqual(frames.filter((f) => (f as { type: string }).type === "notice"), [{ type: "notice", text: "Already answered" }]);
});

test("in the grace with nothing connected, a last-shown query now held for the open web app is not answered", async () => {
	fresh();
	const { h, id } = await raiseOn(ask);
	const off = cw.subscribe(() => {});
	cw.showing({ queryId: id, sessionId: null });
	off();
	const leave = cviewers.add();
	const j = await ringClosed("allow");
	leave();
	assert.equal(j.action, "gone");
	assert.equal(h.received.length, 0);
	assert.deepEqual(alerts, []);
});

test("app closed + recordedAt in epoch seconds is read as seconds and recorded in ms", async () => {
	fresh();
	const { id } = await raiseOn(ask);
	const j = await ringClosed("allow", String(clock / 1000));
	assert.equal(j.action, "answered");
	assert.equal(j.queryId, id);
	assert.equal(j.recordedMs, clock);
	assert.equal((await ringClosed("deny", new Date(clock).toISOString())).recordedMs, clock);
	assert.equal((await ringClosed("deny", null)).recordedMs, undefined);
});

test("app closed + an alerted dialog but no usable recordedAt → new session, the dialog untouched", async () => {
	fresh();
	const { h } = await raiseOn(ask);
	assert.equal((await ringClosed("allow", null)).action, "new_session");
	assert.equal((await ringClosed("allow", "not a time")).action, "new_session");
	assert.equal(h.received.length, 0);
});

test("a restarted hub starts inside the grace period: a note at once doesn't answer an alerted dialog", async () => {
	fresh();
	const w = new WatchService({ registry, index: idx, viewers: new Viewers(), home: root, now: () => clock });
	const srv = createServer((req, res) => void handleIndexWebhook(req, res, { watch: w, dataDir: root, replays: new ReplayCache(), now: () => clock }));
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const p = (srv.address() as AddressInfo).port;
	try {
		const { h, id } = await raiseOn(ask);
		w.pending();
		w.markDelivered(id);
		clock += 30_000;
		const j = await ringClosed("allow", clock, p);
		assert.equal(j.action, "new_session");
		assert.equal(h.received.length, 0);
		clock += GRACE;
		const j2 = await ringClosed("allow", clock, p);
		assert.equal(j2.action, "answered");
		assert.equal(j2.queryId, id);
	} finally {
		srv.close();
		w.close();
	}
});

test("between long-polls the app still counts as open", async () => {
	fresh();
	const { h } = await raiseOn(ask);
	await cw.wait(-1); // a poll answered at once
	const ac = new AbortController();
	void cw.wait(cw.pending().cursor, 60_000, ac.signal);
	ac.abort(); // the poll's client went away
	clock += 3000;
	const j = await ringClosed("allow");
	assert.equal(j.action, "new_session");
	assert.equal(h.received.length, 0);
});

test("empty transcription keeps the audio and does nothing else", async () => {
	const audio = Buffer.from([0, 1, 2, 255, 13, 10, 7]);
	const before = created.length;
	const b = multipart({ transcription: "  " }, audio);
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.ok(readFileSync(join(root, "index", `${s.delivery}.m4a`)).equals(audio));
	assert.equal(sidecar(s.delivery).action, "kept_audio");
	assert.ok(logs.includes(`index: ${s.delivery} kept_audio`));
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
	const srv = createServer((req, res) => void handleIndexWebhook(req, res, { watch: failing, dataDir: root, replays: new ReplayCache(), now, log: (m) => lines.push(m) }));
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

test("a 9000-char transcription is cut to 8000 for pi and the sidecar, and logged", async () => {
	const b = multipart({ transcription: "x".repeat(9_000) });
	const s = signed(b);
	assert.equal((await post(port, s.headers, b)).status, 200);
	assert.equal(sidecar(s.delivery).transcription.length, 8_000);
	assert.equal((created[created.length - 1].received[0] as { text: string }).text.length, 8_000);
	assert.ok(logs.includes(`index: ${s.delivery} transcription cut to 8000 chars`));
});

test("a body over 25 MB is 413", async () => {
	const big = Buffer.alloc(25 * 1024 * 1024 + 1);
	const s = signed(big);
	const r = await post(port, s.headers, big).catch(() => ({ status: 413, body: "" }));
	assert.equal(r.status, 413);
});

test("only the newest `keep` deliveries are kept", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-index-keep-"));
	const srv = createServer((req, res) => void handleIndexWebhook(req, res, { watch, dataDir: dir, replays: new ReplayCache(), now, keep: 2 }));
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
