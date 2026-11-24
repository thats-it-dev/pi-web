import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/src/protocol.ts";
import { clampLimit, composeHits, runSearch } from "../src/search/compose.ts";
import type { RawHit } from "../src/search/service.ts";

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	cwd: `/w/${id}`,
	name: `name-${id}`,
	firstPrompt: `first-${id}`,
	userMessages: 1,
	model: null,
	contextTokens: null,
	createdAt: 1,
	updatedAt: 100,
	parentSession: null,
	live: false,
	handleKind: null,
	state: "idle",
	type: "code",
	...over,
});
const raw = (sessionId: string, over: Partial<RawHit> = {}): RawHit => ({ sessionId, ordinal: 3, role: "user", snippet: "s", terms: ["t"], semanticOnly: false, score: 0.5, ...over });

test("composeHits joins the listing row, keeps hit order and drops sessions not listed", () => {
	const hits = composeHits([raw("b", { role: "assistant", semanticOnly: true }), raw("gone"), raw("a")], [row("a"), row("b", { type: "chat", updatedAt: 7 })]);
	assert.deepEqual(hits, [
		{ sessionId: "b", type: "chat", name: "name-b", firstPrompt: "first-b", cwd: "/w/b", updatedAt: 7, ordinal: 3, role: "assistant", snippet: "s", terms: ["t"], semanticOnly: true },
		{ sessionId: "a", type: "code", name: "name-a", firstPrompt: "first-a", cwd: "/w/a", updatedAt: 100, ordinal: 3, role: "user", snippet: "s", terms: ["t"], semanticOnly: false },
	]);
	assert.ok(!("score" in hits[0]));
});

test("clampLimit: default 8, NaN → 8, clamped to [1, 20], floored", () => {
	assert.equal(clampLimit(null), 8);
	assert.equal(clampLimit("abc"), 8);
	assert.equal(clampLimit(""), 8);
	assert.equal(clampLimit("0"), 1);
	assert.equal(clampLimit("-5"), 1);
	assert.equal(clampLimit("99"), 20);
	assert.equal(clampLimit("3.7"), 3);
	assert.equal(clampLimit("12"), 12);
});

test("runSearch: a short query never reaches the search; otherwise passes q, limit and exclude", async () => {
	const calls: unknown[][] = [];
	const search = {
		query: async (q: string, limit: number, exclude?: string) => {
			calls.push([q, limit, exclude]);
			return { hits: [raw("a")], semantic: true };
		},
	};
	const list = async () => [row("a")];
	assert.deepEqual(await runSearch(search, list, new URLSearchParams({ q: " x " })), { hits: [], semantic: false });
	assert.deepEqual(await runSearch(search, list, new URLSearchParams()), { hits: [], semantic: false });
	assert.equal(calls.length, 0);
	const r = await runSearch(search, list, new URLSearchParams({ q: "hello", limit: "50", exclude: "z" }), true);
	assert.equal(r.semantic, true);
	assert.equal(r.hits[0].sessionId, "a");
	assert.deepEqual(calls, [["hello", 20, "z"]]);
	await runSearch(search, list, new URLSearchParams({ q: "hello", exclude: "z" }));
	assert.deepEqual(calls[1], ["hello", 8, undefined]);
});
