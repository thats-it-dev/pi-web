// Window arithmetic for a virtualised list of fixed-height rows (Menu.js).
// Only `poolSize` row containers exist; they show the rows from `windowFirst`
// on and are re-bound as the list scrolls. Kept free of Piu for node:test.

// The rows that fit in the view plus one, so a part-scrolled window still covers it.
export function poolSize(count, viewHeight, rowHeight) {
	return Math.max(0, Math.min(count, Math.ceil(viewHeight / rowHeight) + 1));
}

// The list's scroll offset (px) that centres the selected row, clamped to the list.
export function scrollFor(selection, count, viewHeight, rowHeight) {
	const max = count * rowHeight - viewHeight;
	return Math.max(0, Math.min(max, selection * rowHeight - ((viewHeight - rowHeight) >> 1)));
}

// The first row bound to the pool at a scroll offset (which a bounce can take past either end).
export function windowFirst(scroll, count, pool, rowHeight) {
	return Math.max(0, Math.min(count - pool, Math.floor(scroll / rowHeight)));
}

// Up/Down: stop at the ends, no wrap.
export function stepIndex(selection, direction, count) {
	return Math.max(0, Math.min(count - 1, selection + direction));
}
