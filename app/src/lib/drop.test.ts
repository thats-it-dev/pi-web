import { describe, expect, it } from "vitest";
import { DropTarget } from "./drop.ts";

const drag = (types: string[], files: File[] = []) => ({ dataTransfer: { types, files } }) as unknown as DragEvent;

describe("DropTarget", () => {
	it("over turns on at the first file dragenter and off after the matching dragleaves", () => {
		const t = new DropTarget();
		t.enter(drag(["Files"]));
		t.enter(drag(["Files"])); // a child element
		expect(t.over).toBe(true);
		t.leave();
		expect(t.over).toBe(true);
		t.leave();
		expect(t.over).toBe(false);
	});

	it("a drag without files never turns over on", () => {
		const t = new DropTarget();
		t.enter(drag(["text/plain"]));
		expect(t.over).toBe(false);
	});

	it("drop resets and returns the files", () => {
		const t = new DropTarget();
		const file = new File(["hi"], "a.txt", { type: "text/plain" });
		t.enter(drag(["Files"]));
		t.enter(drag(["Files"]));
		expect(t.drop(drag(["Files"], [file]))).toEqual([file]);
		expect(t.over).toBe(false);
		t.leave(); // a stray leave after the drop stays off
		expect(t.over).toBe(false);
	});
});
