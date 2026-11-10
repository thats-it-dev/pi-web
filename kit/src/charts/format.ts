export function compact(n: number, locale?: string): string {
	if (!Number.isFinite(n)) return String(n);
	if (Math.abs(n) >= 10_000) {
		return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
	}
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
}

export function formatValue(n: number, unit?: string, format?: (n: number) => string): string {
	if (format) return format(n);
	const s = compact(n);
	return unit ? `${s} ${unit}` : s;
}

export function formatDay(key: string, locale?: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	if (!m) return key;
	const d = new Date(+m[1], +m[2] - 1, +m[3], 12);
	return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(d);
}

/** Index of the entry in (sorted) xs closest to px; -1 when empty. Ties go to the later one. */
export function nearestIndex(xs: readonly number[], px: number): number {
	let best = -1;
	let bestD = Infinity;
	for (let i = 0; i < xs.length; i++) {
		const d = Math.abs(xs[i] - px);
		if (d <= bestD) {
			best = i;
			bestD = d;
		}
	}
	return best;
}
