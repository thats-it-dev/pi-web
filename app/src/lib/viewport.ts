// Keeps the app inside the part of the screen that's actually visible. iOS
// ignores interactive-widget=resizes-content: when the keyboard opens it keeps
// the layout full height and pans the page under it, which slides the header
// away and leaves the composer's home-indicator padding above the keyboard.
// So the app is sized to visualViewport and moved with it, and
// <html data-keyboard> drops the bottom safe-area padding while typing.
// The status bar is "default", not "black-translucent": with black-translucent,
// iOS 26 draws a home-screen app under the status bar but reports every height
// (innerHeight, 100dvh, visualViewport) short by it (WebKit bug 301108), so
// nothing measured lines up with the screen.

const KEYBOARD_MIN = 120; // px of height lost before it counts as a keyboard, not browser chrome

export interface ViewportInput {
	innerHeight: number;
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
	return { height: Math.round(v.height), top: Math.round(v.offsetTop), keyboard: v.innerHeight - v.height > KEYBOARD_MIN };
}

export function trackViewport(win: Window = window): void {
	const vv = win.visualViewport;
	if (!vv) return;
	const root = win.document.documentElement;
	const update = () => {
		const s = viewportState({ innerHeight: win.innerHeight, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale });
		if (!s) return;
		root.style.setProperty("--app-h", `${s.height}px`);
		root.style.setProperty("--app-top", `${s.top}px`);
		root.toggleAttribute("data-keyboard", s.keyboard);
	};
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	update();
}
