import { describe, expect, it } from "vitest";
import { atGoal, barFraction, GOAL_AT } from "./bars.ts";

describe("barFraction", () => {
	it("higher is better", () => {
		expect(GOAL_AT).toBe(0.8);
		expect(barFraction(40, { goal: 40 })).toBeCloseTo(0.8);
		expect(barFraction(20, { goal: 40 })).toBeCloseTo(0.4);
		expect(barFraction(100, { goal: 40 })).toBe(1);
	});
	it("no goal uses max", () => {
		expect(barFraction(5, { max: 10 })).toBe(0.5);
	});
	it("lower is better", () => {
		expect(barFraction(200, { goal: 200, lower: true })).toBeCloseTo(0.8);
		expect(barFraction(400, { goal: 200, lower: true })).toBeCloseTo(0.4);
		expect(barFraction(100, { goal: 200, lower: true })).toBe(1);
		const far = barFraction(2000, { goal: 200, lower: true });
		expect(far).toBeGreaterThan(0);
		expect(far).toBeLessThan(0.1);
		const f = [150, 250, 900].map((v) => barFraction(v, { goal: 200, lower: true }));
		expect(f[0]).toBeGreaterThan(f[1]);
		expect(f[1]).toBeGreaterThan(f[2]);
	});
	it("bad values", () => {
		expect(barFraction(Number.NaN, { goal: 40 })).toBe(0);
		expect(barFraction(0, { goal: 200, lower: true })).toBe(1);
		expect(barFraction(-5, { goal: 200, lower: true })).toBe(1);
	});
});

describe("atGoal", () => {
	it("compares by direction", () => {
		expect(atGoal(40, 40)).toBe(true);
		expect(atGoal(39, 40)).toBe(false);
		expect(atGoal(180, 200, true)).toBe(true);
		expect(atGoal(201, 200, true)).toBe(false);
	});
});
