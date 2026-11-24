import { describe, expect, it } from "vitest";
import { type JumpState, nextJump } from "./jump.ts";

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
	it("the same at on another session scrolls", () => {
		expect(nextJump({ ...base, sessionId: "b", jumped: 4, jumpedSession: "a" })).toBe(4);
	});
});
