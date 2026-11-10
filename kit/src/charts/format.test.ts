import { expect, test } from "vitest";
import { compact, formatDay, formatValue, nearestIndex } from "./format.ts";

test("compact", () => {
	expect(compact(1284, "en-US")).toBe("1,284");
	expect(compact(18400, "en-US")).toBe("18.4K");
	expect(compact(4_200_000, "en-US")).toBe("4.2M");
	expect(compact(-3, "en-US")).toBe("-3");
	expect(compact(36.5, "en-US")).toBe("36.5");
});
test("formatValue", () => {
	expect(formatValue(36, "wpm")).toBe("36 wpm");
	expect(formatValue(36, "wpm", (n) => `${n}!`)).toBe("36!");
});
test("formatDay", () => {
	expect(formatDay("2026-11-09", "en-US")).toMatch(/Nov\s9/);
});
test("nearestIndex", () => {
	expect(nearestIndex([0, 10, 20], 14)).toBe(1);
	expect(nearestIndex([0, 10, 20], 16)).toBe(2);
	expect(nearestIndex([], 5)).toBe(-1);
});
