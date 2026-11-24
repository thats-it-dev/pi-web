import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, hashEmbedder, transformersEmbedder } from "../src/search/embedder.ts";

test("hashEmbedder: deterministic, normalized, shares words → higher cosine than unrelated", async () => {
	const e = hashEmbedder();
	assert.equal(e.dims, 384);
	const [a, a2, b, c] = await e.embed([
		"fix the websocket reconnect bug",
		"fix the websocket reconnect bug",
		"websocket reconnect handling",
		"banana smoothie recipe",
	]);
	assert.equal(a.length, 384);
	assert.deepEqual(Array.from(a), Array.from(a2));
	assert.ok(Math.abs(cosine(a, a) - 1) < 1e-5);
	assert.ok(cosine(a, b) > 0);
	assert.ok(cosine(a, b) > cosine(a, c));
});

test("hashEmbedder: empty text gives a zero vector, not NaN", async () => {
	const [v] = await hashEmbedder(16).embed([""]);
	assert.ok(Array.from(v).every((x) => x === 0));
});

test("transformersEmbedder: constructing it loads nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "emb-"));
	try {
		const e = transformersEmbedder(dir, () => {});
		assert.equal(e.dims, 384);
		assert.equal(readdirSync(dir).length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("transformersEmbedder: load failure rejects, retry waits 60 min", async () => {
	let t = 1000;
	let loads = 0;
	const logs: string[] = [];
	const e = transformersEmbedder("/nonexistent", (m) => logs.push(m), {
		now: () => t,
		load: async () => {
			loads++;
			throw new Error("no network");
		},
	});
	await assert.rejects(e.embed(["x"]), /no network/);
	assert.equal(loads, 1);
	t += 59 * 60_000;
	await assert.rejects(e.embed(["x"]), /retry/i);
	assert.equal(loads, 1);
	t += 2 * 60_000;
	await assert.rejects(e.embed(["x"]), /no network/);
	assert.equal(loads, 2);
	assert.ok(logs.length >= 1);
});

test("transformersEmbedder: real model ranks sensibly", { skip: !process.env.PI_WEB_REAL_EMBEDDER, timeout: 300_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "emb-real-"));
	try {
		const e = transformersEmbedder(dir, console.log);
		const [q, near, far] = await e.embed([
			"how do I reconnect a dropped websocket",
			"websocket connection lost, retry with backoff",
			"chocolate cake baking temperature",
		]);
		assert.equal(q.length, 384);
		assert.ok(Math.abs(cosine(q, q) - 1) < 1e-4);
		assert.ok(cosine(q, near) > cosine(q, far));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
