import { expect, test } from "vitest";
import { linearScale, niceDomain, niceTicks, seriesDomain } from "./scale.ts";

test("niceTicks runs from nice floor to nice ceil", () => {
	expect(niceTicks(0, 47, 4)).toEqual([0, 10, 20, 30, 40, 50]);
});
test("niceDomain", () => {
	expect(niceDomain(21, 47)).toEqual([20, 50]);
});
test("linearScale maps and ticks", () => {
	const s = linearScale([0, 50], [130, 10]);
	expect(s(0)).toBe(130);
	expect(s(50)).toBe(10);
	expect(s.ticks(4)).toEqual(niceTicks(0, 50, 4));
});
test("seriesDomain includes goal and is never flat", () => {
	const [lo, hi] = seriesDomain([31, 44], 40);
	expect(lo).toBeLessThanOrEqual(31);
	expect(hi).toBeGreaterThanOrEqual(44);
	const [a, b] = seriesDomain([36, 36]);
	expect(b).toBeGreaterThan(a);
	expect(seriesDomain([])).toEqual([0, 1]);
	const [, h] = seriesDomain([31, 44], 60);
	expect(h).toBeGreaterThanOrEqual(60);
});
