import test from "node:test";
import assert from "node:assert/strict";
import { poolSize, windowFirst, scrollFor, stepIndex } from "../src/embeddedjs/modules/listWindow.js";

test("poolSize: the rows that fit plus one, never more than the list", () => {
	assert.equal(poolSize(26, 210, 44), 6); // 4.77 rows on screen → 5, plus one
	assert.equal(poolSize(26, 176, 44), 5); // exactly 4 on screen, plus one
	assert.equal(poolSize(4, 128, 32), 4);
	assert.equal(poolSize(3, 210, 44), 3);
	assert.equal(poolSize(0, 210, 44), 0);
});

test("scrollFor: centres the selection, clamped to the list", () => {
	assert.equal(scrollFor(0, 26, 210, 44), 0);
	assert.equal(scrollFor(1, 26, 210, 44), 0); // 44 - 83 < 0
	assert.equal(scrollFor(5, 26, 210, 44), 220 - 83);
	assert.equal(scrollFor(25, 26, 210, 44), 26 * 44 - 210);
	assert.equal(scrollFor(2, 3, 210, 44), 0); // the list is shorter than the view
	assert.equal(scrollFor(3, 4, 128, 32), 0); // exactly fills
});

test("windowFirst: the first bound row covers the top of the view, clamped", () => {
	assert.equal(windowFirst(0, 26, 6, 44), 0);
	assert.equal(windowFirst(43, 26, 6, 44), 0);
	assert.equal(windowFirst(44, 26, 6, 44), 1);
	assert.equal(windowFirst(-8, 26, 6, 44), 0); // bounce above the top
	assert.equal(windowFirst(26 * 44 - 210 + 8, 26, 6, 44), 20); // bounce past the end
	assert.equal(windowFirst(100, 4, 4, 32), 0); // the whole list is bound
});

test("the bound rows always cover the view at any reachable scroll", () => {
	const count = 26, view = 210, h = 44;
	const pool = poolSize(count, view, h);
	for (let s = 0; s <= count * h - view; s++) {
		const first = windowFirst(s, count, pool, h);
		assert.ok(first * h <= s, "top covered at " + s);
		assert.ok((first + pool) * h >= s + view, "bottom covered at " + s);
	}
});

test("stepIndex: Up/Down stop at the ends, no wrap", () => {
	assert.equal(stepIndex(0, -1, 26), 0);
	assert.equal(stepIndex(0, 1, 26), 1);
	assert.equal(stepIndex(25, 1, 26), 25);
	assert.equal(stepIndex(9, 1, 3), 2);
	assert.equal(stepIndex(0, 1, 0), 0);
});

import { scrollTurns } from "../src/embeddedjs/modules/listWindow.js";

// 24 turns: every third 100 px tall, the rest 30 (gap included); total 1280.
const H = (i) => (i % 3 ? 30 : 100);
const pos = (s) => Array.from({ length: s.top }, (_, i) => H(i)).reduce((a, b) => a + b, 0) + s.dy;

test("scrollTurns: opens at the bottom, the last turn's end on the view's end", () => {
	const s = scrollTurns(23, 0, 0, 24, 210, H);
	assert.equal(pos(s), 1280 - 210);
	assert.ok(s.dy < H(s.top));
});

test("scrollTurns: half-view steps up reach the top exactly and stop there", () => {
	let s = scrollTurns(23, 0, 0, 24, 210, H);
	let steps = 0;
	while (s.top || s.dy) { s = scrollTurns(s.top, s.dy, -105, 24, 210, H); steps++; }
	assert.equal(steps, Math.ceil((1280 - 210) / 105));
	assert.deepEqual(scrollTurns(0, 0, -105, 24, 210, H), { top: 0, dy: 0 });
});

test("scrollTurns: down steps move by d and stop at the bottom; short lists stay at the top", () => {
	let s = scrollTurns(0, 0, 105, 24, 210, H);
	assert.deepEqual(s, { top: 1, dy: 5 });
	for (let k = 0; k < 20; k++) s = scrollTurns(s.top, s.dy, 105, 24, 210, H);
	assert.equal(pos(s), 1280 - 210);
	assert.deepEqual(scrollTurns(2, 0, 105, 3, 210, H), { top: 0, dy: 0 }); // 160 px of turns
	assert.deepEqual(scrollTurns(0, 0, 0, 0, 210, H), { top: 0, dy: 0 });
});

