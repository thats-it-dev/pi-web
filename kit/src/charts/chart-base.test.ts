import { expect, test } from "vitest";
import { clampIndex, stepIndex } from "./chart-base.ts";

test("stepIndex: first key from rest starts at the latest point", () => {
	expect(stepIndex(null, "ArrowRight", 5)).toBe(4);
});

test("stepIndex: left/right/home/end clamp to the ends", () => {
	expect(stepIndex(2, "ArrowLeft", 5)).toBe(1);
	expect(stepIndex(0, "ArrowLeft", 5)).toBe(0);
	expect(stepIndex(4, "ArrowRight", 5)).toBe(4);
	expect(stepIndex(2, "Home", 5)).toBe(0);
	expect(stepIndex(2, "End", 5)).toBe(4);
});

test("stepIndex: Escape returns to rest", () => {
	expect(stepIndex(2, "Escape", 5)).toBe(null);
});

test("stepIndex: up/down step by vstep, unhandled without it", () => {
	expect(stepIndex(10, "ArrowUp", 20, 7)).toBe(3);
	expect(stepIndex(10, "ArrowDown", 20, 7)).toBe(17);
	expect(stepIndex(10, "ArrowUp", 20)).toBeUndefined();
	expect(stepIndex(10, "ArrowDown", 20)).toBeUndefined();
});

test("stepIndex: other keys are not handled", () => {
	expect(stepIndex(1, "a", 5)).toBeUndefined();
});

test("clampIndex", () => {
	expect(clampIndex(7, 3)).toBe(2);
	expect(clampIndex(1, 0)).toBe(null);
	expect(clampIndex(null, 3)).toBe(null);
});
