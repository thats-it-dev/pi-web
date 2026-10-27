// The notice box (spec §4.3, the prototype's toast): the phone's notice text,
// white Gothic 18 Bold in a black rounded box at the bottom, for 2 s, on Home
// or a text window. main.js keeps the latest as WindowStack.current.notice
// ({ string, at }); a window shows it once it has landed, since changing a
// window while it slides leaves the screen unpainted. A notice older than
// 10 s (a drawer was up) is dropped.
import { FONT_KEY, textLayerStyle } from "pebble-ui/sdk";
import Timer from "timer";
import WindowStack from "pebble-ui/WindowStack";

const INSET = 8;
const SHOW_MS = 2000;
const STALE_MS = 10000;
const WIDTH = screen.width - 4 * INSET;

// behavior: a window's behavior with `displayed`; it keeps the box and timer.
export function showNotice(behavior, screen) {
	const s = WindowStack.current, n = s.notice;
	if (!n || !behavior.displayed)
		return;
	s.notice = null;
	if (Date.now() - n.at > STALE_MS)
		return;
	hideNotice(behavior, screen);
	const text = new Text(null, { left: INSET, width: WIDTH, top: 3, style: textLayerStyle(FONT_KEY.GOTHIC_18_BOLD, "#FFFFFF"), string: n.string });
	const box = behavior.box = new Container(null, {
		left: INSET, right: INSET, bottom: INSET, height: 30,
		contents: [
			new RoundRect(null, { left: 0, right: 0, top: 0, bottom: 0, radius: 6, skin: new Skin({ fill: "#555555" }) }),
			new RoundRect(null, { left: 1, right: 1, top: 1, bottom: 1, radius: 5, skin: new Skin({ fill: "#000000" }) }),
			text,
		],
	});
	screen.add(box);
	box.height = text.height + 8;
	behavior.noticeTimer = Timer.set(() => {
		behavior.noticeTimer = undefined;
		hideNotice(behavior, screen);
	}, SHOW_MS);
}

export function hideNotice(behavior, screen) {
	if (behavior.noticeTimer !== undefined)
		Timer.clear(behavior.noticeTimer);
	behavior.noticeTimer = undefined;
	if (behavior.box)
		screen.remove(behavior.box);
	behavior.box = null;
}
