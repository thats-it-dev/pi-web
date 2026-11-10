import { expect, test, vi } from "vitest";
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

test("years outside 1000-9999 are invalid and daySlots terminates", () => {
	expect(dayKey("0001-01-01T00:00:00Z")).toBeNull();
	expect(dayKey(new Date(8.64e15))).toBeNull();
	expect(daySlots([{ d: "0001-01-01T00:00:00Z" }], (r) => r.d).days).toEqual([]);
	expect(daySlots([{ d: new Date(8.64e15) }], (r) => r.d).days).toEqual([]);
});
test("TZ is pinned to a DST zone", () => {
	expect(new Date(2026, 2, 8, 12).getTimezoneOffset()).toBe(420);
	expect(new Date(2026, 0, 8, 12).getTimezoneOffset()).toBe(480);
});

test("daySlots caps the span at 3660 days, keeping the latest, and warns once", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const t0 = performance.now();
	const { days, byDay } = daySlots([{ d: "1990-01-01" }, { d: "2026-11-09" }], (r) => r.d);
	expect(days).toHaveLength(3660);
	expect(days[days.length - 1]).toBe("2026-11-09");
	expect(byDay.has("2026-11-09")).toBe(true);
	expect(performance.now() - t0).toBeLessThan(500);
	expect(warn).toHaveBeenCalledTimes(1);
	warn.mockRestore();
});
