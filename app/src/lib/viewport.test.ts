import { expect, test } from "vitest";
import { missingStrip, viewportState } from "./viewport.ts";

test("no keyboard: the app fills the screen", () => {
	expect(viewportState({ innerHeight: 844, height: 844, offsetTop: 0, scale: 1, missing: 0 })).toEqual({ height: 844, top: 0, keyboard: false });
});

test("iOS keyboard up: the app shrinks to what's visible and follows the visible area", () => {
	// iOS leaves innerHeight alone and pans the visual viewport over the page instead.
	expect(viewportState({ innerHeight: 844, height: 508, offsetTop: 336, scale: 1, missing: 0 })).toEqual({ height: 508, top: 336, keyboard: true });
});

test("small differences (the URL bar collapsing) aren't a keyboard", () => {
	expect(viewportState({ innerHeight: 844, height: 790, offsetTop: 0, scale: 1, missing: 0 })).toEqual({ height: 790, top: 0, keyboard: false });
});

test("while pinch-zoomed, leave the layout alone", () => {
	expect(viewportState({ innerHeight: 844, height: 400, offsetTop: 120, scale: 2.1, missing: 0 })).toBeNull();
});

test("fractional sizes round to whole pixels", () => {
	expect(viewportState({ innerHeight: 844, height: 507.6, offsetTop: 335.5, scale: 1, missing: 0 })).toEqual({ height: 508, top: 336, keyboard: true });
});

test("iOS home-screen app: heights come up short by the status bar, so the app adds it back", () => {
	// iPhone in standalone mode: the page draws over all 912pt, but innerHeight,
	// 100dvh and visualViewport all say 844 (the screen minus the 68pt status bar).
	expect(viewportState({ innerHeight: 844, height: 844, offsetTop: 0, scale: 1, missing: 68 })).toEqual({ height: 912, top: 0, keyboard: false });
	expect(viewportState({ innerHeight: 844, height: 508, offsetTop: 0, scale: 1, missing: 68 })).toEqual({ height: 576, top: 0, keyboard: true });
});

test("missingStrip: only a home-screen app with a short viewport has one", () => {
	expect(missingStrip({ standalone: true, lvh: 912, innerHeight: 844 })).toBe(68);
	expect(missingStrip({ standalone: false, lvh: 912, innerHeight: 844 })).toBe(0); // Safari's toolbars, not the bug
	expect(missingStrip({ standalone: true, lvh: 844, innerHeight: 844 })).toBe(0);
	expect(missingStrip({ standalone: true, lvh: 800, innerHeight: 844 })).toBe(0);
});
