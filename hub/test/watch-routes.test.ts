import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Dialog } from "../../shared/src/protocol.ts";
import type { HubConfig } from "../src/config.ts";
import { Viewers } from "../src/push-watch.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { WatchService } from "../src/watch.ts";
import type { launchOnPhone } from "../src/watch-launch.ts";
import { FakeHandle } from "./support/fake-handle.ts";
import { call } from "./support/http.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-watch-routes-"));
mkdirSync(join(root, "sessions"));
const cfg: HubConfig = {
	port: 0,
	hostname: "hub.test:7878",
	allowedLogin: "me@github",
	allowedOrigins: ["https://pi.thatsit.app"],
	idleMinutes: 20,
	maxHeadless: 6,
	piBin: "pi",
	dev: false,
	approvalMode: "manual",
	dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };
const WATCH = { host: "hub.test:7878", "tailscale-user-login": "me@github" };

let n = 0;
const index = new SessionIndex(join(root, "sessions"));
const registry = new Registry({ factory: { startRpc: async (o) => new FakeHandle(`s-${++n}`, o.cwd, o.sessionFile ?? null) }, lookup: index, maxHeadless: 6, idleMs: 60_000 });
const watch = new WatchService({ registry, index, viewers: new Viewers(), home: root });
let clock = 1_000_000;
let fetches: string[] = [];
let upstream: "ok" | "fail" | "throw" = "ok";
const fetchFn = (async (input: string | URL | Request) => {
	fetches.push(String(input));
	if (upstream === "throw") throw new Error("offline");
	if (upstream === "fail") return new Response("no", { status: 500 });
	return new Response(JSON.stringify({ current: { temperature_2m: 11.5, weather_code: 3 } }), { status: 200 });
}) as typeof fetch;
const server = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, log: () => {}, watch, fetchFn, now: () => clock });
const bare = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, log: () => {} });
let port = 0;
let barePort = 0;
before(async () => {
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
	port = (server.address() as AddressInfo).port;
	barePort = (bare.address() as AddressInfo).port;
});
after(() => {
	watch.close();
	server.close();
	bare.close();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ask: Dialog = { id: "d1", method: "select", title: "Allow git push?", message: "origin feat/x", options: ["allow", "deny"] };

async function raise(existing?: FakeHandle): Promise<{ h: FakeHandle; requestId: string }> {
	const h = existing ?? ((await registry.create("/work/proj")) as FakeHandle);
	h.dialogs = [{ ...ask }];
	h.state = "needs_you";
	h.busy = true;
	h.fire({ type: "state_changed" });
	return { h, requestId: `dialog:${h.sessionId}:d1` };
}

test("watch routes need the tailnet identity and not an Origin; other routes still need an Origin", async () => {
	assert.equal((await call(port, "GET", "/api/watch/pending", { ...WATCH, "tailscale-user-login": undefined })).status, 403);
	assert.equal((await call(port, "GET", "/api/watch/pending", { ...WATCH, host: "evil.test" })).status, 403);
	assert.equal((await call(port, "GET", "/api/watch/pending", WATCH)).status, 200);
	assert.equal((await call(port, "GET", "/api/watch/pending", { ...WATCH, origin: "https://evil.example" })).status, 200);
	assert.equal((await call(port, "GET", "/api/sessions", WATCH)).status, 403);
	assert.equal((await call(port, "GET", "/api/watch/nothing", WATCH)).status, 404);
	assert.equal((await call(barePort, "GET", "/api/watch/pending", WATCH)).status, 503);
	assert.equal((await call(barePort, "GET", "/api/watch/pending", { ...WATCH, "tailscale-user-login": undefined })).status, 403);
	assert.equal((await call(barePort, "GET", "/api/watch/pending", { ...WATCH, host: "evil.test" })).status, 403);
});

test("pending without wait returns at once; with wait=1 it returns when a dialog is raised", async () => {
	const h = (await registry.create("/work/proj")) as FakeHandle;
	const first = await call(port, "GET", "/api/watch/pending", WATCH);
	assert.equal(first.headers["cache-control"], "no-store");
	const since = first.body.cursor;
	const started = call(port, "GET", `/api/watch/pending?since=${since}&wait=1`, WATCH);
	await sleep(50);
	const { requestId } = await raise(h);
	const r = await Promise.race([started, sleep(2000).then(() => null)]);
	assert.ok(r, "long-poll did not return");
	assert.equal(r.status, 200);
	assert.equal(r.body.requests.length, 1);
	assert.equal(r.body.requests[0].id, requestId);
	assert.ok(r.body.cursor > since);
	await call(port, "POST", "/api/watch/dismiss", WATCH, { requestId });
});

test("a pending long-poll whose client disconnects is forgotten", async () => {
	const { cursor } = (await call(port, "GET", "/api/watch/pending", WATCH)).body;
	assert.equal(watch.waiterCount(), 0);
	const req = request({ host: "127.0.0.1", port, path: `/api/watch/pending?since=${cursor}&wait=1`, headers: WATCH });
	req.on("error", () => {});
	req.end();
	for (let i = 0; i < 50 && watch.waiterCount() === 0; i++) await sleep(10);
	assert.equal(watch.waiterCount(), 1);
	req.destroy();
	for (let i = 0; i < 50 && watch.waiterCount() > 0; i++) await sleep(10);
	assert.equal(watch.waiterCount(), 0);
});

test("answer: option, text no_match with options, both or neither -> 400", async () => {
	const { h, requestId } = await raise();
	const bad = await call(port, "POST", "/api/watch/answer", WATCH, { requestId, option: "maybe" });
	assert.deepEqual([bad.status, bad.body], [200, { ok: false, reason: "no_match", options: ["allow", "deny"] }]);
	assert.equal((await call(port, "POST", "/api/watch/answer", WATCH, { requestId, option: "allow", text: "x" })).status, 400);
	assert.equal((await call(port, "POST", "/api/watch/answer", WATCH, { requestId })).status, 400);
	assert.equal((await call(port, "POST", "/api/watch/answer", WATCH, { option: "allow" })).status, 400);
	const ok = await call(port, "POST", "/api/watch/answer", WATCH, { requestId, option: "allow" });
	assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
	assert.ok(h.received.some((c) => c.type === "dialog_response"));
	const gone = await call(port, "POST", "/api/watch/answer", WATCH, { requestId, option: "allow" });
	assert.deepEqual(gone.body, { ok: false, reason: "gone" });
});

test("showing, dismiss, prompt, model, sessions, history, models round-trip", async () => {
	const { h, requestId } = await raise();
	const sid = h.sessionId;
	assert.deepEqual((await call(port, "POST", "/api/watch/showing", WATCH, { requestId, sessionId: sid })).body, { ok: true });
	assert.equal((await call(port, "GET", "/api/watch/pending", WATCH)).body.showing, requestId);
	assert.deepEqual((await call(port, "POST", "/api/watch/showing", WATCH, { requestId: null })).body, { ok: true });
	assert.equal((await call(port, "POST", "/api/watch/showing", WATCH, { requestId: 5 })).status, 400);
	assert.deepEqual((await call(port, "POST", "/api/watch/dismiss", WATCH, { requestId })).body, { ok: true });
	assert.equal((await call(port, "POST", "/api/watch/dismiss", WATCH, {})).status, 400);
	assert.ok(!(await call(port, "GET", "/api/watch/pending", WATCH)).body.requests.some((r: { id: string }) => r.id === requestId));

	assert.deepEqual((await call(port, "POST", "/api/watch/prompt", WATCH, { sessionId: sid, text: "hello" })).body, { ok: true });
	assert.ok(h.received.some((c) => c.type === "prompt" && c.text === "hello"));
	assert.equal((await call(port, "POST", "/api/watch/prompt", WATCH, { sessionId: "nope-1", text: "hi" })).body.reason, "gone");
	assert.equal((await call(port, "POST", "/api/watch/prompt", WATCH, { sessionId: sid })).status, 400);

	assert.deepEqual((await call(port, "POST", "/api/watch/model", WATCH, { sessionId: sid, provider: "anthropic", modelId: "m1" })).body, { ok: true });
	assert.ok(h.received.some((c) => c.type === "set_model" && c.modelId === "m1"));
	assert.equal((await call(port, "POST", "/api/watch/model", WATCH, { sessionId: sid, provider: "anthropic" })).status, 400);

	const list = await call(port, "GET", "/api/watch/sessions", WATCH);
	assert.ok(list.body.sessions.some((s: { id: string }) => s.id === sid));
	const hist = await call(port, "GET", `/api/watch/history?session=${sid}&limit=500&before=abc`, WATCH);
	assert.equal(hist.status, 200);
	assert.deepEqual(Object.keys(hist.body).sort(), ["total", "turns"]);
	assert.equal((await call(port, "GET", "/api/watch/history", WATCH)).status, 400);
	assert.equal((await call(port, "GET", "/api/watch/history?session=missing", WATCH)).status, 404);
	const models = await call(port, "GET", `/api/watch/models?session=${sid}`, WATCH);
	assert.equal(models.status, 200);
	assert.ok(Array.isArray(models.body.models));
});

test("health carries no watch secrets; watch/health carries the counts", async () => {
	const r = await call(port, "GET", "/api/health", GOOD);
	assert.equal(r.body.watch, undefined);
	const w = await call(port, "GET", "/api/watch/health", WATCH);
	assert.deepEqual([w.status, w.body.ok, w.body.hubVersion], [200, true, "0.1.0-test"]);
	assert.deepEqual(Object.keys(w.body.sessions).sort(), ["pending", "running"]);
});

test("weather proxies Open-Meteo once per 10 minutes per rounded coordinate and answers 502 when upstream fails", async () => {
	fetches = [];
	const a = await call(port, "GET", "/api/watch/weather?lat=52.52&lon=13.41", WATCH);
	assert.deepEqual([a.status, a.body], [200, { tempC: 11.5, code: 3 }]);
	assert.equal(fetches.length, 1);
	assert.match(fetches[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=52\.52&longitude=13\.41&current=temperature_2m,weather_code$/);
	await call(port, "GET", "/api/watch/weather?lat=52.49&lon=13.44", WATCH);
	assert.equal(fetches.length, 1);
	clock += 11 * 60_000;
	await call(port, "GET", "/api/watch/weather?lat=52.52&lon=13.41", WATCH);
	assert.equal(fetches.length, 2);
	assert.equal((await call(port, "GET", "/api/watch/weather?lat=abc&lon=1", WATCH)).status, 400);
	assert.equal((await call(port, "GET", "/api/watch/weather?lat=1", WATCH)).status, 400);
	upstream = "fail";
	assert.equal((await call(port, "GET", "/api/watch/weather?lat=1&lon=2", WATCH)).status, 502);
	upstream = "throw";
	assert.equal((await call(port, "GET", "/api/watch/weather?lat=3&lon=4", WATCH)).status, 502);
});

test("the watch prefix boundary: paths that resolve outside /api/watch/ still need an Origin", async () => {
	assert.equal((await call(port, "GET", "/api/watch/../sessions", WATCH)).status, 403);
	assert.equal((await call(port, "GET", "/api/watch/%2e%2e/sessions", WATCH)).status, 403);
	assert.equal((await call(port, "GET", "/api/watch", WATCH)).status, 403);
});

test("launch uses the last X-Forwarded-For (else the socket's address) and passes launchFn's answer through", async () => {
	const w = new WatchService({ registry, index, viewers: new Viewers(), home: root });
	const calls: [string, string][] = [];
	let answer: { ok: true } | { ok: false; reason: "unreachable" } = { ok: true };
	const launchFn = (async (host: string, uuid: string) => (calls.push([host, uuid]), answer)) as typeof launchOnPhone;
	const s = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, log: () => {}, watch: w, launchFn });
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const p = (s.address() as AddressInfo).port;
	const uuid = "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b";
	const fwd = { ...WATCH, "x-forwarded-for": "100.64.0.9, 10.0.0.1" };
	try {
		// A rejected request never records an address.
		assert.equal((await call(p, "POST", "/api/watch/launch", { ...WATCH, "tailscale-user-login": undefined }, { uuid })).status, 403);
		assert.equal(w.phone, null);
		assert.equal(calls.length, 0);
		assert.equal((await call(p, "GET", "/api/watch/health", fwd)).status, 200);
		assert.deepEqual((await call(p, "POST", "/api/watch/launch", fwd, { uuid })).body, { ok: true });
		assert.deepEqual(calls, [["100.64.0.9", uuid]]);
		assert.deepEqual((await call(p, "POST", "/api/watch/launch", WATCH, { uuid })).body, { ok: true });
		assert.deepEqual(calls[1], ["127.0.0.1", uuid]);
		answer = { ok: false, reason: "unreachable" };
		const r = await call(p, "POST", "/api/watch/launch", WATCH, { uuid });
		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { ok: false, reason: "unreachable" });
		for (const body of [{}, { uuid: "nope" }, { uuid: 5 }]) assert.equal((await call(p, "POST", "/api/watch/launch", WATCH, body)).status, 400);
		assert.equal(calls.length, 3);
	} finally {
		w.close();
		s.close();
	}
});

