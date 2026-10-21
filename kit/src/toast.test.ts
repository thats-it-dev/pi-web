import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast, TOAST_EVENT, type ToastDetail } from "./toast.ts";

let target: EventTarget;
beforeEach(() => {
	target = new EventTarget();
	vi.stubGlobal("window", target);
	vi.stubGlobal("CustomEvent", CustomEvent);
});
afterEach(() => vi.unstubAllGlobals());

function capture(): ToastDetail[] {
	const seen: ToastDetail[] = [];
	target.addEventListener(TOAST_EVENT, (e) => seen.push((e as CustomEvent<ToastDetail>).detail));
	return seen;
}

test("toast defaults to info", () => {
	const seen = capture();
	toast("hi");
	expect(seen).toEqual([{ message: "hi", level: "info" }]);
});

test("toast passes the level through", () => {
	const seen = capture();
	toast("x", "error");
	expect(seen).toEqual([{ message: "x", level: "error" }]);
});

test("event name is tk-toast", () => {
	expect(TOAST_EVENT).toBe("tk-toast");
});
