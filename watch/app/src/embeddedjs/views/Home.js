// Home: the request screen (spec §7.2, §7.3) and home with nothing pending (§7.5).
// Pieces top to bottom (§7.1): status line, toolbar, query block (+ hint when
// nothing is pending), rule, menu rows.
//
// The query block is whole lines of Labels: a request's first lines, or else the
// end of the current session's reply, live while it streams (§7.5); the speed
// blinks while the session runs. Say it (§7.4): the firmware's dictation UI
// (with its own confirm screen) takes the words; the transcript then shows under
// the query, right-aligned and inset 32 px like a user turn in history (§7.8),
// while it goes out as an answer to the request on screen, or as a prompt to the
// current session when nothing is pending. m.sayIt holds the state (model.js);
// this view drives the transitions.
import { METRICS, ROUND } from "assets";
import { homeRows } from "model";
import { toolbar, statusLeft, queryText, hint, tailLines, wrapLines } from "format";
import Menu from "Menu";
import { Status, Rule } from "ListScreen";
import Timer from "timer";
import View from "piu/View";
import Dictation from "pebble/dictation";

const PAD = METRICS.pad;
const HINT = 16; // 14 px type on a 16 px line
const GAP = 2; // paper between the rule and the rows, so a selected first row does not fuse with the rule
const LINE = 22; // a body line (18 px type)
const USER_INSET = 32; // a user turn's left inset (§7.8)
const SAY_GAP = 4;
const UNMATCHED = 18; // the 14 px no_match line and the gap above it
const HOLD_MS = 500;
const FLASH_MS = 1000;
const WAIT_MS = 10000; // no result by then: treat as failed
const EXIT_MS = 400;
const BLINK_MS = 500;
// Say-it states during which the screen keeps the request it showed (a home that
// arrives meanwhile is held until the transcript's result has landed).
const SAY_HOLD = { listening: 1, sending: 1, sent: 1, gone: 1, failed: 1 };
const SAY_LABEL = { sent: "sent", gone: "already answered" };
const IDLE = { status:"idle", text:"", options:[] };

function close(d) {
	try {
		d.close();
	}
	catch (e) {
	}
}

// CTX, the context bar, percent, speed (blinks, see blink()), model. Centred on Round 2.
const Toolbar = Row.template($ => {
	const t = toolbar($);
	const style = controller.theme.styles.small;
	const skins = controller.theme.skins;
	return {
		...(ROUND ? null : { left:PAD }), top:METRICS.status, height:METRICS.toolbar,
		contents: [
			Label($, { style, string:"CTX" }),
			Container($, {
				left:4, width:METRICS.bar, height:8, skin:skins.track,
				contents: [
					Content($, { left:0, top:0, bottom:0, width:Math.round(Math.max(0, Math.min(100, t.percent || 0)) * METRICS.bar / 100), skin:skins.ink }),
				],
			}),
			Label($, { left:4, style, string:t.ctx }),
			Label($, { left:6, style, string:t.speed }),
			Label($, { left:6, style, string:t.model || "--" }),
		],
	};
});

class HomeBehavior extends View.Behavior {
	onCreate(container, view) {
		super.onCreate(container, view);
		this.c = container;
		this.pending = null; // { cmdId, index, title, done }: a picked row awaiting its result
	}
	onDisplaying() {
		this.build();
	}
	onDisplayed() {
		this.menu.focus();
	}
	onUndisplaying(container) {
		// A timer would keep this screen alive and build into it after it left;
		// so would a say-it in flight, whose timers go with this screen.
		Timer.clear(this.hold);
		Timer.clear(this.timer);
		Timer.clear(this.blinker);
		this.drop();
		if (this.sayHold()) this.m.setSayIt(IDLE);
		super.onUndisplaying(container);
	}
	get m() {
		return controller.model;
	}
	sayHold() {
		return !!SAY_HOLD[this.m.sayIt.status];
	}

	// Rendering ----------------------------------------------------------

