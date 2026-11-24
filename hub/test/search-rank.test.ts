import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineTopK, markedSnippet, markedTerms, queryWords, rrf, snippet, termsIn } from "../src/search/rank.ts";

test("rrf merges lists, descending, shared ids win", () => {
	const out = rrf([[{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 3 }, { id: 2 }, { id: 4 }]]);
	assert.deepEqual(out.map((r) => r.id), [3, 2, 1, 4]);
	assert.ok(Math.abs(out[0].score - (1 / 63 + 1 / 61)) < 1e-12);
	for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
});

test("rrf ties keep first-appearance order; empty input is empty", () => {
	assert.deepEqual(rrf([[{ id: 5 }], [{ id: 9 }]]).map((r) => r.id), [5, 9]);
	assert.deepEqual(rrf([]), []);
});

test("cosineTopK returns the k best, descending", () => {
	const rows = [
		{ id: 1, vec: new Float32Array([1, 0]) },
		{ id: 2, vec: new Float32Array([0, 1]) },
		{ id: 3, vec: new Float32Array([1, 1]) },
	];
	const out = cosineTopK(new Float32Array([1, 0.1]), rows, 2);
	assert.deepEqual(out.map((r) => r.id), [1, 3]);
	assert.ok(out[0].score > out[1].score);
	assert.equal(cosineTopK(new Float32Array([0, 0]), rows, 2).length, 2);
});

test("queryWords lowercases, keeps diacritics, drops 1-char words", () => {
	assert.deepEqual(queryWords("Café a Restart-it, x9 é"), ["café", "restart", "it", "x9"]);
});

test("termsIn maps stems to surface forms, deduped, in text order", () => {
	assert.deepEqual(termsIn("We Restarted it; restarted again, then restart.", ["restart"]), ["Restarted", "restart"]);
	assert.deepEqual(termsIn("nothing here", ["restart"]), []);
});

test("snippet windows around the match within max, with ellipses", () => {
	const text = "alpha ".repeat(60) + "needle " + "omega ".repeat(60);
	const s = snippet(text, ["needle"], 100);
	assert.ok(s.includes("needle"));
	assert.ok(s.length <= 100);
	assert.ok(s.startsWith("…") && s.endsWith("…"));
	assert.ok(!/(^…|\s)(lpha|pha|ha|a)\s/.test(s), "no partial words");
});

test("snippet near the end pulls its start back to use the full max", () => {
	const text = "alpha ".repeat(60) + "needle end";
	const s = snippet(text, ["needle"], 100);
	assert.ok(s.endsWith("needle end"), s);
	assert.ok(s.startsWith("…"));
	assert.ok(s.length <= 100 && s.length >= 95, `length ${s.length}`);
});

test("snippet drops markdown noise but keeps code text", () => {
	assert.equal(snippet("Run **this** and `npm test`:\n```bash\nnode --test __x__\n```", ["run"]), "Run this and npm test: node --test x");
});

test("markedSnippet and markedTerms read FTS5 highlight markers", () => {
	const marked = "alpha ".repeat(60) + "the \x01Batteries\x02 died, \x01batteries\x02 again, \x01battery\x02 " + "omega ".repeat(60);
	assert.deepEqual(markedTerms(marked), ["Batteries", "battery"]);
	const s = markedSnippet(marked, 100);
	assert.ok(s.includes("the Batteries died"), s);
	assert.ok(!/[\x01\x02]/.test(s));
	assert.ok(s.length <= 100);
	assert.equal(markedSnippet("short \x01hit\x02 here"), "short hit here");
	assert.deepEqual(markedTerms("no markers"), []);
});

test("snippet without match starts at 0, no leading ellipsis", () => {
	const text = "word ".repeat(100);
	const s = snippet(text, ["zzz"], 50);
	assert.ok(s.startsWith("word"));
	assert.ok(s.endsWith("…"));
	assert.ok(s.length <= 50);
	assert.equal(snippet("short text", ["short"]), "short text");
});
