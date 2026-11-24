import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { historyFromText } from "../../shared/src/session-file.ts";
import { MAX_CHUNK, chunkSession, messageText, splitText } from "../src/search/chunks.ts";

const FIXTURE = new URL("./fixtures/search/forked.jsonl", import.meta.url);
const text = readFileSync(FIXTURE, "utf8");
const history = historyFromText(text).filter((m) => m.role === "user" || m.role === "assistant");

test("ordinals follow the active branch and count every user/assistant message", () => {
	const chunked = chunkSession(text)!;
	assert.equal(chunked.sessionId, "sess-fork-1");
	assert.equal(chunked.cwd, "/home/michael/proj");
	for (const c of chunked.chunks) assert.equal(messageText(history[c.ordinal]).includes(c.text.slice(0, 40)), true);
	assert.equal(Math.max(...chunked.chunks.map((c) => c.ordinal)) < history.length, true);
	assert.equal(chunked.chunks.some((c) => c.text.includes("ABANDONED BRANCH")), false);
	assert.equal(chunked.chunks.every((c) => c.ts > 0), true);
});

test("a compaction entry on the branch changes nothing: every branch message keeps its ordinal, the summary is not indexed", () => {
	assert.ok(text.includes('"type":"compaction"'), "the fixture carries a compaction entry, shaped as pi writes it");
	const chunked = chunkSession(text)!;
	// historyFromText turns the compaction into a compactionSummary row (filtered out above), so the
	// user/assistant ordinals on either side of it line up with chunkSession's.
	const ords = new Set(chunked.chunks.map((c) => c.ordinal));
	const expected = history.flatMap((m, i) => (messageText(m) ? [i] : []));
	assert.deepEqual([...ords], expected, "every branch message with text, before and after the compaction");
	assert.equal(chunked.chunks.some((c) => c.text.includes("COMPACTION SUMMARY")), false);
	// Note: a live compacted session renders only the summary plus the kept messages, so its rendered
	// list differs from these file ordinals; the app guards that case when jumping to a hit.
});

test("tool-call-only assistant turns take an ordinal but no chunk", () => {
	const chunked = chunkSession(text)!;
	const ords = [...new Set(chunked.chunks.map((c) => c.ordinal))];
	assert.deepEqual(ords.slice(0, 5), [0, 1, 2, 4, 5]); // ordinal 3 is the toolCall-only turn
	assert.equal(chunked.chunks.some((c) => c.text.includes("TOOL RESULT BODY") || c.text.includes("SECRET THOUGHT")), false);
});

test("attachments and inlined files are stripped; a files-only message keeps a marker", () => {
	const chunked = chunkSession(text)!;
	const all = chunked.chunks.map((c) => c.text).join("\n");
	assert.equal(all.includes("[file: notes.md]"), true);
	assert.equal(all.includes("Please summarize these notes"), true);
	assert.equal(all.includes("INLINED NOTES BODY"), false);
	assert.equal(all.includes("ONLY BODY"), false);
	assert.equal(all.includes("pi-web"), false);
	assert.equal(all.includes("[file: only.txt]"), true);
	assert.equal(all.includes("[image]"), true);
});

test("the TL;DR line is not indexed", () => {
	const chunked = chunkSession(text)!;
	assert.equal(chunked.chunks.some((c) => c.text.includes("TL;DR") || c.text.includes("keep four.")), false);
	assert.equal(chunked.chunks.some((c) => c.text.includes("keeps four archives")), true);
});

test("long message splits into pieces", () => {
	const chunked = chunkSession(text)!;
	const last = chunked.chunks.at(-1)!.ordinal;
	const pieces = chunked.chunks.filter((c) => c.ordinal === last);
	assert.equal(pieces.length > 1, true);
	assert.deepEqual(pieces.map((p) => p.piece), pieces.map((_, i) => i));
	assert.equal(pieces.every((p) => p.text.length <= MAX_CHUNK), true);
	assert.equal(pieces.map((p) => p.text).join("\n\n"), messageText(history[last]));
});

test("splitText hard-splits an overlong paragraph at a space", () => {
	const words = "word ".repeat(1000).trim();
	const parts = splitText(words);
	assert.equal(parts.every((p) => p.length <= MAX_CHUNK), true);
	assert.equal(parts.join(" "), words);
	assert.deepEqual(splitText("short"), ["short"]);
	assert.equal(splitText("x".repeat(3000)).every((p) => p.length <= MAX_CHUNK), true);
});

test("a non-session file returns null", () => {
	assert.equal(chunkSession("{}\n"), null);
	assert.equal(chunkSession(""), null);
});