	// keep: rebuild for a say-it step without taking up a home that arrived meanwhile.
	build(keep) {
		const c = this.c;
		const m = this.m;
		if (!keep || !this.home) {
			this.home = m.home;
			this.id = (m.home && m.home.requestId) || null; // the request on screen; m.home may already hold the next one
			// A no_match belongs to the request it was said to; a different one clears it.
			if (m.sayIt.status === "no_match" && m.sayIt.reqId !== this.id) m.setSayIt(IDLE);
		}
		const home = this.home;
		const rows = homeRows(home, m.sayIt);
		const height = rows.length * METRICS.row;
		const ruleTop = c.height - METRICS.bottom - height - GAP - METRICS.rule;
		const top = METRICS.status + METRICS.toolbar + 2;
		this.at = [top, ruleTop - top - (this.id ? 0 : HINT)];

		// A rebuild during a held Up/Down: stop the old menu's repeat, whose timer would keep the old tree alive.
		if (this.menu) this.menu.behavior.onRelease(this.menu);
		c.empty();
		c.add(new Status(statusLeft(home, m.net)));
		c.add(new Toolbar(m.stats));
		c.add(this.query(...this.at));
		if (!this.id)
			c.add(new Label(null, { left:PAD, right:PAD, top:ruleTop - HINT, height:HINT, style:controller.theme.styles.hint, string:hint(home, m.stats) }));
		c.add(new Rule(ruleTop));

		// `sending…` is not a choice: the bar starts on `say it again`, and the status row stays dim.
		const key = rows.join("\n");
		const selection = this.list && this.key === key ? this.list.selection : rows[0] === "sending…" ? 1 : 0;
		this.key = key;
		this.list = new Menu({ items:rows.map(title => ({ title, dim:title === "sending…" })), selection });
		c.add(this.menu = new this.list.Template(this.list, { left:0, right:0, bottom:METRICS.bottom, height }));
		this.stale = false;
		if (controller.view === this.view) this.menu.focus();
		this.blink();
	}
	// The query block as whole lines: the request's first lines, else the end of
	// the session's reply; then a transcript as a user turn (at most two lines, its
	// end), then the no_match line (14 px).
	query(top, height) {
		const m = this.m;
		const say = m.sayIt;
		const home = this.home;
		const styles = controller.theme.styles;
		const width = this.c.width - 2 * PAD;
		const said = say.text && say.status !== "idle" && say.status !== "listening" ? say.text : "";
		const unmatched = say.status === "no_match" ? "didn't match: " + say.options.join(", ") : "";
		const extra = said ? SAY_GAP + (unmatched ? UNMATCHED : 0) : 0;
		const saidLines = said ? tailLines(said, width + PAD - USER_INSET, s => styles.bodyRight.measure(s).width, Math.max(1, Math.min(2, Math.floor((height - extra - 2 * LINE) / LINE)))) : [];
		const n = Math.floor((height - extra - saidLines.length * LINE) / LINE);
		const measure = s => styles.query.measure(s).width;
		// The live reply (a text tail) once one has come for this session, else the last reply.
		const t = m.text;
		const text = this.id ? queryText(home) : t && home && t.sessionId === home.sessionId ? t.text : home ? home.lastText : "";
		let lines = wrapLines(text, width, measure);
		if (lines.length > n) lines = this.id ? lines.slice(0, n) : tailLines(text, width, measure, n);
		const contents = lines.map((string, k) => new Label(null, { left:PAD, right:PAD, top:k * LINE, height:LINE, style:styles.query, string }));
		let y = lines.length * LINE + SAY_GAP;
		for (const string of saidLines) {
			contents.push(new Label(null, { left:USER_INSET, right:PAD, top:y, height:LINE, style:styles.bodyRight, string }));
			y += LINE;
		}
		if (unmatched)
			contents.push(new Label(null, { left:PAD, right:PAD, top:y + 2, height:HINT, style:styles.meta, string:unmatched }));
		return new Container(null, { left:0, right:0, top, height, clip:true, contents });
	}
	// The speed figure blinks while the session runs (§7.1), and shows once it stops.
	blink() {
		const s = this.m.stats;
		if (!s || s.state !== "running") {
			Timer.clear(this.blinker);
			this.blinker = undefined;
		}
		else if (this.blinker === undefined) {
			this.blinker = Timer.repeat(() => {
				const speed = this.c.content(1).content(3);
				speed.visible = !speed.visible;
			}, BLINK_MS);
		}
	}
	// A row's string, in the row style (the `sending…` row is dim).
	label(index, string) {
		const row = this.menu.last.content(index);
		if (!row) return;
		row.first.string = string;
		row.first.style = controller.theme.styles.row;
	}
	// One timer for a row's wait and feedback (a pick and a say-it never overlap).
	after(ms, fn) {
		Timer.clear(this.timer);
		this.timer = Timer.set(() => {
			this.timer = undefined;
			fn();
		}, ms);
	}
	// A row shows `string` for a second, then end() runs.
	flash(index, string, end) {
		this.label(index, string);
		this.after(FLASH_MS, end);
	}

