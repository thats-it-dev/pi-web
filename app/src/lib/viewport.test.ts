import { expect, test } from "vitest";
import { viewportState } from "./viewport.ts";

test("no keyboard: the app fills the screen", () => {
	expect(viewportState({ innerHeight: 844, height: 844, offsetTop: 0, scale: 1 })).toEqual({ height: 844, top: 0, keyboard: false });
});

test("iOS keyboard up: the app shrinks to what's visible and follows the visible area", () => {
	// iOS leaves innerHeight alone and pans the visual viewport over the page instead.
	expect(viewportState({ innerHeight: 844, height: 508, offsetTop: 336, scale: 1 })).toEqual({ height: 508, top: 336, keyboard: true });
});

test("small differences (the URL bar collapsing) aren't a keyboard", () => {
	expect(viewportState({ innerHeight: 844, height: 790, offsetTop: 0, scale: 1 })).toEqual({ height: 790, top: 0, keyboard: false });
});

test("while pinch-zoomed, leave the layout alone", () => {
	expect(viewportState({ innerHeight: 844, height: 400, offsetTop: 120, scale: 2.1 })).toBeNull();
});

test("fractional sizes round to whole pixels", () => {
	expect(viewportState({ innerHeight: 844, height: 507.6, offsetTop: 335.5, scale: 1 })).toEqual({ height: 508, top: 336, keyboard: true });
});
