// Keeps the app inside the part of the screen that's actually visible. iOS
// ignores interactive-widget=resizes-content in Safari: when the keyboard opens
// it keeps the layout full height and pans the page under it, which slides the
// header away and leaves the composer's home-indicator padding above the
// keyboard. A home-screen app may instead shrink the layout viewport with the
// keyboard (innerHeight drops, no pan). Either way the app is sized to
// visualViewport and moved with it, and <html data-keyboard> drops the bottom
// safe-area padding while typing.
// A keyboard is measured against the tallest height seen at this width (not
// innerHeight, which the shrink case lowers), so it's recognised either way.
// The app never grows past the reported viewport: with the black-translucent
// status bar, iOS 26 reports a home-screen app a status bar short (WebKit bug
// 301108) and never paints that strip, so laying out into it only clips the
// bottom of the composer. index.html asks for the default status bar instead,
// which keeps the reported height honest.

const KEYBOARD_MIN = 120; // px of height lost before it counts as a keyboard, not browser chrome

export interface ViewportInput {
	full: number; // the height the page draws over: see fullHeight
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
	return { height: Math.round(v.height), top: Math.round(v.offsetTop), keyboard };
}

// The height the page draws over. In a browser that's innerHeight (the
// toolbars aren't ours). A home-screen app covers a fixed area that iOS may
// shrink while the keyboard is up, so the tallest height seen at this width
// (rotation changes the width) is the one to measure against.
export function fullHeight(m: { standalone: boolean; innerHeight: number; tallest: number }): number {
	return m.standalone ? Math.max(m.innerHeight, m.tallest) : m.innerHeight;
}

export function trackViewport(win: Window = window): void {
	const vv = win.visualViewport;
	if (!vv) return;
	const root = win.document.documentElement;
	const standalone = win.matchMedia("(display-mode: standalone)");
	const tallest = new Map<number, number>(); // by innerWidth, so each orientation remembers its own
	const update = () => {
		const width = win.innerWidth;
		const full = fullHeight({ standalone: standalone.matches, innerHeight: win.innerHeight, tallest: tallest.get(width) ?? 0 });
		tallest.set(width, full);
		const s = viewportState({ full, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale });
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
