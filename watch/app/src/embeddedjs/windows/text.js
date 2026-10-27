// The session and query screens (spec §4.2, §4.3), one View for both:
//   push("windows/text", { mode: "session" | "query", id })
// The clock bar, a header line (the label and a LECO time in the source's
// colour over a 1 px rule in the text colour), then the text, scrolled 40 px
// at a time by Up/Down. Select opens the action menu: the query's options and
// Skip, or Continue / Stop / Model / Archive. A notice shows for 2 s in a
// black box at the bottom.
import { FONT_KEY, STATUS_BAR_LAYER_HEIGHT as BAR, textLayerStyle } from "pebble-ui/sdk";
import Timer from "timer";
import View from "pebble-ui/View";
import WindowStack from "pebble-ui/WindowStack";
import StatusBar from "pebble-ui/StatusBar";
import { palette, AMBER, BLACK } from "theme";
import { scrollClamp, drawerItems } from "model";

const HEAD = 22; // the header line, under the clock
const TOP = 44; // the text
const INSET = 8;
const STEP = 40;
const AT_WIDTH = 52;
const NOTICE_MS = 2000;
const LECO_20 = "bold 20px Leco";
const WIDTH = screen.width - 2 * INSET; // given, not left/right: the text is measured before its window is laid out

const stack = () => WindowStack.current;

// What the window shows, from the model: null for a query that has left.
function shown(mode, id, m, p) {
	if (mode === "query") {
		const q = m.query;
		return q && q.id === id ? { label: q.label, at: q.at, text: q.text, color: q.source === "ring" ? p.ring : p.pi, options: q.options } : null;
	}
	const r = m.reply && m.reply.sessionId === id ? m.reply : null;
	const row = m.home.find(row => row.id === id);
	const status = r ? r.status : row && row.status;
	return { label: r ? r.label : row ? row.title : "", at: r ? r.at : "", text: r ? r.text : "", color: status === "e" ? p.err : p.pi };
}

function drawer(items, onSelect) {
	const p = palette(stack().model.dark);
	stack().push("pebble-ui/ActionMenu", { items, background: p.bg, crumb: p.fg, border: p.fg, sheet: BLACK, foreground: AMBER, onSelect });
}

