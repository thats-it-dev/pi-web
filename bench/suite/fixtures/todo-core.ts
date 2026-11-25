// The to-do app's rules as plain functions (no DOM), so they can be unit-tested. The bench's feature and one-line
// tasks start from this fixture.

export interface Item {
	id: number;
	text: string;
	done: boolean;
}

/** Appends a new, not-done item; ids increase so two adds never collide. */
export function addItem(items: Item[], text: string, nextId: number): Item[] {
	const t = text.trim();
	return t ? [...items, { id: nextId, text: t, done: false }] : items;
}

/** Flips the done flag of the item with `id`. */
export function toggle(items: Item[], id: number): Item[] {
	return items.map((i) => (i.id === id ? { ...i, done: !i.done } : i));
}

/** Drops every done item. */
export function clearDone(items: Item[]): Item[] {
	return items.filter((i) => !i.done);
}

/** How many are done and how many there are in total. */
export function counts(items: Item[]): { done: number; total: number } {
	return { done: items.filter((i) => i.done).length, total: items.length };
}
