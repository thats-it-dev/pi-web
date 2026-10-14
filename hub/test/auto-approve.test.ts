import assert from "node:assert/strict";
import { test } from "node:test";
import { autoAnswer } from "../src/auto-approve.ts";

test("a permission select during a turn picks the plain allow option", () => {
	assert.deepEqual(autoAnswer({ method: "select", options: ["Allow", "Deny"] }, true), { value: "Allow" });
	assert.deepEqual(autoAnswer({ method: "select", options: ["Always allow", "Allow once", "Deny"] }, true), { value: "Allow once" });
	assert.deepEqual(autoAnswer({ method: "select", options: ["deny", "yes"] }, true), { value: "yes" });
});

test("a confirm during a turn is confirmed", () => {
	assert.deepEqual(autoAnswer({ method: "confirm" }, true), { confirmed: true });
});

test("nothing is answered outside a running turn", () => {
	assert.equal(autoAnswer({ method: "select", options: ["Allow", "Deny"] }, false), null);
	assert.equal(autoAnswer({ method: "confirm" }, false), null);
});

test("a select with no allow option, and input or editor dialogs, go to the person", () => {
	assert.equal(autoAnswer({ method: "select", options: ["red", "blue"] }, true), null);
	assert.equal(autoAnswer({ method: "input" }, true), null);
	assert.equal(autoAnswer({ method: "editor" }, true), null);
});
