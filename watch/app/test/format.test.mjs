import test from "node:test";
import assert from "node:assert/strict";
import { toolbar, statusLeft, clock, queryText, hint, sessionMeta, menuMeta, clipTo } from "../src/embeddedjs/modules/format.js";

test("toolbar", () => {
	assert.deepEqual(toolbar({ ctxPercent: 41, tps: 62, model: "qwen3" }), { ctx: "41%", percent: 41, speed: "62 T/S", model: "QWEN3" });
	assert.deepEqual(toolbar({ ctxPercent: null, tps: null, model: "" }), { ctx: "--", percent: null, speed: "--", model: "" });
	assert.deepEqual(toolbar(null), { ctx: "--", percent: null, speed: "--", model: "" });
});

test("statusLeft", () => {
	assert.equal(statusLeft(null, "connecting"), "CONNECTING");
	assert.equal(statusLeft(null, "offline"), "OFFLINE");
	assert.equal(statusLeft({ index: 1, count: 2 }, "online"), "PI-WEB 1/2");
	assert.equal(statusLeft(null, "online"), "PI-WEB 0/0");
	assert.equal(statusLeft(null, "unconfigured"), "NO HUB URL");
});

test("clock", () => {
	assert.equal(clock(new Date(2026, 9, 16, 21, 5), false), "9:05");
	assert.equal(clock(new Date(2026, 9, 16, 21, 5), true), "21:05");
	assert.equal(clock(new Date(2026, 9, 16, 0, 7), false), "12:07");
	assert.equal(clock(new Date(2026, 9, 16, 9, 7), true), "09:07");
});

test("queryText", () => {
	assert.equal(queryText({ tool: "bash", text: "Allow git push?\norigin" }), "bash: Allow git push?\norigin");
	assert.equal(queryText({ tool: "", text: "done" }), "done");
	assert.equal(queryText(null), "");
});

test("hint", () => {
	assert.equal(hint({ sessionTitle: "Fix bug" }, { state: "running" }), "FIX BUG · RUNNING");
	assert.equal(hint({ sessionTitle: "abcdefghijklmnopqrstuvwxyz" }, { state: "idle" }), "ABCDEFGHIJKLMNOPQRS… · IDLE");
});

test("sessionMeta", () => {
	assert.equal(sessionMeta({ live: true, state: "running", model: "qwen3", ctx: 42, age: "2h" }), "RUNNING · QWEN3 · 42%");
	assert.equal(sessionMeta({ live: false, state: "closed", model: "", ctx: null, age: "2h" }), "CLOSED · 2h");
});

test("menuMeta and clipTo", () => {
	assert.deepEqual(menuMeta({ model: "qwen3", state: "idle", ctxTokens: 52000, ctxWindow: 128000 }), ["QWEN3 · IDLE", "52k of 128k"]);
	assert.equal(clipTo("abcdef", 4), "abc…");
	assert.equal(clipTo("abc", 4), "abc");
});
