import { describe, expect, it } from "vitest";
import { addItem, clearDone, counts, toggle } from "../src/todo.ts";

describe("todo core", () => {
	it("adds items with increasing ids and ignores blank text", () => {
		let items = addItem([], "buy milk", 1);
		items = addItem(items, "   ", 2);
		items = addItem(items, "call Sam", 3);
		expect(items.map((i) => i.text)).toEqual(["buy milk", "call Sam"]);
		expect(counts(items).total).toBe(2);
	});

	it("toggles and clears done items", () => {
		let items = addItem(addItem([], "a", 1), "b", 2);
		items = toggle(items, 1);
		expect(counts(items)).toEqual({ done: 1, total: 2 });
		items = clearDone(items);
		expect(items.map((i) => i.text)).toEqual(["b"]);
	});
});