class TextBehavior extends View.Behavior {
	onCreate(screen, view) {
		super.onCreate(screen, view);
		view.offset ??= 0;
		this.build(screen);
	}
	onDisplayed(screen) {
		this.displayed = true;
		if (this.stale)
			this.build(screen);
		super.onDisplayed(screen);
		this.scroll(0);
	}
	onUndisplaying(screen) {
		this.displayed = false;
		this.hideNotice(screen);
		super.onUndisplaying(screen);
	}
	build(screen) {
		const { mode, id } = this.view.data, m = stack().model, p = palette(m.dark);
		const c = this.shown = shown(mode, id, m, p) ?? { label: "", at: "", text: "", color: p.pi };
		this.key = m.dark + c.label + c.at + c.text + c.color;
		this.stale = false;
		this.hideNotice(screen);
		screen.empty();
		screen.skin = new Skin({ fill: p.bg });
		screen.add(new StatusBar({ font: "LECO_20_BOLD_NUMBERS", color: p.fg, background: p.bg }));
		screen.add(new Label(null, { left: INSET, right: INSET + AT_WIDTH, top: BAR, height: HEAD, style: textLayerStyle(FONT_KEY.GOTHIC_18_BOLD, c.color), string: c.label }));
		screen.add(new Label(null, { right: INSET, width: AT_WIDTH, top: BAR - 1, height: HEAD, style: textLayerStyle(LECO_20, c.color, "right"), string: c.at }));
		screen.add(new Content(null, { left: 0, right: 0, top: BAR + HEAD - 1, height: 1, skin: new Skin({ fill: p.fg }) }));
		const font = mode === "query" ? FONT_KEY.GOTHIC_24_BOLD : FONT_KEY.GOTHIC_18_BOLD;
		this.body = new Container(null, {
			left: 0, right: 0, top: TOP, bottom: 0, clip: true,
			contents: [new Text(null, { left: INSET, width: WIDTH, top: -this.view.offset, style: textLayerStyle(font, p.fg), string: c.text })],
		});
		screen.add(this.body);
	}
	// Moves the text by delta, its end kept at the bottom with an inset's room.
	// Only once laid out: on display, a press, a rebuild.
	scroll(delta) {
		const view = this.view, body = this.body, text = body.first;
		view.offset = scrollClamp(view.offset + delta, text.height + INSET, body.height);
		text.y = body.y - view.offset;
	}
	onPressUp(screen) {
		this.scroll(-STEP);
		return true;
	}
	onPressDown(screen) {
		this.scroll(STEP);
		return true;
	}
	onPressSelect(screen) {
		const view = this.view, { mode, id } = view.data, s = stack(), c = this.shown;
		if (mode === "query") {
			const n = c.options ? c.options.length : -1;
			if (n >= 0)
				drawer(drawerItems(mode, c.options), index => s.link.send(index < n ? "answer" : "skip", { ID: id, OK: index < n ? index : null }));
		}
		else drawer(drawerItems(mode), index => {
			const SESSION_ID = id;
			if (index === 3) {
				s.link.send("archive", { SESSION_ID });
				s.pop(s.depth);
				return;
			}
			s.link.send(["continue", "stop", "models"][index], { SESSION_ID });
			view.wantModels = index === 2;
		});
		return true;
	}
	onModel(screen, kind) {
		const view = this.view, { mode, id } = view.data, s = stack(), m = s.model;
		if (kind === "notice")
			this.notice(screen, m.notice);
		else if (kind === "models") {
			const list = m.models.list;
			if (view.wantModels && m.models.sessionId === id && list.length) {
				view.wantModels = false;
				drawer(list.map(model => model.name), index => s.link.send("model", { SESSION_ID: id, PROVIDER: list[index].provider, MODEL_ID: list[index].id }));
			}
		}
		else {
			const p = palette(m.dark), c = shown(mode, id, m, p);
			// A query that left is popped by main.js; keep its last text until then.
			// Not while sliding (see home.js): one sliding in rebuilds when it lands.
			if (c && m.dark + c.label + c.at + c.text + c.color !== this.key) {
				if (!this.displayed)
					this.stale = true;
				else {
					this.build(screen);
					this.scroll(0);
				}
			}
		}
	}
	// Only on a window that has landed (see onModel); one sliding misses it.
	notice(screen, string) {
		if (!this.displayed)
			return;
		this.hideNotice(screen);
		const text = new Text(null, { left: INSET, width: WIDTH - 2 * INSET, top: 3, style: textLayerStyle(FONT_KEY.GOTHIC_18_BOLD, "#FFFFFF"), string });
		const box = this.box = new Container(null, {
			left: INSET, right: INSET, bottom: INSET, height: 30,
			contents: [
				new RoundRect(null, { left: 0, right: 0, top: 0, bottom: 0, radius: 6, skin: new Skin({ fill: "#555555" }) }),
				new RoundRect(null, { left: 1, right: 1, top: 1, bottom: 1, radius: 5, skin: new Skin({ fill: BLACK }) }),
				text,
			],
		});
		screen.add(box);
		box.height = text.height + 8;
		this.timer = Timer.set(() => {
			this.timer = undefined;
			this.hideNotice(screen);
		}, NOTICE_MS);
	}
	hideNotice(screen) {
		if (this.timer !== undefined)
			Timer.clear(this.timer);
		this.timer = undefined;
		if (this.box)
			screen.remove(this.box);
		this.box = null;
	}
}

const TextScreen = Container.template($ => ({
	left: 0, right: 0, top: 0, bottom: 0, Behavior: $.constructor.Behavior,
}));

export default class TextWindow extends View {
	static get Behavior() { return TextBehavior }
	get Template() { return TextScreen }
}
