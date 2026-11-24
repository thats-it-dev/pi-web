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
	it("picks the longest plain-word run, skipping markdown", () => {
		expect(snippetCore("…**bold**, then the quick brown fox jumps; ok…")).toBe("then the quick brown fox jumps");
	});
	it("falls back to the whole normalized snippet when no run is long enough", () => {
		expect(snippetCore("a, b, c")).toBe("a, b, c");
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

describe("matchesSnippet with markdown", () => {
	it("matches bold, code, link and bullet against rendered text", () => {
		const rendered = "Notes the build uses cargo check before every release candidate, see the docs for details";
		const snippet = "…- **Notes** the build uses `cargo check` before every [release candidate](https://x.dev/a), see the docs…";
		expect(matchesSnippet(rendered, snippet)).toBe(true);
	});
	it("matches when the snippet is mostly formatting", () => {
		expect(matchesSnippet("alpha beta gamma", "# *alpha* | _beta_ | `gamma`")).toBe(true);
	});
	it("does not match a different message", () => {
		expect(matchesSnippet("an unrelated message about gardening tools", "…- **Notes** the build uses `cargo check` before…")).toBe(false);
	});
});
