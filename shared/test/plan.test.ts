import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlan } from "../src/plan.ts";

test("counts boxes per task and picks the first unfinished task", () => {
	const md = "# My Plan\n\n### Task 1: A\n- [x] one\n- [ ] two\n\n### Task 2: B\n- [ ] a\n- [ ] b\n- [ ] c\n";
	assert.deepEqual(parsePlan(md), {
		title: "My Plan",
		tasks: [
			{ title: "Task 1: A", done: 1, total: 2 },
			{ title: "Task 2: B", done: 0, total: 3 },
		],
		current: 0,
	});
});

test("current moves on when earlier tasks are done; null when all done", () => {
	assert.equal(parsePlan("### Task 1: A\n- [x] a\n### Task 2: B\n- [ ] b\n").current, 1);
	assert.equal(parsePlan("### Task 1: A\n- [X] a\n").current, null);
});

test("no task headings shows nothing", () => {
	assert.deepEqual(parsePlan("# T\n- [ ] x\n"), { title: "T", tasks: [], current: null });
});

test("boxes in fenced code are ignored", () => {
	const md = "### Task 1: A\n- [ ] real\n```md\n- [ ] quoted\n- [x] quoted\n```\n";
	assert.deepEqual(parsePlan(md).tasks, [{ title: "Task 1: A", done: 0, total: 1 }]);
});
