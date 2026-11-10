import { expect, test, vi } from "vitest";
import { fullHeight, trackViewport, viewportState } from "./viewport.ts";

test("no keyboard: the app fills the viewport", () => {
	expect(viewportState({ full: 844, height: 844, offsetTop: 0, scale: 1 })).toEqual({ height: 844, top: 0, keyboard: false });
});

test("iOS Safari keyboard up: the app shrinks to what's visible and follows the pan", () => {
	// Safari leaves innerHeight alone and pans the visual viewport over the page instead.
	expect(viewportState({ full: 844, height: 508, offsetTop: 336, scale: 1 })).toEqual({ height: 508, top: 336, keyboard: true });
});

test("small differences (the URL bar collapsing) aren't a keyboard", () => {
	expect(viewportState({ full: 844, height: 790, offsetTop: 0, scale: 1 })).toEqual({ height: 790, top: 0, keyboard: false });
});

test("while pinch-zoomed, leave the layout alone", () => {
	expect(viewportState({ full: 844, height: 400, offsetTop: 120, scale: 2.1 })).toBeNull();
});

test("fractional sizes round to whole pixels", () => {
	expect(viewportState({ full: 844, height: 507.6, offsetTop: 335.5, scale: 1 })).toEqual({ height: 508, top: 336, keyboard: true });
});

test("iOS home-screen app, keyboard up, window shrunk instead of panned: still a keyboard", () => {
	// innerHeight drops to the visible 497 and nothing pans; measured against the
	// remembered 844 that's a keyboard, against innerHeight it wouldn't be.
	expect(viewportState({ full: 844, height: 497, offsetTop: 0, scale: 1 })).toEqual({ height: 497, top: 0, keyboard: true });
});

test("the app never grows past the reported viewport", () => {
	// A stale black-translucent install reports 844 of a 912pt screen (WebKit bug
	// 301108) and never paints the rest: sizing to it leaves a gap, growing into
	// it clips the composer. The gap is the lesser evil.
	expect(viewportState({ full: 912, height: 844, offsetTop: 0, scale: 1 })).toEqual({ height: 844, top: 0, keyboard: false });
});

test("fullHeight: a home-screen app measures against the tallest height seen", () => {
	expect(fullHeight({ standalone: true, innerHeight: 844, tallest: 0 })).toBe(844);
	// Keyboard up and the window shrunk: innerHeight drops, the memory holds.
	expect(fullHeight({ standalone: true, innerHeight: 497, tallest: 844 })).toBe(844);
});

test("fullHeight: in a browser it's innerHeight; the toolbars aren't ours", () => {
	expect(fullHeight({ standalone: false, innerHeight: 844, tallest: 0 })).toBe(844);
	expect(fullHeight({ standalone: false, innerHeight: 760, tallest: 844 })).toBe(760);
});

// A stand-in window: just what trackViewport touches.
function fakeWindow() {
	const listeners = new Map<string, Array<() => void>>();
	const on = (t: string, f: () => void) => listeners.set(t, [...(listeners.get(t) ?? []), f]);
	const fire = (t: string) => for_(listeners.get(t));
	const for_ = (fs?: Array<() => void>) => fs?.forEach((f) => f());
	const props = new Map<string, string>();
	const attrs = new Set<string>();
	const blurred: string[] = [];
	const inner = { blur: () => blurred.push("textarea") };
	const host = { blur: () => blurred.push("host"), shadowRoot: { activeElement: inner } };
	const vv = { height: 844, offsetTop: 0, scale: 1, addEventListener: on };
	const doc = {
		visibilityState: "visible" as "visible" | "hidden",
		activeElement: host as unknown,
		addEventListener: on,
		documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v) }, toggleAttribute: (a: string, on: boolean) => (on ? attrs.add(a) : attrs.delete(a)) },
	};
	const win = { visualViewport: vv, document: doc, innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: true }), addEventListener: on };
	return { win: win as unknown as Window, vv, doc, props, attrs, blurred, fire };
}

test("leaving the app takes focus off the field that has it, so the keyboard can't outlive the visit", () => {
	const f = fakeWindow();
	trackViewport(f.win);
	f.doc.visibilityState = "hidden";
	f.fire("visibilitychange");
	expect(f.blurred).toEqual(["textarea"]); // the focused element inside the shadow root, not its host
});

test("coming back re-measures, even when iOS sends no resize for the keyboard it closed", () => {
	vi.useFakeTimers();
	const f = fakeWindow();
	trackViewport(f.win);
	// Keyboard up when the app was left.
	f.vv.height = 497;
	f.fire("resize");
	expect(f.attrs.has("data-keyboard")).toBe(true);
	f.doc.visibilityState = "hidden";
	f.fire("visibilitychange");
	// iOS closed it in the background but reports the new size late and fires nothing.
	f.doc.visibilityState = "visible";
	f.fire("visibilitychange");
	f.vv.height = 844;
	vi.advanceTimersByTime(1000);
	expect(f.attrs.has("data-keyboard")).toBe(false);
	expect(f.props.get("--app-h")).toBe("844px");
	vi.useRealTimers();
});
