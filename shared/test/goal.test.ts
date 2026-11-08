import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { goalFromEntries } from "../src/goal.ts";
import { branchEntries } from "../src/session-file.ts";

const goal = (status: string, extra: object = {}) => ({ type: "custom", customType: "goal-state", data: { goal: { text: "ship it", status, updatedAt: 5, ...extra } } });
const none = { type: "custom", customType: "goal-state", data: { goal: null } };

test("fixture ends with a complete goal", () => {
	const entries = branchEntries(readFileSync(new URL("./fixtures/progress/goal.jsonl", import.meta.url), "utf8"));
	const g = goalFromEntries(entries);
	assert.equal(g?.status, "complete");
	assert.ok(g?.text);
});

test("latest null clears the goal, but not straight after complete", () => {
	assert.equal(goalFromEntries([goal("active"), none]), null);
	assert.equal(goalFromEntries([goal("active"), goal("complete"), none])?.status, "complete");
	assert.equal(goalFromEntries([goal("complete"), none, none]), null);
	assert.equal(goalFromEntries([goal("complete"), { type: "message" }, none])?.status, "complete");
});

test("malformed data gives null", () => {
	assert.equal(goalFromEntries([{ type: "custom", customType: "goal-state", data: "x" }]), null);
	assert.equal(goalFromEntries([goal("active"), { type: "custom", customType: "goal-state", data: { goal: { text: 3 } } }]), null);
	assert.equal(goalFromEntries([goal("bogus")]), null);
	assert.equal(goalFromEntries([]), null);
});

test("waiting field marks waiting", () => {
	assert.equal(goalFromEntries([goal("active", { waiting: { reason: "rate" } })])?.waiting, true);
	assert.equal(goalFromEntries([goal("active")])?.waiting, false);
	assert.equal(goalFromEntries([goal("active")])?.updatedAt, 5);
});
