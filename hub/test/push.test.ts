import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { PushSubscriptionInfo } from "../../shared/src/protocol.ts";
import { PushStore, isSubscription } from "../src/push.ts";

// A stand-in push service: answers each path with the status set for it, and records requests.
const statuses = new Map<string, number>();
const seen: Array<{ path: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
const service = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		seen.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
		res.writeHead(statuses.get(req.url ?? "") ?? 201);
		res.end();
	});
});
let base = "";
before(async () => {
	await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});
after(() => service.close());

function sub(path: string): PushSubscriptionInfo {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return { endpoint: `${base}${path}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

function store(dir = mkdtempSync(join(tmpdir(), "pi-web-push-"))) {
	const logs: string[] = [];
	return { dir, logs, push: new PushStore({ dataDir: dir, subject: "https://pi.thatsit.app", log: (m) => logs.push(m) }) };
}

test("keys are made once, kept private, and reused", () => {
	const { dir, push } = store();
	const file = join(dir, "vapid.json");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.match(push.publicKey, /^[A-Za-z0-9_-]{80,}$/);
	assert.equal(new PushStore({ dataDir: dir, subject: "https://x.test" }).publicKey, push.publicKey);
});

test("subscriptions are kept per endpoint and survive a restart", () => {
	const { dir, push } = store();
	const a = sub("/a");
	push.subscribe(a);
	push.subscribe({ ...a, keys: { ...a.keys } }); // the same browser again
	push.subscribe(sub("/b"));
	assert.deepEqual(push.list().map((s) => s.endpoint), [`${base}/a`, `${base}/b`]);
	assert.equal(statSync(join(dir, "push.json")).mode & 0o777, 0o600);
	const again = new PushStore({ dataDir: dir, subject: "https://pi.thatsit.app" });
	assert.equal(again.list().length, 2);
	again.unsubscribe(`${base}/a`);
	again.unsubscribe(`${base}/nope`);
	assert.deepEqual(new PushStore({ dataDir: dir, subject: "https://pi.thatsit.app" }).list().map((s) => s.endpoint), [`${base}/b`]);
});

test("send posts an encrypted, VAPID-signed message to every subscription", async () => {
	const { push } = store();
	push.subscribe(sub("/one"));
	push.subscribe(sub("/two"));
	seen.length = 0;
	await push.send({ sessionId: "s-1", title: "fix the parser", kind: "finished" });
	assert.deepEqual(seen.map((r) => r.path).sort(), ["/one", "/two"]);
	for (const r of seen) {
		assert.equal(r.headers["content-encoding"], "aes128gcm");
		assert.equal(r.headers.ttl, "3600");
		assert.match(String(r.headers.authorization), /^vapid t=.+, k=/);
		assert.ok(String(r.headers.authorization).includes(`k=${push.publicKey}`));
		assert.ok(r.body.length > 0);
		assert.ok(!r.body.toString("latin1").includes("fix the parser"), "the payload is encrypted");
	}
});

test("a 404 or 410 removes the subscription; other failures keep it and log", async () => {
	const { push, logs } = store();
	for (const p of ["/gone", "/missing", "/broken", "/fine"]) push.subscribe(sub(p));
	push.subscribe({ ...sub("/x"), endpoint: "http://127.0.0.1:1/closed" }); // nothing listens on port 1
	statuses.set("/gone", 410);
	statuses.set("/missing", 404);
	statuses.set("/broken", 500);
	await push.send({ sessionId: "s", title: "t", kind: "error" });
	assert.deepEqual(push.list().map((s) => s.endpoint).sort(), [`${base}/broken`, `${base}/fine`, "http://127.0.0.1:1/closed"].sort());
	assert.ok(logs.some((l) => l.includes("500")));
	assert.ok(logs.some((l) => l.includes("127.0.0.1:1")));
});

test("send with no subscriptions does nothing", async () => {
	const { push } = store();
	seen.length = 0;
	await push.send({ sessionId: "s", title: "t", kind: "needs_you" });
	assert.equal(seen.length, 0);
});

test("a corrupt push.json starts empty; a corrupt vapid.json gets new keys and drops old subscriptions", () => {
	const { dir, push } = store();
	push.subscribe(sub("/a"));
	const oldKey = push.publicKey;

	writeFileSync(join(dir, "push.json"), "{not json");
	const a = store(dir);
	assert.deepEqual(a.push.list(), []);
	assert.equal(a.push.publicKey, oldKey);
	assert.ok(a.logs.some((l) => l.includes("push.json")));

	a.push.subscribe(sub("/b"));
	writeFileSync(join(dir, "vapid.json"), "[]");
	const b = store(dir);
	assert.notEqual(b.push.publicKey, oldKey);
	assert.deepEqual(b.push.list(), []);
	assert.ok(b.logs.some((l) => l.includes("vapid.json")));
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "push.json"), "utf8")), []);
});

test("isSubscription accepts browser subscriptions and nothing else", () => {
	assert.equal(isSubscription(sub("/a")), true);
	assert.equal(isSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" }, expirationTime: null }), true);
	for (const bad of [null, "x", {}, { endpoint: "ftp://x", keys: { p256dh: "p", auth: "a" } }, { endpoint: "https://x", keys: { p256dh: "p" } }, { endpoint: "https://x" }]) {
		assert.equal(isSubscription(bad), false, JSON.stringify(bad));
	}
});

test("send says whether any subscription answered 2xx", async () => {
	const { push } = store();
	assert.equal(await push.send({ sessionId: "s", title: "t", kind: "query" }), false);
	push.subscribe(sub("/bad2"));
	statuses.set("/bad2", 500);
	assert.equal(await push.send({ sessionId: "s", title: "t", kind: "query" }), false);
	push.subscribe(sub("/ok2"));
	assert.equal(await push.send({ sessionId: "s", title: "t", kind: "query" }), true);
});
