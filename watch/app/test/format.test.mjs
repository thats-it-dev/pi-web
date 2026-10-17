import test from "node:test";
import assert from "node:assert/strict";
import { toolbar, statusLeft, clock, queryText, hint, sessionMeta, menuMeta, clipTo, tailLines, wrapLines } from "../src/embeddedjs/modules/format.js";

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
	assert.equal(queryText({ kind: "finished", tool: "question", text: "Done." }), "Done.");
	assert.equal(queryText({ kind: "error", tool: "bash", text: "boom" }), "boom");
	assert.equal(queryText({ kind: "dialog", tool: "bash", text: "Allow?" }), "bash: Allow?");
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

test("tailLines keeps the end of a transcript in at most 2 lines, … where cut", () => {
	const w = (s) => s.length * 10; // 10 px a character
	assert.deepEqual(tailLines("yes please", 100, w), ["yes please"]);
	assert.deepEqual(tailLines("  ", 100, w), []);
	assert.deepEqual(tailLines("one two three four", 100, w), ["one two", "three four"]);
	assert.deepEqual(tailLines("aa bb cc dd ee ff gg hh", 80, w), ["…dd ee", "ff gg hh"]);
	assert.deepEqual(tailLines("supercalifragilistic", 100, w), ["…agilistic"]);
	assert.deepEqual(tailLines("ok supercalifragilistic", 100, w), ["…agilistic"]);
});

test("wrapLines wraps words forward into lines of `width`; a word too long keeps its own line (the Label cuts it)", () => {
	const w = (s) => s.length * 10;
	assert.deepEqual(wrapLines("one two three four", 100, w), ["one two", "three four"]);
	assert.deepEqual(wrapLines("yes", 100, w), ["yes"]);
	assert.deepEqual(wrapLines("", 100, w), [""]);
	assert.deepEqual(wrapLines("a supercalifragilistic b", 100, w), ["a", "supercalifragilistic", "b"]);
	assert.deepEqual(wrapLines("aaaa bbbbb", 100, w), ["aaaa bbbbb"]); // exactly 100
});

test("wrapLines starts a line at a newline; tailLines with no room gives no lines", () => {
	const w = (s) => s.length * 10;
	assert.deepEqual(wrapLines("bash: Allow bash?\ngit push origin main", 170, w), ["bash: Allow bash?", "git push origin", "main"]);
	assert.deepEqual(tailLines("one two three", 100, w, 0), []);
});
