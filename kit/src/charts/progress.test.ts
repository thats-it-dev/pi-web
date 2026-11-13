import { describe, expect, it } from "vitest";
import { progressFraction } from "./progress.ts";

describe("progressFraction", () => {
	it("clamps to 0..1", () => {
		expect(progressFraction(12, 30)).toBeCloseTo(0.4);
		expect(progressFraction(40, 30)).toBe(1);
		expect(progressFraction(0, 30)).toBe(0);
	});
	it("negative value clamps to 0", () => {
		expect(progressFraction(-5, 30)).toBe(0);
	});
	it("returns 0 for bad max", () => {
		expect(progressFraction(10, 0)).toBe(0);
		expect(progressFraction(10, -5)).toBe(0);
		expect(progressFraction(10, Number.NaN)).toBe(0);
	});
	it("returns 0 for bad value", () => {
		expect(progressFraction(Number.NaN, 30)).toBe(0);
		expect(progressFraction(Number.POSITIVE_INFINITY, 30)).toBe(0);
	});
});
