export type DayInput = string | Date | number;

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function fromDate(d: Date): string | null {
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local "YYYY-MM-DD", or null when invalid. */
export function dayKey(x: DayInput | null | undefined): string | null {
	if (x === null || x === undefined) return null;
	if (typeof x === "string") {
		const m = KEY.exec(x);
		if (m) {
			const k = fromDate(new Date(+m[1], +m[2] - 1, +m[3], 12));
			return k === x ? x : null;
		}
		return fromDate(new Date(x));
	}
	if (typeof x === "number") return Number.isFinite(x) ? fromDate(new Date(x)) : null;
	return fromDate(x);
}

/** Local noon of the given day key. */
export function parseDay(key: string): Date {
	const m = KEY.exec(key);
	if (!m) return new Date(NaN);
	return new Date(+m[1], +m[2] - 1, +m[3], 12);
}

export function addDays(key: string, n: number): string {
	const m = KEY.exec(key);
	if (!m) return key;
	return fromDate(new Date(+m[1], +m[2] - 1, +m[3] + n, 12)) ?? key;
}

/** Contiguous day list from first to last row day; last row wins per day. */
export function daySlots<T>(
	rows: readonly T[],
	x: (row: T) => DayInput | null | undefined,
): { days: string[]; byDay: Map<string, T> } {
	const byDay = new Map<string, T>();
	for (const row of rows) {
		const k = dayKey(x(row));
		if (k) byDay.set(k, row);
	}
	if (byDay.size === 0) return { days: [], byDay };
	const keys = [...byDay.keys()].sort();
	const days: string[] = [];
	const last = keys[keys.length - 1];
	for (let k = keys[0]; k <= last; k = addDays(k, 1)) days.push(k);
	return { days, byDay };
}
