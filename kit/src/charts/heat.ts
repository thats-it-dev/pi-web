import { addDays, parseDay } from "./days.ts";

export type HeatCell = { day: string; col: number; row: number }; // row 0 = Monday

/** Columns are Monday-start weeks; the last column ends at endDay (partial), nothing after it. */
export function heatLayout(
	endDay: string,
	weeks: number,
): { cells: HeatCell[]; months: { col: number; day: string }[] } {
	const cells: HeatCell[] = [];
	const months: { col: number; day: string }[] = [];
	const n = Math.max(0, Math.floor(weeks));
	if (n === 0 || Number.isNaN(parseDay(endDay).getTime())) return { cells, months };
	const endRow = (parseDay(endDay).getDay() + 6) % 7;
	const first = addDays(endDay, -(endRow + (n - 1) * 7));
	let lastLabel = -Infinity;
	for (let i = 0; i < n * 7; i++) {
		const day = addDays(first, i);
		if (day > endDay) break;
		const col = Math.floor(i / 7);
		cells.push({ day, col, row: i % 7 });
		if (day.endsWith("-01") && col - lastLabel >= 2) {
			months.push({ col, day });
			lastLabel = col;
		}
	}
	return { cells, months };
}

/** 0 = empty, 1..steps. */
export function heatLevel(value: number | null | undefined, max: number, steps = 4): number {
	if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	if (!(max > 0)) return 0;
	return Math.max(1, Math.min(steps, Math.ceil((value / max) * steps)));
}

export function fitWeeks(
	width: number,
	wanted: number,
	o: { cell?: number; gap?: number; min?: number } = {},
): { weeks: number; cell: number } {
	const { cell = 18, gap = 4, min = 10 } = o;
	const fit = Math.floor((width + gap) / wanted) - gap;
	if (fit >= min) return { weeks: wanted, cell: Math.min(cell, fit) };
	return { weeks: Math.max(1, Math.min(wanted, Math.floor((width + gap) / (min + gap)))), cell: min };
}
