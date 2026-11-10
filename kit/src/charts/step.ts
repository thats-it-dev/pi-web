// Pure keyboard-stepping helpers for charts. No DOM, so they unit-test in node.

/**
 * The index a key moves to from `current`, over `count` items.
 * Returns `undefined` when the key is not handled (so the caller leaves the event alone),
 * and `null` for rest (Escape, or nothing to step through).
 * The first stepping key from rest starts at the latest item, because rest shows the latest.
 * Up/Down are handled only when `vstep` is given (the heatmap steps by week).
 */
export function stepIndex(current: number | null, key: string, count: number, vstep?: number): number | null | undefined {
	if (key === "Escape") return null;
	const last = count - 1;
	let delta: number;
	switch (key) {
		case "Home":
			return count > 0 ? 0 : null;
		case "End":
			return count > 0 ? last : null;
		case "ArrowLeft":
			delta = -1;
			break;
		case "ArrowRight":
			delta = 1;
			break;
		case "ArrowUp":
			if (vstep === undefined) return undefined;
			delta = -vstep;
			break;
		case "ArrowDown":
			if (vstep === undefined) return undefined;
			delta = vstep;
			break;
		default:
			return undefined;
	}
	if (count <= 0) return null;
	if (current === null) return last;
	return Math.min(last, Math.max(0, current + delta));
}

/** Keeps an active index inside `count` items; `null` when there are none. */
export function clampIndex(i: number | null, count: number): number | null {
	if (i === null || count <= 0) return null;
	return Math.min(count - 1, Math.max(0, Math.trunc(i)));
}
