import assert from "node:assert/strict";
import { test } from "node:test";
import { lineSplitter } from "../src/jsonl.ts";

test("splits on LF only, across chunk boundaries, stripping CR", () => {
	const lines: string[] = [];
	const push = lineSplitter((l) => lines.push(l));
	const sep = JSON.stringify({ text: "a b c" }); // valid JSON containing Unicode separators
	push(`{"a":1}\r\n${sep.slice(0, 5)}`);
	push(`${sep.slice(5)}\n\n{"b"`);
	push(":2}\n");
	assert.deepEqual(lines, ['{"a":1}', sep, '{"b":2}']);
	assert.equal(JSON.parse(lines[1]).text, "a b c");
});
