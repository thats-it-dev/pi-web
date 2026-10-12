import { expect, test } from "vitest";
import { fullHeight, viewportState } from "./viewport.ts";

test("no keyboard: the app fills the screen", () => {
	expect(viewportState({ full: 844, standalone: false, height: 844, offsetTop: 0, scale: 1 })).toEqual({ height: 844, top: 0, keyboard: false });
});

test("iOS Safari keyboard up: the app shrinks to what's visible and follows the pan", () => {
	// Safari leaves innerHeight alone and pans the visual viewport over the page instead.
	expect(viewportState({ full: 844, standalone: false, height: 508, offsetTop: 336, scale: 1 })).toEqual({ height: 508, top: 336, keyboard: true });
});

test("small differences (the URL bar collapsing) aren't a keyboard", () => {
	expect(viewportState({ full: 844, standalone: false, height: 790, offsetTop: 0, scale: 1 })).toEqual({ height: 790, top: 0, keyboard: false });
});

test("while pinch-zoomed, leave the layout alone", () => {
	expect(viewportState({ full: 844, standalone: false, height: 400, offsetTop: 120, scale: 2.1 })).toBeNull();
});

test("fractional sizes round to whole pixels", () => {
	expect(viewportState({ full: 844, standalone: false, height: 507.6, offsetTop: 335.5, scale: 1 })).toEqual({ height: 508, top: 336, keyboard: true });
});

test("iOS home-screen app: the viewport comes up a status bar short, so the app fills the screen while the keyboard is down", () => {
	// iPhone in standalone mode: the page draws over all 912pt, but innerHeight,
	// 100dvh and visualViewport all say 844 (the screen minus the 68pt status bar).
	expect(viewportState({ full: 912, standalone: true, height: 844, offsetTop: 0, scale: 1 })).toEqual({ height: 912, top: 0, keyboard: false });
});

test("iOS home-screen app, keyboard up, page panned: only the visible area, nothing added", () => {
	// Measured: 497 visible above a 347pt pan.
	expect(viewportState({ full: 912, standalone: true, height: 497, offsetTop: 347, scale: 1 })).toEqual({ height: 497, top: 347, keyboard: true });
});

test("iOS home-screen app, keyboard up, window shrunk instead of panned: still a keyboard", () => {
	// innerHeight drops to the visible 497 and nothing pans. Measured against
	// innerHeight that looks like no keyboard, and the status-bar patch would
	// then grow the app to 912 and push the composer under the keyboard.
	expect(viewportState({ full: 912, standalone: true, height: 497, offsetTop: 0, scale: 1 })).toEqual({ height: 497, top: 0, keyboard: true });
});

test("fullHeight: a home-screen app is the whole screen, the tallest height ever seen", () => {
	expect(fullHeight({ standalone: true, lvh: 912, innerHeight: 844, tallest: 0 })).toBe(912);
	expect(fullHeight({ standalone: true, lvh: 844, innerHeight: 844, tallest: 0 })).toBe(844);
	// Keyboard up and the window shrunk: lvh and innerHeight both drop, the memory holds.
	expect(fullHeight({ standalone: true, lvh: 497, innerHeight: 497, tallest: 912 })).toBe(912);
});

test("fullHeight: in a browser it's innerHeight; the toolbars and 100lvh aren't ours", () => {
	expect(fullHeight({ standalone: false, lvh: 912, innerHeight: 844, tallest: 0 })).toBe(844);
	expect(fullHeight({ standalone: false, lvh: 912, innerHeight: 760, tallest: 844 })).toBe(760);
});
