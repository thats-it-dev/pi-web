import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { HubConfig } from "../src/config.ts";
import { PushStore } from "../src/push.ts";
import { Registry } from "../src/registry.ts";
import { createHubServer } from "../src/server.ts";
import { SessionIndex } from "../src/sessions.ts";
import { call } from "./support/http.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-push-routes-"));
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
	push: true,
	ringProfileUrl: "",
	dataDir: root,
};
const GOOD = { origin: "https://pi.thatsit.app", host: "hub.test:7878", "tailscale-user-login": "me@github" };
const index = new SessionIndex(join(root, "sessions"));
const registry = new Registry({ factory: { startRpc: () => Promise.reject(new Error("no pi in this test")) }, lookup: index, maxHeadless: 1, idleMs: 60_000 });
const push = new PushStore({ dataDir: root, subject: "https://pi.thatsit.app", log: () => {} });
const withPush = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, push, log: () => {} });
const without = createHubServer({ cfg, registry, index, version: "0.1.0-test", home: root, log: () => {} });
let port = 0;
let bare = 0;
before(async () => {
	await new Promise<void>((r) => withPush.listen(0, "127.0.0.1", r));
	await new Promise<void>((r) => without.listen(0, "127.0.0.1", r));
	port = (withPush.address() as AddressInfo).port;
	bare = (without.address() as AddressInfo).port;
});
after(() => {
	withPush.close();
	without.close();
});

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: "BPub", auth: "secret" } };

test("health carries the VAPID public key", async () => {
	const r = await call(port, "GET", "/api/health", GOOD);
	assert.equal(r.status, 200);
	assert.equal(r.body.vapidPublicKey, push.publicKey);
	assert.equal((await call(bare, "GET", "/api/health", GOOD)).body.vapidPublicKey, null);
});

test("subscribe stores the browser; unsubscribe removes it", async () => {
	const r = await call(port, "POST", "/api/push/subscribe", GOOD, SUB);
	assert.deepEqual([r.status, r.body], [200, { ok: true }]);
	assert.deepEqual(push.list(), [{ endpoint: SUB.endpoint, keys: SUB.keys }]);
	const u = await call(port, "POST", "/api/push/unsubscribe", GOOD, { endpoint: SUB.endpoint });
	assert.deepEqual([u.status, u.body], [200, { ok: true }]);
	assert.deepEqual(push.list(), []);
});

test("bad bodies are refused", async () => {
	assert.equal((await call(port, "POST", "/api/push/subscribe", GOOD, { endpoint: "https://x" })).status, 400);
	assert.equal((await call(port, "POST", "/api/push/unsubscribe", GOOD, {})).status, 400);
	assert.equal((await call(port, "POST", "/api/push/unsubscribe", GOOD, null)).status, 400);
	assert.deepEqual(push.list(), []);
});

test("push routes need the same identity as everything else", async () => {
	assert.equal((await call(port, "POST", "/api/push/subscribe", { ...GOOD, origin: "https://evil.example" }, SUB)).status, 403);
	assert.equal((await call(port, "POST", "/api/push/subscribe", { ...GOOD, "tailscale-user-login": undefined }, SUB)).status, 403);
	assert.deepEqual(push.list(), []);
});

test("a hub without push says so", async () => {
	assert.equal((await call(bare, "POST", "/api/push/subscribe", GOOD, SUB)).status, 503);
	assert.equal((await call(bare, "POST", "/api/push/unsubscribe", GOOD, { endpoint: SUB.endpoint })).status, 503);
});
