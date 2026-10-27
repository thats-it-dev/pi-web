// The session and query screens (spec §4.2, §4.3), one View for both:
//   push("windows/text", { mode: "session" | "query", id })
// The clock bar, a header line (the label in the source's
// colour over a 1 px rule in the text colour), then the text, scrolled 40 px
// at a time by Up/Down. Select opens the action menu: the query's options and
// Skip, or Continue / Stop / Model / Archive. Notices: notice.js.
import { FONT_KEY, STATUS_BAR_LAYER_HEIGHT as BAR } from "pebble-ui/sdk";
import View from "pebble-ui/View";
import WindowStack from "pebble-ui/WindowStack";
import StatusBar from "pebble-ui/StatusBar";
import { palette, style, AMBER, BLACK } from "theme";
import { scrollClamp, drawerItems, ellipsize } from "model";
import { showNotice, hideNotice } from "notice";

const HEAD = 22; // the header line, under the clock
const TOP = 44; // the text
const INSET = 8;
const STEP = 40;
const MODELS_MS = 10000; // a models list later than this opens no menu
const WIDTH = screen.width - 2 * INSET; // given, not left/right: the text is measured before its window is laid out

const stack = () => WindowStack.current;

// What the window shows, from the model: null for a query that has left.
function shown(mode, id, m, p) {
	if (mode === "query") {
		const q = m.query;
		return q && q.id === id ? { label: q.label, text: q.text, color: q.source === "ring" ? p.ring : p.pi, options: q.options } : null;
	}
	const r = m.reply && m.reply.sessionId === id ? m.reply : null;
	const row = m.home.find(row => row.id === id);
	const status = r ? r.status : row && row.status;
	return { label: r ? r.label : row ? row.title : "", text: r ? r.text : "", color: status === "e" ? p.err : p.pi };
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
			this.update(screen);
		super.onDisplayed(screen);
		this.scroll(0);
		showNotice(this, screen);
	}
	onUndisplaying(screen) {
		this.displayed = false;
		hideNotice(this, screen);
		super.onUndisplaying(screen);
	}
	// The screen, made once per theme. A reply streaming in (4 a second) only
	// changes the strings and the header's style (fill): new Styles, a
	// StatusBar's among them, stay in the chunk heap until the next window
	// change (theme.js style), and rebuilding per reply ran it out in 3 s.
	build(screen) {
		const m = stack().model, p = palette(m.dark);
		this.dark = m.dark;
		this.stale = false;
		screen.empty();
		screen.skin = new Skin({ fill: p.bg });
		screen.add(new StatusBar({ font: "LECO_20_BOLD_NUMBERS", color: p.fg, background: p.bg }));
		this.head = new Label(null, { left: INSET, width: WIDTH, top: BAR, height: HEAD });
		screen.add(this.head);
		screen.add(new Content(null, { left: 0, right: 0, top: BAR + HEAD - 1, height: 1, skin: new Skin({ fill: p.fg }) }));
		const font = this.view.data.mode === "query" ? FONT_KEY.GOTHIC_24_BOLD : FONT_KEY.GOTHIC_18_BOLD;
		this.body = new Container(null, {
			left: 0, right: 0, top: TOP, bottom: 0, clip: true,
			contents: [new Text(null, { left: INSET, width: WIDTH, top: -this.view.offset, style: style(font, p.fg) })],
		});
		screen.add(this.body);
		// A notice showing stays on top through the rebuild.
		if (this.box)
			screen.add(this.box);
		this.fill();
	}
	fill() {
		const { mode, id } = this.view.data, m = stack().model, p = palette(m.dark);
		const c = this.shown = shown(mode, id, m, p) ?? { label: "", text: "", color: p.pi };
		// Not chained (head = this.head.style = …): on a bound Label, head.measure then threw.
		const head = style(FONT_KEY.GOTHIC_18_BOLD, c.color);
		this.head.style = head;
		this.head.string = ellipsize(c.label, WIDTH, s => head.measure(s).width);
		this.body.first.string = c.text;
	}
	update(screen) {
		if (this.dark !== stack().model.dark)
			this.build(screen);
		else {
			this.stale = false;
			this.fill();
		}
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
			view.wantModels = index === 2 ? Date.now() + MODELS_MS : 0;
		});
		return true;
	}
	onModel(screen, kind) {
		const view = this.view, { mode, id } = view.data, s = stack(), m = s.model;
		if (kind === "notice") {
			// e.g. "Couldn't load models": the menu is off
			view.wantModels = 0;
			showNotice(this, screen);
		}
		else if (kind === "models") {
			const list = m.models.list;
			if (Date.now() < view.wantModels && m.models.sessionId === id && list.length) {
				view.wantModels = 0;
				drawer(list.map(model => model.name), index => s.link.send("model", { SESSION_ID: id, PROVIDER: list[index].provider, MODEL_ID: list[index].id }));
			}
		}
		else {
			const p = palette(m.dark), c = shown(mode, id, m, p);
			// A query that left is popped by main.js; keep its last text until then.
			// Not while sliding (see home.js): one sliding in rebuilds when it lands.
			// Compared field by field: a key string (the text plus the rest) would keep
			// a second copy of the text and make another per dict, and a dict landing
			// during a slide, with both screens up, ran the chunk heap out.
			const was = this.shown;
			if (c && (m.dark !== this.dark || c.label !== was.label || c.text !== was.text || c.color !== was.color)) {
				if (!this.displayed)
					this.stale = true;
				else {
					this.update(screen);
					this.scroll(0);
				}
			}
		}
	}
}

const TextScreen = Container.template($ => ({
	left: 0, right: 0, top: 0, bottom: 0, Behavior: $.constructor.Behavior,
}));

export default class TextWindow extends View {
	static get Behavior() { return TextBehavior }
	get Template() { return TextScreen }
}