	// Model --------------------------------------------------------------

	onModel(container, kind) {
		if (!container.length) return; // not built yet; onDisplaying builds from the model
		if (kind === "result") this.onResult();
		else if (kind === "home") {
			// Keep the row feedback, or a transcript being said or sent, on screen;
			// the new request shows when it ends.
			if (this.pending || this.sayHold()) this.stale = true;
			else this.build();
		}
		else if (kind === "stats") {
			container.replace(container.content(1), new Toolbar(this.m.stats));
			if (!this.id) container.content(3).string = hint(this.home, this.m.stats);
			this.blink();
		}
		else if (kind === "net")
			container.first.first.string = statusLeft(this.home, this.m.net);
		else if (kind === "text" && !this.id)
			container.replace(container.content(2), this.query(...this.at));
	}

	// Picking ------------------------------------------------------------

	onSelect(container, index, item) {
		const home = this.home;
		const id = this.id;
		const title = item.title;
		if (this.pending || this.exiting) return true;
		if (title === "say it" || title === "say it again")
			this.sayIt(index, title);
		else if (this.sayHold())
			; // `sending…` is not a choice
		else if (id && home.kind === "dialog" && index < home.options.length)
			this.wait(index, title, controller.link.send("answer", { REQ_ID:id, OPTION:title }));
		else if (title === "dismiss" && id)
			this.wait(index, title, controller.link.send("dismiss", { REQ_ID:id }));
		else if (title === "menu")
			controller.goTo("MenuView");
		return true;
	}
	wait(index, title, cmdId) {
		this.label(index, "…");
		this.pending = { cmdId, index, title };
		this.after(WAIT_MS, () => this.settle("failed"));
	}
	// `sent`, `already answered` or `failed` for a second; then the request that
	// came meanwhile, or the row as it was.
	settle(string) {
		const p = this.pending;
		p.done = true;
		this.flash(p.index, string, () => {
			this.pending = null;
			if (this.stale) this.build();
			else this.label(p.index, p.title);
		});
	}
	onResult() {
		if (this.sayCmd !== undefined && this.m.sayIt.status !== "sending") {
			this.sayCmd = undefined;
			this.onSayResult();
		}
		const p = this.pending;
		const r = p && !p.done && this.m.takeResult(p.cmdId);
		if (r) this.settle(r.ok ? "sent" : r.reason === "gone" ? "already answered" : "failed");
	}

	// Say it -------------------------------------------------------------

