import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { type IndexHeaders, ReplayCache, readIndexHeaders, signIndex, verifyIndex } from "../src/index-webhook.ts";

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
