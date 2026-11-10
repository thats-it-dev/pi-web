import { expect, test } from "vitest";
import { addDays, dayKey, daySlots, parseDay } from "./days.ts";

test("dayKey", () => {
	expect(dayKey("2026-11-09")).toBe("2026-11-09");
	expect(dayKey(new Date(2026, 10, 9, 23, 59))).toBe("2026-11-09");
	expect(dayKey("nope")).toBeNull();
	expect(dayKey(NaN)).toBeNull();
	expect(dayKey(null)).toBeNull();
});
test("parseDay is local noon", () => {
	expect(parseDay("2026-11-09").getHours()).toBe(12);
});
test("addDays", () => {
	expect(addDays("2026-03-07", 3)).toBe("2026-03-10");
	expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
});
test("daySlots fills gaps across DST", () => {
	expect(daySlots([{ d: "2026-03-07" }, { d: "2026-03-10" }], (r) => r.d).days).toEqual([
		"2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10",
	]);
	expect(daySlots([{ d: "2026-10-31" }, { d: "2026-11-02" }], (r) => r.d).days).toEqual([
		"2026-10-31", "2026-11-01", "2026-11-02",
	]);
});
test("duplicates: last wins; invalid dropped", () => {
	const rows = [{ d: "2026-03-07", v: 1 }, { d: "bad", v: 5 }, { d: "2026-03-07", v: 2 }];
	const { days, byDay } = daySlots(rows, (r) => r.d);
	expect(days).toEqual(["2026-03-07"]);
	expect(byDay.get("2026-03-07")?.v).toBe(2);
	expect(daySlots([], () => null).days).toEqual([]);
});