test("launch answers no_phone while no address is known, without calling launchFn", async () => {
	const w = new WatchService({ registry, index, viewers: new Viewers(), home: root });
	let called = false;
	const launchFn = (async () => ((called = true), { ok: true })) as typeof launchOnPhone;
	const s = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, log: () => {}, watch: w, launchFn });
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const p = (s.address() as AddressInfo).port;
	try {
		// Over HTTP the request itself records the socket's address, so force the unknown case.
		w.notePhone = () => {};
		assert.deepEqual((await call(p, "POST", "/api/watch/launch", WATCH, { uuid: "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b" })).body, { ok: false, reason: "no_phone" });
		assert.equal(called, false);
	} finally {
		w.close();
		s.close();
	}
});

test("notePhone prefers the first X-Forwarded-For entry, strips ::ffff:", () => {
	const w = new WatchService({ registry, index, viewers: new Viewers(), home: root });
	try {
		w.notePhone({}, undefined);
		assert.equal(w.phone, null);
		w.notePhone({}, "::ffff:100.64.0.5");
		assert.equal(w.phone, "100.64.0.5");
		w.notePhone({ "x-forwarded-for": " 100.64.0.9 , 1.1.1.1" }, "127.0.0.1");
		assert.equal(w.phone, "100.64.0.9");
		w.notePhone({}, "fd7a::1");
		assert.equal(w.phone, "fd7a::1");
		w.notePhone({ "x-forwarded-for": "evil.example, 100.64.0.9" }, "::ffff:100.64.0.7");
		assert.equal(w.phone, "100.64.0.7");
	} finally {
		w.close();
	}
});