	sayIt(index, title) {
		const m = this.m;
		Timer.clear(this.timer);
		this.sayCmd = undefined; // a transcript still out is superseded; its result is ignored
		// A fresh session each round; the last one was closed when it ended.
		this.drop();
		try {
			const view = this;
			const d = this.dictation = new Dictation({
				onReadable() {
					view.onDictated(this.read());
				},
				onError(status) {
					// errorDialogs: true, so the firmware has shown (or shows) its own dialog.
					console.log("pi-web: dictation error " + status);
					view.onDictated("");
				},
			});
			d.configure({ confirm:true, errorDialogs:true });
			d.start();
		}
		catch (e) {
			console.log("pi-web: dictation unavailable: " + e);
			this.drop();
			if (this.sayHold()) {
				// `say it again` while a transcript was out: back to the usual rows.
				m.setSayIt(IDLE);
				this.build();
				title = "say it";
				index = homeRows(this.home, m.sayIt).indexOf(title);
			}
			this.pending = { cmdId:0, index, title };
			this.settle("failed");
			return;
		}
		m.setSayIt({ status:"listening" });
	}
	// The transcript, or "" when dictation ended without one.
	onDictated(text) {
		const m = this.m;
		this.drop(true);
		text = text ? String(text).trim() : "";
		if (m.sayIt.status !== "listening") return;
		if (!text) {
			this.sayIdle();
			return;
		}
		const id = this.id;
		const cmdId = this.sayCmd = id
			? controller.link.send("answer", { REQ_ID:id, TEXT:text })
			: controller.link.send("prompt", { SESSION_ID:(this.home && this.home.sessionId) || undefined, TEXT:text });
		m.setSayIt({ status:"sending", text, cmdId, reqId:id, options:[] });
		this.build(true);
		this.after(WAIT_MS, () => {
			if (this.sayCmd !== cmdId || m.sayIt.status !== "sending") return;
			this.sayCmd = undefined;
			m.setSayIt({ status:"failed" });
			this.onSayResult();
		});
	}
	onSayResult() {
		const s = this.m.sayIt.status;
		if (s === "no_match") {
			// The request is still open: show what did not match and bring its options back.
			Timer.clear(this.timer);
			this.build();
		}
		else this.flash(0, SAY_LABEL[s] || "failed", () => this.sayIdle());
	}
	sayIdle() {
		this.m.setSayIt(IDLE);
		this.build();
	}
	// Closes the dictation session; from inside its callback, once that has
	// returned (the firmware may still touch it while its callback runs).
	drop(later) {
		const d = this.dictation;
		this.dictation = null;
		if (d) {
			if (later) Timer.set(() => close(d), 0);
			else close(d);
		}
	}

	// Buttons ------------------------------------------------------------

	onPressSelect() {
		Timer.clear(this.hold);
		this.hold = Timer.set(() => {
			this.hold = undefined;
			if (controller.view === this.view && !this.exiting) controller.goTo("MenuView");
		}, HOLD_MS);
		return true;
	}
	onReleaseSelect() {
		if (this.hold !== undefined) {
			Timer.clear(this.hold);
			this.hold = undefined;
			this.menu.behavior.pick(this.menu);
		}
		return true;
	}
	onPressBack() {
		if (this.exiting) return true;
		const id = this.id;
		// Nothing shown, or the shown request was just answered/dismissed (row feedback
		// still up, m.home may already be the next request): exit without a dismiss.
		// A false return lets the firmware pop the app if the FFI exit is unavailable.
		if (!id || this.pending || this.stale || this.sayHold())
			return controller.exit();
		this.exiting = true;
		controller.link.send("dismiss", { REQ_ID:id });
		// Exit once the dismiss has gone out (next onWritable) or after EXIT_MS, whichever is first.
		let done = false;
		const leave = () => {
			if (done) return;
			done = true;
			// If the FFI exit fails, let the next Back through (it then returns false to the firmware).
			if (!controller.exit()) this.exiting = false;
		};
		Timer.set(leave, EXIT_MS);
		controller.link.onFlushed(leave);
		return true;
	}
}

const HomeContainer = Container.template($ => ({
	left:0, right:0, top:0, bottom:0, Behavior:HomeBehavior,
}));

export default class extends View {
	static get Behavior() { return HomeBehavior }
	get Template() { return HomeContainer }
};
