import { expect, test } from "vitest";
import { areaPath, linePath } from "./path.ts";

test("linePath breaks on null and marks isolated points", () => {
	expect(linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }, null, { x: 30, y: 5 }])).toBe("M0,0L10,5M30,5h0");
});
test("linePath empty", () => {
	expect(linePath([])).toBe("");
	expect(linePath([null])).toBe("");
});
test("linePath rounds to 1 decimal", () => {
	expect(linePath([{ x: 0.123, y: 1.987 }, { x: 2.04, y: 3 }])).toBe("M0.1,2L2,3");
});
test("areaPath closes runs of two or more only", () => {
	const d = areaPath(
		[{ x: 0, y: 0 }, { x: 10, y: 5 }, null, { x: 30, y: 5 }],
		[{ x: 0, y: 20 }, { x: 10, y: 20 }, null, { x: 30, y: 20 }],
	);
	expect(d).toBe("M0,0L10,5L10,20L0,20Z");
	expect(d.endsWith("Z")).toBe(true);
	expect(areaPath([null], [null])).toBe("");
});
