// Keeps the app inside the part of the screen that's actually visible. iOS
// ignores interactive-widget=resizes-content in Safari: when the keyboard opens
// it keeps the layout full height and pans the page under it, which slides the
// header away and leaves the composer's home-indicator padding above the
// keyboard. A home-screen app may instead shrink the layout viewport with the
// keyboard (innerHeight drops, no pan). Either way the app is sized to
// visualViewport and moved with it, and <html data-keyboard> drops the bottom
// safe-area padding while typing.
// iOS home-screen apps add one more wrinkle: the page draws over the whole
// screen, but innerHeight, 100dvh and visualViewport all leave out the status
// bar (844 of 912pt on an iPhone). Only 100lvh is right, so the tallest height
// ever measured is remembered as the screen and used while the keyboard is
// down, or the app stops a status bar's height short.
// Everything is measured against that full height, not innerHeight, so a
// keyboard is recognised whether iOS pans the page or shrinks the window.

const KEYBOARD_MIN = 120; // px of height lost before it counts as a keyboard, not browser chrome

export interface ViewportInput {
	full: number; // the height the page draws over: see fullHeight
	standalone: boolean; // a home-screen app fills the screen; a browser tab only what's visible
	height: number; // visualViewport.height
	offsetTop: number; // visualViewport.offsetTop
	scale: number; // visualViewport.scale
}

export interface ViewportState {
	height: number;
	top: number;
	keyboard: boolean;
}

export function viewportState(v: ViewportInput): ViewportState | null {
	if (Math.abs(v.scale - 1) > 0.01) return null; // pinch-zoomed: panning is the person's doing
	const keyboard = v.full - v.height > KEYBOARD_MIN;
	const height = keyboard || !v.standalone ? v.height : Math.max(v.height, v.full);
	return { height: Math.round(height), top: Math.round(v.offsetTop), keyboard };
}

// The height the page draws over. In a browser that's innerHeight (the
// toolbars aren't ours). A home-screen app covers the whole screen, which iOS
// under-reports with the keyboard down and shrinks or pans with it up, so the
// tallest height seen at this width (rotation changes the width) is the screen.
export function fullHeight(m: { standalone: boolean; lvh: number; innerHeight: number; tallest: number }): number {
	return m.standalone ? Math.max(m.lvh, m.innerHeight, m.tallest) : m.innerHeight;
}

export function trackViewport(win: Window = window): void {
	const vv = win.visualViewport;
	if (!vv) return;
	const root = win.document.documentElement;
	const standalone = win.matchMedia("(display-mode: standalone)");
	const lvh = win.document.createElement("div");
	lvh.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:100lvh;visibility:hidden;pointer-events:none";
	win.document.body.append(lvh);
	const tallest = new Map<number, number>(); // by innerWidth, so each orientation remembers its own
	const update = () => {
		const width = win.innerWidth;
		const full = fullHeight({ standalone: standalone.matches, lvh: lvh.getBoundingClientRect().height, innerHeight: win.innerHeight, tallest: tallest.get(width) ?? 0 });
		tallest.set(width, full);
		const s = viewportState({ full, standalone: standalone.matches, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale });
		if (!s) return;
		root.style.setProperty("--app-h", `${s.height}px`);
		root.style.setProperty("--app-top", `${s.top}px`);
		root.toggleAttribute("data-keyboard", s.keyboard);
	};
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	win.addEventListener("resize", update);
	update();
}
