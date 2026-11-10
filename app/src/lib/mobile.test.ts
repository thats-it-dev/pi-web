import { expect, test } from "vitest";
import { enterSends, hardwareKeyboard, nextTucked } from "./mobile.ts";

const enter = { key: "Enter", shiftKey: false, isComposing: false };

test("Enter sends with a mouse or trackpad", () => {
	expect(enterSends(enter, { finePointer: true, onScreenKeyboard: false })).toBe(true);
});

test("Enter sends from a hardware keyboard on a touch screen (no on-screen keyboard up)", () => {
	expect(enterSends(enter, { finePointer: false, onScreenKeyboard: false })).toBe(true);
});

test("the on-screen keyboard's Return makes a new line", () => {
	expect(enterSends(enter, { finePointer: false, onScreenKeyboard: true })).toBe(false);
});

test("Shift+Enter, IME composition and other keys never send", () => {
	const env = { finePointer: true, onScreenKeyboard: false };
	expect(enterSends({ ...enter, shiftKey: true }, env)).toBe(false);
	expect(enterSends({ ...enter, isComposing: true }, env)).toBe(false);
	expect(enterSends({ ...enter, key: "a" }, env)).toBe(false);
});

test("hardwareKeyboard: typing on a touch device with no on-screen keyboard up", () => {
	expect(hardwareKeyboard({ coarse: true, onScreenKeyboard: false })).toBe(true);
	expect(hardwareKeyboard({ coarse: true, onScreenKeyboard: true })).toBe(false);
	expect(hardwareKeyboard({ coarse: false, onScreenKeyboard: false })).toBe(false); // a Mac: nothing to work around
});

test("the header tucks on any downward scroll and comes back on any upward one", () => {
	expect(nextTucked(false, { top: 30, delta: 3 })).toBe(true);
	expect(nextTucked(true, { top: 400, delta: -3 })).toBe(false);
});

test("sub-pixel jitter leaves the header as it is", () => {
	expect(nextTucked(true, { top: 400, delta: 1 })).toBe(true);
	expect(nextTucked(false, { top: 400, delta: -1 })).toBe(false);
	expect(nextTucked(true, { top: 400, delta: -1 })).toBe(true);
});

test("at the very top the header always shows (iOS rubber-band included)", () => {
	expect(nextTucked(true, { top: 0, delta: 5 })).toBe(false);
	expect(nextTucked(true, { top: -20, delta: 5 })).toBe(false);
});

test("near the bottom the header still tucks", () => {
	// The old rule kept it out within 80 px of the end, which left it showing whenever a chat was short.
	expect(nextTucked(false, { top: 2000, delta: 4 })).toBe(true);
});
