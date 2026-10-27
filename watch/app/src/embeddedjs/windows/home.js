// Home: the session list (spec §4.1) under the clock bar. One row per
// session: the title, a status line and a status dot; the selected row is
// amber with black text and a black outline round its dot. With no rows, or
// no hub, one full-screen line instead.
import { FONT_KEY, STATUS_BAR_LAYER_HEIGHT as BAR, textLayerStyle } from "pebble-ui/sdk";
import View from "pebble-ui/View";
import Menu, { TITLE_INSET } from "pebble-ui/Menu";
import WindowStack from "pebble-ui/WindowStack";
import StatusBar from "pebble-ui/StatusBar";
import { palette, AMBER, BLACK } from "theme";

const CELL = 44;
const DOT = 10;
const DOT_RIGHT = 12; // from the screen's edge
const RUNNING = "#0055AA"; // dots are the same in both themes
const STATUS = { w: "Waiting · approval", r: "Running", d: "Done", e: "Error" };

const stack = () => WindowStack.current;

function subLine(row) {
	const label = STATUS[row.status] ?? "";
	return row.sub && (row.status === "r" || row.status === "d") ? label + " · " + row.sub : label;
}

function message(m) {
	if (m.net === "unconfigured") return "Set the hub URL in the Pebble app";
	if (m.net === "offline") return "Hub unreachable";
	if (m.home.length) return null;
	return m.net === "connecting" ? "" : "No sessions";
}

// A filled circle, one row of pixels at a time (crisp, as the firmware draws it).
function disc(port, color, at, r) {
	for (let y = 0; y < 2 * r; y++) {
		const dy = y + 0.5 - r;
		const w = 2 * Math.round(Math.sqrt(r * r - dy * dy));
		port.fillColor(color, at + r - w / 2, at + y, w, 1);
	}
}

// The dot in a 12 px box: the 1 px black ring when the row is highlighted.
class DotBehavior extends Behavior {
	onCreate(port, color) {
		this.color = color;
	}
	onDraw(port) {
		if (this.ring)
			disc(port, BLACK, 0, DOT / 2 + 1);
		disc(port, this.color, 1, DOT / 2);
	}
}

class RowBehavior extends Behavior {
	onReload(row, highlighted) {
		const dot = row.last;
		dot.behavior.ring = highlighted;
		dot.invalidate();
	}
}

const Row = Container.template($ => ({
	left: 0, right: 0, Behavior: RowBehavior,
	contents: [
		Label($, { left: TITLE_INSET, right: DOT_RIGHT + DOT + 8, top: 2, height: 22, style: $.menu.styles[0], string: $.item.title }),
		Label($, { left: TITLE_INSET, right: DOT_RIGHT + DOT + 8, top: 23, height: 18, style: $.menu.styles[1], string: subLine($.item) }),
		Port($.menu.dots[$.item.status] ?? $.menu.dots.d, { right: DOT_RIGHT - 1, top: (CELL - DOT) / 2 - 1, width: DOT + 2, height: DOT + 2, Behavior: DotBehavior }),
	],
}));

const Message = Container.template($ => ({
	left: 0, right: 0, top: BAR, bottom: 0,
	contents: [
		Text($, { left: TITLE_INSET, right: TITLE_INSET, style: $.style, string: $.string }),
	],
}));

class HomeBehavior extends View.Behavior {
	onCreate(screen, view) {
		super.onCreate(screen, view);
		this.build(screen);
	}
	onDisplayed(screen) {
		this.displayed = true;
		if (this.stale)
			this.build(screen);
		super.onDisplayed(screen);
		this.menu?.focus();
	}
	onUndisplaying(screen) {
		this.displayed = false;
		this.remember();
		super.onUndisplaying(screen);
	}
	// The selected session, kept across rebuilds and while another window is up.
	remember() {
		const menu = this.view.menu;
		if (menu)
			this.view.selected = menu.items[menu.selection]?.id;
	}
	onModel(screen, kind) {
		// Not while sliding in or out: changing a window's contents during the
		// transition leaves the screen unpainted. One sliding in rebuilds when it lands.
		if (kind === "home" || kind === "net" || kind === "cfg") {
			if (!this.displayed)
				this.stale = true;
			else {
				this.build(screen);
				(this.menu ?? screen).focus();
			}
		}
	}
	build(screen) {
		const view = this.view, m = stack().model, p = palette(m.dark);
		this.stale = false;
		this.remember();
		// A held Up/Down repeats on a timer: stop it with the old menu.
		if (this.menu)
			this.menu.behavior.release(this.menu);
		this.menu = view.menu = null;
		screen.empty();
		screen.skin = new Skin({ fill: p.bg });
		screen.add(new StatusBar({ font: "LECO_20_BOLD_NUMBERS", color: p.fg, background: p.bg }));
		const string = message(m);
		if (string !== null) {
			screen.add(new Message({ string, style: textLayerStyle(FONT_KEY.GOTHIC_24_BOLD, p.fg) }));
			return;
		}
		const index = m.home.findIndex(row => row.id === view.selected);
		const menu = view.menu = new Menu({
			items: m.home, Item: Row, cellHeight: CELL, fixed: true, selection: index < 0 ? 0 : index,
			normal: [p.bg, p.fg], highlight: [AMBER, BLACK], onSelect: open,
		});
		menu.styles = [textLayerStyle(FONT_KEY.GOTHIC_18_BOLD, [p.fg, BLACK]), textLayerStyle(FONT_KEY.GOTHIC_14_BOLD, [p.sub, BLACK])];
		menu.dots = { w: AMBER, r: RUNNING, d: p.done, e: p.err };
		this.menu = new menu.Template(menu, { left: 0, right: 0, top: BAR, bottom: 0 });
		screen.add(this.menu);
	}
}

// Select: the session's pending query when it is the current one, else the session.
function open(index, row) {
	const s = stack(), query = s.model.query;
	if (row.status === "w" && query && query.sessionId === row.id)
		s.open("query", query.id);
	else {
		s.link.send("open", { SESSION_ID: row.id });
		s.open("session", row.id);
	}
}

const HomeScreen = Container.template($ => ({
	left: 0, right: 0, top: 0, bottom: 0, Behavior: $.constructor.Behavior,
}));

export default class Home extends View {
	static get Behavior() { return HomeBehavior }
	get Template() { return HomeScreen }
}
