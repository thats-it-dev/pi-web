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

// History (spec §7.8): turns of varying height h(i) (gap included). The view
// shows the turns from `top` on, `dy` px into it. Scroll by d px, clamped so the
// view stays filled at the bottom and stops at the first turn's top.
export function scrollTurns(top, dy, d, n, view, h) {
	dy += d;
	while (top < n - 1 && dy >= h(top)) dy -= h(top++);
	let below = -dy;
	for (let i = top; i < n && below < view; i++) below += h(i);
	if (below < view) dy -= view - below;
	while (dy < 0 && top > 0) dy += h(--top);
	return { top, dy: Math.max(0, dy) };
}

