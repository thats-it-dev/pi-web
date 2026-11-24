import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchDb, ftsQuery } from "../src/search/db.ts";

type C = { ordinal: number; piece: number; role: "user" | "assistant"; ts: number; text: string };
const c = (ordinal: number, text: string, role: "user" | "assistant" = "user"): C => ({ ordinal, piece: 0, role, ts: 1000 + ordinal, text });

test("replaceFile stores chunks and keyword finds them with stemming", () => {
	const db = new SearchDb(":memory:");
	db.replaceFile("a.jsonl", "s1", "/w", 1, 10, [c(0, "we restarted the hubs"), c(1, "unrelated words")]);
	const hits = db.keyword("restart hub", 5);
	assert.equal(hits.length, 1);
	assert.ok(hits[0].score > 0);
	const rows = db.chunks(hits.map((h) => h.id));
	assert.equal(rows[0].text, "we restarted the hubs");
	assert.equal(rows[0].sessionId, "s1");
	assert.equal(rows[0].file, "a.jsonl");
	assert.equal(rows[0].hasEmbedding, false);
	assert.equal(db.sessionOf(hits[0].id), "s1");
	db.close();
});

test("fts: diacritics fold", () => {
	const db = new SearchDb(":memory:");
	db.replaceFile("a", "s1", "/w", 1, 1, [c(0, "the café opens")]);
	db.replaceFile("b", "s2", "/w", 1, 1, [c(0, "a cafe nearby")]);
	assert.equal(db.keyword("cafe", 5).length, 2);
	assert.equal(db.keyword("café", 5).length, 2);
	db.close();
});

test("ftsQuery escapes punctuation and returns null for nothing usable", () => {
	assert.equal(ftsQuery("??"), null);
	assert.equal(ftsQuery('tk-shell "aside'), '"tk" "shell" "aside"*');
});

test("replaceFile replaces, removeFile purges, files() reflects both", () => {
	const db = new SearchDb(":memory:");
	db.replaceFile("a", "s1", "/w", 5, 50, [c(0, "alpha beta"), c(1, "gamma")]);
	db.replaceFile("b", "s2", "/w", 6, 60, [c(0, "delta")]);
	assert.deepEqual(db.files().get("a"), { sessionId: "s1", mtimeMs: 5, size: 50 });
	assert.deepEqual(db.stats(), { files: 2, chunks: 3, embedded: 0 });
	db.replaceFile("a", "s1", "/w", 7, 70, [c(0, "epsilon")]);
	assert.equal(db.keyword("alpha", 5).length, 0);
	assert.equal(db.keyword("epsilon", 5).length, 1);
	assert.equal(db.files().get("a")!.mtimeMs, 7);
	assert.equal(db.stats().chunks, 2);
	db.removeFile("a");
	assert.equal(db.keyword("epsilon", 5).length, 0);
	assert.equal(db.files().has("a"), false);
	assert.deepEqual(db.stats(), { files: 1, chunks: 1, embedded: 0 });
	db.close();
});

test("embeddings: pending → set → all round-trips Float32Array", () => {
	const db = new SearchDb(":memory:");
	db.replaceFile("a", "s1", "/w", 1, 1, [c(0, "one"), c(1, "two"), c(2, "three")]);
	const pending = db.pendingEmbeddings(2);
	assert.equal(pending.length, 2);
	assert.equal(pending[0].text, "one");
	db.setEmbeddings([{ id: pending[0].id, vec: new Float32Array([0.5, -1.25, 3]) }]);
	assert.equal(db.pendingEmbeddings(10).length, 2);
	const all = db.allEmbeddings();
	assert.equal(all.length, 1);
	assert.deepEqual(Array.from(all[0].vec), [0.5, -1.25, 3]);
	assert.equal(db.stats().embedded, 1);
	assert.equal(db.chunks([pending[0].id])[0].hasEmbedding, true);
	db.close();
});

test("keyword returns nothing while the table is empty and never throws on odd input", () => {
	const db = new SearchDb(":memory:");
	const odd = ["", "*", "(", "the", '"', "a AND", "NEAR(", "x:y", "-"];
	for (const q of odd) assert.doesNotThrow(() => db.keyword(q, 5));
	assert.deepEqual(db.keyword("anything", 5), []);
	db.replaceFile("a", "s1", "/w", 1, 1, [c(0, "hello world")]);
	for (const q of odd) assert.doesNotThrow(() => db.keyword(q, 5));
	db.close();
});

test("keyword falls back to OR when AND finds nothing", () => {
	const db = new SearchDb(":memory:");
	db.replaceFile("a", "s1", "/w", 1, 1, [c(0, "kubernetes deploy")]);
	assert.equal(db.keyword("kubernetes banana", 5).length, 1);
	db.close();
});
