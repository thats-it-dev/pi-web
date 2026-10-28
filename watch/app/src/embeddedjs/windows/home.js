// Home: the session list (spec §4.1) under the clock bar. First a "+ New
// session" row, then one row per session: the title, a status line and, for
// running and waiting sessions, a status dot; the selected row is amber with
// black text and a black outline round its dot. With no hub, one full-screen line instead.
import { FONT_KEY, STATUS_BAR_LAYER_HEIGHT as BAR } from "pebble-ui/sdk";
import View from "pebble-ui/View";
import Menu, { TITLE_INSET } from "pebble-ui/Menu";
import WindowStack from "pebble-ui/WindowStack";
import StatusBar from "pebble-ui/StatusBar";
import { palette, style, AMBER, BLACK } from "theme";
import { showNotice, hideNotice } from "notice";
import { ellipsize } from "model";

const CELL = 56;
const DOT = 10;
const DOT_RIGHT = 12; // from the screen's edge
const RUNNING = "#0055AA"; // dots are the same in both themes
const STATUS = { w: "Waiting · approval", r: "Running", d: "Done", e: "Error" };
const NEW = { id: "+", title: "+ New session" }; // the first row (spec §8a); not a session, never sent

const stack = () => WindowStack.current;

function subLine(row) {
	const label = STATUS[row.status] ?? "";
	return row.sub && (row.status === "r" || row.status === "d") ? label + " · " + row.sub : label;
}

function message(m) {
	if (m.net === "unconfigured") return "Set the hub URL in the Pebble app";
	if (m.net === "offline") return "Hub unreachable";
	return m.home.length || m.net !== "connecting" ? null : "";
}

// A filled circle, one row of pixels at a time (crisp, as the firmware draws it).
function disc(port, color, x, y, r) {
	for (let i = 0; i < 2 * r; i++) {
		const dy = i + 0.5 - r;
		const w = 2 * Math.round(Math.sqrt(r * r - dy * dy));
		port.fillColor(color, x + r - w / 2, y + i, w, 1);
	}
}

// A row is one Port (one content per row: the Menu builds them all and Home
// stays under the windows it opens, so Labels per row run the chunk heap out
// at about seven rows). It draws what two Labels and a dot Port drew: the
// title (Gothic 24 Bold) and status line (Gothic 18 Bold) with the Labels'
// boxes and styles (textLayerStyle's offsets, [normal, highlighted] colours
// by the row's state), and the dot (running and waiting rows only) in a 12 px box, ringed when highlighted.
const TEXT_W = screen.width - TITLE_INSET - (DOT_RIGHT + DOT + 8);

class RowBehavior extends Behavior {
	// Strings are chunk heap too: the clipped title replaces the row's own (the
	// original is freed; the session window's header falls back to it until its
	// reply arrives), and the status line is made at each draw.
	onCreate(port, $) {
		const menu = $.menu, row = $.item;
		this.menu = menu;
		this.row = row;
		row.title = ellipsize(row.title, TEXT_W, s => menu.styles[0].measure(s).width);
		this.state = 0;
	}
	// The Menu sets each row's state too, but a Port's state is write-only.
	onReload(port, highlighted) {
		this.state = highlighted ? 1 : 0;
		port.invalidate();
	}
	onDraw(port) {
		const state = this.state, menu = this.menu, styles = menu.styles, row = this.row;
		port.drawStyle(row.title, styles[0], TITLE_INSET, row === NEW ? 14 : 2, TEXT_W, 28, false, state);
		port.drawStyle(subLine(row), styles[1], TITLE_INSET, 30, TEXT_W, 22, false, state);
		if (row.status !== "r" && row.status !== "w")
			return; // done and error rows have no dot
		const x = port.width - DOT_RIGHT + 1 - (DOT + 2), y = (CELL - DOT) / 2 - 1;
		if (state)
			disc(port, BLACK, x, y, DOT / 2 + 1);
		disc(port, menu.dots[row.status], x + 1, y + 1, DOT / 2);
	}
}

const Row = Port.template($ => ({ left: 0, right: 0, Behavior: RowBehavior }));

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
		showNotice(this, screen);
	}
	onUndisplaying(screen) {
		this.displayed = false;
		hideNotice(this, screen);
		this.remember();
		// Home is rebuilt when it comes back, so its view keeps only the selection
		// in history: the menu would hold the rows it was built from, a second
		// copy once the next home dict arrives (a running session sends one a
		// second), and that tipped a slide back from the drawer into memory full.
		this.view.menu = null;
		super.onUndisplaying(screen);
	}
	// The selected session, kept across rebuilds and while another window is up.
	remember() {
		const menu = this.view.menu;
		if (menu)
			this.view.selected = menu.items[menu.selection]?.id;
	}
	onModel(screen, kind) {
		if (kind === "notice")
			showNotice(this, screen);
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
		// Kept across rebuilds: each new StatusBar's Style stays in the chunk heap (theme.js style).
		if (this.dark !== m.dark) {
			this.dark = m.dark;
			this.bar = new StatusBar({ font: "LECO_20_BOLD_NUMBERS", color: p.fg, background: p.bg });
		}
		screen.add(this.bar);
		const string = message(m);
		if (string !== null)
			screen.add(new Message({ string, style: style(FONT_KEY.GOTHIC_24_BOLD, p.fg) }));
		else
			this.addMenu(screen, view, m, p);
		// A notice showing stays on top through the rebuild.
		if (this.box)
			screen.add(this.box);
	}
	addMenu(screen, view, m, p) {
		// The cursor starts on the first session (a waiting one, if any: the phone
		// sends those first), or on the row last selected, "+" included (a rebuild,
		// one a second while a session runs, keeps it there); "+" is one Up away.
		const items = [NEW].concat(m.home), index = items.findIndex(row => row.id === view.selected);
		const menu = view.menu = new Menu({
			items, Item: Row, cellHeight: CELL, fixed: true, selection: index < 0 ? Math.min(1, m.home.length) : index,
			normal: [p.bg, p.fg], highlight: [AMBER, BLACK], onSelect: open,
		});
		menu.styles = [style(FONT_KEY.GOTHIC_24_BOLD, [p.fg, BLACK]), style(FONT_KEY.GOTHIC_18_BOLD, [p.sub, BLACK])];
		menu.dots = { w: AMBER, r: RUNNING };
		this.menu = new menu.Template(menu, { left: 0, right: 0, top: BAR, bottom: 0 });
		screen.add(this.menu);
	}
}

// Select: "+" asks the phone for a new session; the first reply within 15 s
// opens it (main.js sessionUntil, as for a session alert; a notice, e.g. the
// hub refusing, disarms it). A session's pending query when it is the current
// one; else the session.
function open(index, row) {
	const s = stack(), query = s.model.query;
	if (row === NEW) {
		s.sessionUntil = Date.now() + 15000;
		s.link.send("new");
	}
	else if (row.status === "w" && query && query.sessionId === row.id)
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
