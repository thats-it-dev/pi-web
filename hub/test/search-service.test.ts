import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchDb } from "../src/search/db.ts";
import { hashEmbedder, type Embedder } from "../src/search/embedder.ts";
import { SearchService } from "../src/search/service.ts";

type Msg = { role: "user" | "assistant"; text: string };

function messageLine(sessionId: string, i: number, m: Msg): string {
	const id = `${sessionId}-m${i}`;
	const parentId = i === 0 ? null : `${sessionId}-m${i - 1}`;
	const timestamp = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
	const content = m.role === "user" ? m.text : [{ type: "text", text: m.text }];
	return JSON.stringify({ type: "message", id, parentId, timestamp, message: { role: m.role, content, timestamp: Date.parse(timestamp) } });
}

function sessionText(sessionId: string, msgs: Msg[]): string {
	const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/w" };
	return [JSON.stringify(header), ...msgs.map((m, i) => messageLine(sessionId, i, m))].join("\n") + "\n";
}

function fixture(embedder: Embedder | null = hashEmbedder(), debounceMs?: number) {
	const dir = mkdtempSync(join(tmpdir(), "search-service-"));
	const listing: { id: string; file: string; cwd: string; name: string | null; firstPrompt: string | null; updatedAt: number; parentSession: string | null }[] = [];
	const counts = new Map<string, number>();
	const write = (id: string, msgs: Msg[]) => {
		const file = join(dir, `${id}.jsonl`);
		writeFileSync(file, sessionText(id, msgs));
		counts.set(id, msgs.length);
		if (!listing.some((e) => e.id === id)) listing.push({ id, file, cwd: "/w", name: null, firstPrompt: null, updatedAt: Date.now(), parentSession: null });
		return file;
	};
	const append = (id: string, m: Msg) => {
		const n = counts.get(id)!;
		appendFileSync(join(dir, `${id}.jsonl`), messageLine(id, n, m) + "\n");
		counts.set(id, n + 1);
	};
	const db = new SearchDb(":memory:");
	const service = new SearchService({
		db,
		embedder,
		lookup: async () => listing.filter((e) => existsSync(e.file)),
		log: () => {},
		...(debounceMs !== undefined ? { debounceMs } : {}),
	});
	const done = () => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	};
	return { dir, listing, write, append, db, service, done };
}

test("sweep indexes new files, skips unchanged, re-indexes changed, purges vanished", async () => {
	const f = fixture();
	f.write("s1", [{ role: "user", text: "alpha bravo" }, { role: "assistant", text: "charlie delta" }]);
	const f2 = f.write("s2", [{ role: "user", text: "echo foxtrot" }]);
	assert.deepEqual(await f.service.sweep(), { indexed: 2, removed: 0 });
	assert.deepEqual(f.service.stats(), { files: 2, chunks: 3, embedded: 3, semantic: true });

	assert.deepEqual(await f.service.sweep(), { indexed: 0, removed: 0 });

	f.append("s1", { role: "user", text: "golf hotel" });
	assert.deepEqual(await f.service.sweep(), { indexed: 1, removed: 0 });
	assert.equal(f.service.stats().chunks, 4);
	assert.equal(f.service.stats().embedded, 4);
	assert.equal((await f.service.query("golf", 5)).hits[0]?.sessionId, "s1");

	unlinkSync(f2);
	assert.deepEqual(await f.service.sweep(), { indexed: 0, removed: 1 });
	assert.deepEqual(f.service.stats(), { files: 1, chunks: 3, embedded: 3, semantic: true });
	f.done();
});

test("sweep purges a vanished file", async () => {
	const f = fixture();
	const file = f.write("gone", [{ role: "user", text: "zanzibar itinerary" }]);
	f.write("kept", [{ role: "user", text: "something else entirely" }]);
	await f.service.sweep();
	assert.deepEqual((await f.service.query("zanzibar", 5)).hits.map((h) => h.sessionId), ["gone"]);
	unlinkSync(file);
	await f.service.sweep();
	assert.deepEqual((await f.service.query("zanzibar", 5)).hits, []);
	assert.equal(f.db.files().has(file), false);
	f.done();
});

test("query: a session that stops listing is dropped even before the next sweep", async () => {
	const f = fixture();
	f.write("s1", [{ role: "user", text: "zanzibar itinerary" }]);
	await f.service.sweep();
	f.listing.length = 0;
	assert.deepEqual((await f.service.query("zanzibar", 5)).hits, []);
	f.done();
});

test("query: keyword-only works before any embedding (semantic false)", async () => {
	const f = fixture(null);
	f.write("s1", [{ role: "user", text: "we restarted the hubs yesterday" }, { role: "assistant", text: "done, all good" }]);
	await f.service.sweep();
	assert.equal(f.service.stats().embedded, 0);
	assert.equal(f.service.stats().semantic, false);
	const r = await f.service.query("restart hub", 5);
	assert.equal(r.semantic, false);
	assert.equal(r.hits.length, 1);
	const h = r.hits[0];
	assert.equal(h.sessionId, "s1");
	assert.equal(h.ordinal, 0);
	assert.equal(h.role, "user");
	assert.equal(h.snippet, "we restarted the hubs yesterday");
	assert.deepEqual(h.terms, ["restarted", "hubs"]);
	assert.equal(h.semanticOnly, false);
	assert.ok(h.score > 0);
	f.done();
});

