import { describe, expect, it } from "vitest";
import { type JumpState, matchesSnippet, nextJump, snippetCore } from "./jump.ts";

const base: JumpState = { at: 4, jumped: null, sessionId: "a", jumpedSession: null, messages: 10 };

describe("nextJump", () => {
	it("null without at or before messages load", () => {
		expect(nextJump({ ...base, at: null })).toBeNull();
		expect(nextJump({ ...base, messages: 0 })).toBeNull();
		expect(nextJump(base)).toBe(4);
	});
	it("runs once per at", () => {
		expect(nextJump({ ...base, jumped: 4, jumpedSession: "a" })).toBeNull();
	});
	it("at changes on the same session scroll again", () => {
		expect(nextJump({ ...base, at: 7, jumped: 4, jumpedSession: "a" })).toBe(7);
	});
	it("a cleared jump lets the same at scroll again", () => {
		expect(nextJump({ ...base, jumped: null, jumpedSession: null })).toBe(4);
	});
	it("the same at on another session scrolls", () => {
		expect(nextJump({ ...base, sessionId: "b", jumped: 4, jumpedSession: "a" })).toBe(4);
	});
});


describe("snippetCore", () => {
	it("strips ellipses, collapses whitespace, lowercases", () => {
		expect(snippetCore("…  Hello\n  World …")).toBe("hello world");
	});
	it("keeps the middle ~60 characters of a long snippet", () => {
		const core = snippetCore("x".repeat(50) + "MIDDLE" + "y".repeat(50));
		expect(core).toHaveLength(60);
		expect(core).toContain("middle");
	});
});

describe("matchesSnippet", () => {
	it("matches case- and whitespace-insensitively", () => {
		expect(matchesSnippet("Say   HELLO\nworld now", "…hello world…")).toBe(true);
	});
	it("rejects other text", () => {
		expect(matchesSnippet("something else", "…hello world…")).toBe(false);
	});
	it("an empty core matches anything", () => {
		expect(matchesSnippet("anything", "… …")).toBe(true);
	});
});
