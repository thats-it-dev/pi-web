import { describe, expect, it } from "vitest";
import { fitWeeks, heatLayout, heatLevel } from "./heat.ts";

describe("heatLayout", () => {
	it("ends on a Sunday", () => {
		const { cells } = heatLayout("2026-11-08", 2);
		expect(cells.length).toBe(14);
		expect(cells[0]).toEqual({ day: "2026-10-26", col: 0, row: 0 });
		expect(cells[13]).toEqual({ day: "2026-11-08", col: 1, row: 6 });
	});
	it("ends on a Monday", () => {
		const { cells } = heatLayout("2026-11-09", 2);
		expect(cells.length).toBe(8);
		expect(cells[0].day).toBe("2026-11-02");
		expect(cells[7]).toEqual({ day: "2026-11-09", col: 1, row: 0 });
	});
	it("ends on a Wednesday", () => {
		expect(heatLayout("2026-11-04", 2).cells.length).toBe(10);
	});
	it("labels months", () => {
		const { months } = heatLayout("2026-11-08", 6);
		expect(months).toContainEqual({ col: 4, day: "2026-11-01" });
		expect(months.map((m) => m.day)).not.toContain("2026-09-01");
	});
	it("labels only 1sts inside the grid", () => {
		const { months } = heatLayout("2026-03-08", 3); // Mar 1 is a Sunday in col 1 (Feb 23 week)
		expect(months).toEqual([{ col: 1, day: "2026-03-01" }]);
		const m2 = heatLayout("2026-03-15", 2).months; // starts Mar 2: Mar 1 is before the first column
		expect(m2).toEqual([]);
	});
});

describe("heatLevel", () => {
	it("buckets", () => {
		expect(heatLevel(0, 40)).toBe(0);
		expect(heatLevel(null, 40)).toBe(0);
		expect(heatLevel(undefined, 40)).toBe(0);
		expect(heatLevel(40, 40)).toBe(4);
		expect(heatLevel(1, 40)).toBe(1);
		expect(heatLevel(400, 40)).toBe(4);
	});
});

describe("fitWeeks", () => {
	it("fits", () => {
		expect(fitWeeks(270, 12)).toEqual({ weeks: 12, cell: 18 });
		expect(fitWeeks(200, 12)).toEqual({ weeks: 12, cell: 13 });
		expect(fitWeeks(100, 12)).toEqual({ weeks: 7, cell: 10 });
	});
});