test("query: embedder present but nothing embedded yet is keyword-only", async () => {
	const f = fixture(null);
	f.write("s1", [{ role: "user", text: "restart the hub" }]);
	await f.service.sweep();
	// a second service over the same store, with an embedder that has not run yet
	const svc = new SearchService({ db: f.db, embedder: hashEmbedder(), lookup: async () => f.listing, log: () => {} });
	const r = await svc.query("restart hub", 5);
	assert.equal(r.semantic, false);
	assert.equal(r.hits.length, 1);
	f.done();
});

test("query: fused ranking groups per session and marks semanticOnly", async () => {
	const f = fixture();
	f.write("a", [
		{ role: "user", text: "please restart the hub" },
		{ role: "assistant", text: "I will restart the hub now" },
		{ role: "user", text: "the hub restart worked" },
	]);
	f.write("c", [{ role: "user", text: "restart everything today" }]);
	f.write("z", [{ role: "user", text: "quokka marmalade sandwiches" }]);
	await f.service.sweep();
	const r = await f.service.query("restart hub", 8);
	assert.equal(r.semantic, true);
	const ids = r.hits.map((h) => h.sessionId);
	assert.deepEqual(ids.slice(0, 2), ["a", "c"]); // one hit per session, best first
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(ids.includes("z"), false); // nothing in common with the query
	const a = r.hits[0];
	const c = r.hits[1];
	assert.equal(a.semanticOnly, false);
	assert.equal(c.semanticOnly, true);
	assert.deepEqual(c.terms, ["restart"]);
	assert.ok(a.score > c.score);

	assert.equal((await f.service.query("restart hub", 1)).hits.length, 1);
	f.done();
});

test("query: punctuation and stopwords give no hits", async () => {
	const f = fixture();
	f.write("s1", [{ role: "user", text: "the hub is the thing ?? yes" }]);
	await f.service.sweep();
	for (const q of ["??", "the", "  ", "\"", "*", "the of and", "AND OR NOT"]) {
		const r = await f.service.query(q, 5);
		assert.deepEqual(r.hits, [], q);
	}
	f.done();
});

test("query: exclude drops the current session", async () => {
	const f = fixture();
	f.write("cur", [{ role: "user", text: "restart the hub" }]);
	f.write("old", [{ role: "user", text: "restart the hub last week" }]);
	await f.service.sweep();
	assert.deepEqual(new Set((await f.service.query("restart hub", 5)).hits.map((h) => h.sessionId)), new Set(["cur", "old"]));
	assert.deepEqual((await f.service.query("restart hub", 5, "cur")).hits.map((h) => h.sessionId), ["old"]);
	f.done();
});

test("concurrent sweeps do not overlap and a call during a sweep runs once more", async () => {
	const f = fixture();
	f.write("s1", [{ role: "user", text: "alpha" }]);
	const first = f.service.sweep();
	f.write("s2", [{ role: "user", text: "bravo" }]);
	const second = f.service.sweep();
	const third = f.service.sweep();
	const [r1, r2, r3] = await Promise.all([first, second, third]);
	assert.equal(r1.indexed + r2.indexed, 2);
	assert.deepEqual(r2, r3); // the queued follow-up is shared
	assert.equal(f.service.stats().files, 2);
	f.done();
});

test("embedPending is a no-op without an embedder", async () => {
	const f = fixture(null);
	f.write("s1", [{ role: "user", text: "alpha" }]);
	await f.service.sweep();
	assert.equal(await f.service.embedPending(), 0);
	f.done();
});

test("embedPending embeds in batches and a failing embedder leaves keyword search working", async () => {
	const f = fixture(null);
	f.write("s1", Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, text: `word${i} alpha` })));
	await f.service.sweep();
	let calls = 0;
	const h = hashEmbedder();
	const counting = new SearchService({ db: f.db, embedder: { ...h, embed: (t) => (calls++, h.embed(t)) }, lookup: async () => f.listing, log: () => {}, embedBatch: 2 });
	assert.equal(await counting.embedPending(), 5);
	assert.equal(calls, 3);
	assert.equal(f.db.stats().embedded, 5);

	const f2 = fixture({ name: "broken", dims: 4, embed: async () => { throw new Error("no model"); } });
	f2.write("s1", [{ role: "user", text: "restart the hub" }]);
	await f2.service.sweep();
	assert.equal(f2.service.stats().embedded, 0);
	const r = await f2.service.query("restart hub", 5);
	assert.equal(r.semantic, false);
	assert.equal(r.hits.length, 1);
	f.done();
	f2.done();
});

test("poke re-indexes a changed file", async () => {
	const f = fixture(hashEmbedder(), 200);
	f.write("s1", [{ role: "user", text: "alpha" }]);
	await f.service.sweep();
	f.append("s1", { role: "assistant", text: "the walrus migration finished" });
	f.service.poke();
	f.service.poke();
	const deadline = Date.now() + 3000;
	let hits: { sessionId: string; ordinal: number }[] = [];
	while (Date.now() < deadline) {
		hits = (await f.service.query("walrus", 5)).hits;
		if (hits.length) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.deepEqual(hits.map((h) => [h.sessionId, h.ordinal]), [["s1", 1]]);
	f.done();
});
