// Keeps the app inside the part of the screen that's actually visible. iOS
// ignores interactive-widget=resizes-content: when the keyboard opens it keeps
// the layout full height and pans the page under it, which slides the header
// away and leaves the composer's home-indicator padding above the keyboard.
// So the app is sized to visualViewport and moved with it, and
// <html data-keyboard> drops the bottom safe-area padding while typing.
// iOS home-screen apps add one more wrinkle: the page draws over the whole
// screen, but innerHeight, 100dvh and visualViewport all leave out the status
// bar (844 of 912pt on an iPhone). Only 100lvh is right, so the difference is
// measured and added back, or the app stops a status bar's height short.
// With the keyboard up, visualViewport is accurate and nothing is added.

const KEYBOARD_MIN = 120; // px of height lost before it counts as a keyboard, not browser chrome

export interface ViewportInput {
	innerHeight: number;
	height: number; // visualViewport.height
	offsetTop: number; // visualViewport.offsetTop
	scale: number; // visualViewport.scale
	missing: number; // see missingStrip
}

export interface ViewportState {
	height: number;
	top: number;
	keyboard: boolean;
}

export function viewportState(v: ViewportInput): ViewportState | null {
	if (Math.abs(v.scale - 1) > 0.01) return null; // pinch-zoomed: panning is the person's doing
	const keyboard = v.innerHeight - v.height > KEYBOARD_MIN;
	return { height: Math.round(v.height + (keyboard ? 0 : v.missing)), top: Math.round(v.offsetTop), keyboard };
}

// How much taller the screen is than the viewport iOS reports to a home-screen app.
export function missingStrip(m: { standalone: boolean; lvh: number; innerHeight: number }): number {
	return m.standalone ? Math.max(0, Math.round(m.lvh - m.innerHeight)) : 0;
}

export function trackViewport(win: Window = window): void {
	const vv = win.visualViewport;
	if (!vv) return;
	const root = win.document.documentElement;
	const standalone = win.matchMedia("(display-mode: standalone)");
	const lvh = win.document.createElement("div");
	lvh.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:100lvh;visibility:hidden;pointer-events:none";
	win.document.body.append(lvh);
	const update = () => {
		const missing = missingStrip({ standalone: standalone.matches, lvh: lvh.getBoundingClientRect().height, innerHeight: win.innerHeight });
		const s = viewportState({ innerHeight: win.innerHeight, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale, missing });
		if (!s) return;
		root.style.setProperty("--app-h", `${s.height}px`);
		root.style.setProperty("--app-top", `${s.top}px`);
		root.toggleAttribute("data-keyboard", s.keyboard);
	};
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	update();
}
