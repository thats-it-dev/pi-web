// Home: the request screen (spec §7.2, §7.3) and home with nothing pending (§7.5).
// Pieces top to bottom (§7.1): status line, toolbar, query block (+ hint when
// nothing is pending), rule, menu rows.
//
// Say it (§7.4): the firmware's dictation UI (with its own confirm screen) takes
// the words; the transcript then shows under the query, right-aligned and inset
// 32 px like a user turn in history (§7.8), while it goes out as an answer to the
// request on screen, or as a prompt to the current session when nothing is
// pending. m.sayIt holds the state (model.js); this view drives the transitions.
import { METRICS } from "assets";
import { homeRows } from "model";
import { toolbar, statusLeft, clock, queryText, hint, tailLines } from "format";
import Menu from "Menu";
import Timer from "timer";
import View from "piu/View";
import Dictation from "pebble/dictation";

const PAD = 4;
const HINT = 16; // 14 px type on a 16 px line
const GAP = 2; // paper between the rule and the rows, so a selected first row does not fuse with the rule
const HOLD_MS = 500;
const FLASH_MS = 1000;
const WAIT_MS = 10000; // no result by then: treat as failed
const EXIT_MS = 400;
const USER_INSET = 32; // a user turn's left inset (§7.8)
const SAY_GAP = 4;
const LINE = 22; // a body line (18 px type, 22 px leading)
const UNMATCHED = 18; // the 14 px no_match line and the gap above it
// Say-it states during which the screen keeps the request it showed (a home that
// arrives meanwhile is held until the transcript's result has landed).
const SAY_HOLD = { listening: 1, sending: 1, sent: 1, gone: 1, failed: 1 };
const SAY_LABEL = { sent: "sent", gone: "already answered", failed: "failed" };

const Status = Container.template($ => ({
	left:0, right:0, top:0, height:METRICS.status,
	contents: [
		Label($, { left:PAD, right:60, top:1, style:$.styles.small, string:$.left }),
		Label($, { right:PAD, width:56, top:1, style:$.styles.smallRight, string:$.right }),
	],
}));

const Toolbar = Row.template($ => ({
	left:PAD, right:PAD, top:METRICS.status, height:METRICS.toolbar,
	contents: [
		Label($, { style:$.styles.small, string:"CTX" }),
		Container($, {
			left:4, width:METRICS.bar, height:8, skin:$.skins.track,
			contents: [
				Content($, { left:0, top:0, bottom:0, width:$.fill, skin:$.skins.ink }),
			],
		}),
		Label($, { left:4, style:$.styles.small, string:$.ctx }),
		Label($, { left:6, style:$.styles.small, string:$.speed }),
		Label($, { left:6, style:$.styles.small, string:$.model }),
	],
}));

// The query block: the query text, then (after say it) the transcript as a user
// turn, right-aligned, same ink, no fill, then the no_match line (14 px). With a
// transcript, the query text area is whole lines and the transcript at most two
// Labels (its end, see layoutSaid), so the request stays in view and no line is cut.
const Query = Container.template($ => ({
	left:0, right:0, top:$.top, height:$.height, clip:true,
	contents: [
		Container($, {
			left:0, right:0, top:0, height:$.textHeight, clip:true,
			contents: [
				Text($, { left:PAD, right:PAD, top:0, style:$.styles.body, string:$.string }),
			],
		}),
		...$.said.map((line, k) => Label($, { left:USER_INSET, right:PAD, top:$.saidTop + k * LINE, height:LINE, style:$.styles.bodyRight, string:line })),
		$.unmatched ? Label($, { left:PAD, right:PAD, top:$.unmatchedTop, height:HINT, style:$.styles.meta, string:$.unmatched }) : null,
	],
}));

// Splits the query block between the query text and the transcript: the request
// keeps two lines where it can, the transcript gets one or two, all whole lines.
function layoutSaid(styles, width, height, said, unmatched) {
	if (!said) return { textHeight:height, said:[], saidTop:0, unmatchedTop:height - HINT };
	const extra = SAY_GAP + (unmatched ? UNMATCHED : 0);
	const max = Math.max(1, Math.min(2, Math.floor((height - extra - 2 * LINE) / LINE)));
	const style = styles.bodyRight;
	const lines = tailLines(said, width - USER_INSET - PAD, s => style.measure(s).width, max);
	const textHeight = Math.max(0, Math.floor((height - extra - lines.length * LINE) / LINE) * LINE);
	const saidTop = textHeight + SAY_GAP;
	return { textHeight, said:lines, saidTop, unmatchedTop:saidTop + lines.length * LINE + 2 };
}

const Hint = Label.template($ => ({
	left:PAD, right:PAD, top:$.top, height:HINT, style:$.styles.meta, string:$.string,
}));

const Rule = Content.template($ => ({
	left:0, right:0, top:$.top, height:METRICS.rule, skin:$.skins.rule,
}));

function toolbarData(theme, stats) {
	const t = toolbar(stats);
	const p = t.percent === null ? 0 : Math.max(0, Math.min(100, t.percent));
	return {
		styles: theme.styles,
		skins: theme.skins,
		fill: Math.round(p * METRICS.bar / 100),
		ctx: t.ctx,
		speed: t.speed,
		model: t.model || "--",
	};
}

class HomeBehavior extends View.Behavior {
	onCreate(container, view) {
		super.onCreate(container, view);
		this.pending = null; // { cmdId, index, title, timer }
		this.stale = false;
		this.exiting = false;
		this.shownId = null; // the request on screen; m.home may already hold the next one
		this.shownHome = null; // the home dict the screen was built from
		this.dictation = null;
		this.sayTimer = undefined; // say-it result wait, then its 1 s row feedback
		this.sayCmd = undefined; // the say-it command awaiting its result
	}
	onDisplaying(container) {
		this.build(container);
	}
	onDisplayed(container) {
		this.focusMenu(container);
	}
	onUndisplaying(container) {
		this.clearHold();
		// A wait or flash timer would keep this screen alive and build into it after it left.
		const p = this.pending;
		if (p && p.timer !== undefined) Timer.clear(p.timer);
		this.pending = null;
		this.stale = false;
		this.clearSayTimer();
		this.closeDictation();
		// The timers that would settle a say-it in flight go with this screen.
		if (SAY_HOLD[this.m.sayIt.status]) this.m.setSayIt({ status:"idle", text:"", options:[] });
		super.onUndisplaying(container);
	}

	// Rendering ----------------------------------------------------------

	get m() {
		return controller.model;
	}
	pendingRequest() {
		return !!this.shownId;
	}
	sayHold() {
		return !!SAY_HOLD[this.m.sayIt.status];
	}
	queryString() {
		const m = this.m;
		const home = this.shownHome;
		if (this.pendingRequest()) return queryText(home);
		// A home dict can arrive mid-stream with an older lastText: the live tail wins.
		const t = m.text;
		if (t && home && t.sessionId === home.sessionId && t.streaming) return t.text;
		return home ? home.lastText : "";
	}
	// keep: rebuild for a say-it step without taking up a home that arrived meanwhile.
	build(container, keep) {
		const theme = controller.theme;
		const m = this.m;
		if (!keep || !this.shownHome) {
			this.shownHome = m.home;
			this.shownId = (m.home && m.home.requestId) || null;
			// A no_match belongs to the request it was said to; a different one clears it.
			if (m.sayIt.status === "no_match" && m.sayIt.reqId !== this.shownId)
				m.setSayIt({ status:"idle", text:"", options:[] });
		}
		const home = this.shownHome;
		const say = m.sayIt;
		const rows = homeRows(home, say);
		const items = rows.map(title => ({ title, dim:title === "sending…" }));
		const menuHeight = rows.length * METRICS.row;
		const ruleTop = container.height - menuHeight - GAP - METRICS.rule;
		const top = METRICS.status + METRICS.toolbar + 2;
		const withHint = !this.pendingRequest();
		const queryHeight = ruleTop - top - (withHint ? HINT : 0);
		const showSaid = say.text && say.status !== "idle" && say.status !== "listening";
		const unmatched = say.status === "no_match" ? "didn't match: " + (say.options || []).join(", ") : "";

		// A rebuild during a held Up/Down: stop the old menu's repeat, whose timer would keep the old tree alive.
		if (this.menu) this.menu.behavior.onRelease(this.menu);
		container.empty();
		container.add(new Status({ styles:theme.styles, left:statusLeft(home, m.net), right:clock(new Date(), controller.h24) }));
		container.add(new Toolbar(toolbarData(theme, m.stats)));
		const layout = layoutSaid(theme.styles, container.width, queryHeight, showSaid ? say.text : "", unmatched);
		const query = new Query({ styles:theme.styles, top, height:queryHeight, string:this.queryString(), unmatched, ...layout });
		container.add(query);
		if (layout.said.length) this.tuckSaid(query, layout.textHeight);
		if (withHint)
			container.add(new Hint({ styles:theme.styles, top:top + queryHeight, string:hint(home, m.stats) }));
		container.add(new Rule({ skins:theme.skins, top:ruleTop }));

		// `sending…` is not a choice: the bar starts on `say it again`, and the status row stays dim.
		const first = items.length > 1 && items[0].dim ? 1 : 0;
		const selection = this.menuView && this.rowsKey === rows.join("\n") ? this.menuView.selection : first;
		this.rowsKey = rows.join("\n");
		this.menuView = new Menu({ items, styles:theme.styles, skins:theme.skins, selection });
		this.menu = new this.menuView.Template(this.menuView, { left:0, right:0, bottom:0, height:menuHeight });
		container.add(this.menu);
		this.stale = false;
	}
	focusMenu(container) {
		if (controller.view === this.view && this.menu)
			this.menu.focus();
	}
	rebuild(container, keep) {
		this.build(container, keep);
		this.focusMenu(container);
	}
	// A short query leaves room above the transcript: once Piu has laid out the text,
	// move the transcript (and no_match line) up to sit under its last line.
	tuckSaid(query, textHeight) {
		Timer.set(() => {
			if (!query.container) return;
			const used = Math.ceil(query.first.first.height / LINE) * LINE;
			const shift = textHeight - used;
			if (shift < LINE) return;
			for (let c = query.first.next; c; c = c.next)
				c.y -= shift;
		}, 0);
	}
	rowLabel(index, string, style) {
		const row = this.menu && this.menu.last.content(index);
		if (!row) return;
		row.first.string = string;
		if (style) row.first.style = style;
	}

	// Model --------------------------------------------------------------

	onModel(container, kind) {
		if (!container.length) return; // not built yet; onDisplaying builds from the model
		if (kind === "result") {
			this.onResult(container);
			return;
		}
		if (kind === "home") {
			// Keep the row feedback, or a transcript being said or sent, on screen;
			// the new request shows when it ends.
			if (this.pending || this.sayHold()) this.stale = true;
			else this.rebuild(container);
			return;
		}
		if (kind === "stats") {
			container.replace(container.content(1), new Toolbar(toolbarData(controller.theme, this.m.stats)));
			if (!this.pendingRequest()) {
				const h = this.hintLabel(container);
				if (h) h.string = hint(this.shownHome, this.m.stats);
			}
			return;
		}
		if (kind === "net") {
			container.first.first.string = statusLeft(this.shownHome, this.m.net);
			return;
		}
		if (kind === "text") {
			const t = this.m.text;
			const home = this.shownHome;
			if (!this.pendingRequest() && t && home && t.sessionId === home.sessionId)
				container.content(2).first.first.string = t.text;
		}
	}
	hintLabel(container) {
		const c = container.content(3);
		return c && c instanceof Label ? c : null;
	}
	onClockChanged(container, clockData) {
		const status = container.first;
		if (status) status.last.string = clock(new Date(), controller.h24);
	}

	// Picking ------------------------------------------------------------

	onSelect(container, index, item) {
		if (this.pending || this.exiting) return true;
		const home = this.shownHome;
		const title = item.title;
		const id = this.shownId;
		if (title === "say it" || title === "say it again") {
			this.sayIt(container, index, title);
			return true;
		}
		if (this.sayHold()) return true; // `sending…` is not a choice
		const isOption = id && home && home.kind === "dialog" && index < home.options.length;
		if (isOption) {
			this.wait(container, index, title, controller.link.send("answer", { REQ_ID:id, OPTION:title }));
		}
		else if (title === "dismiss" && id) {
			this.wait(container, index, title, controller.link.send("dismiss", { REQ_ID:id }));
		}
		else if (title === "menu") {
			console.log("pi-web: menu (Task 9)");
		}
		return true;
	}
	wait(container, index, title, cmdId) {
		this.rowLabel(index, "…");
		const p = this.pending = { cmdId, index, title, timer:undefined };
		p.timer = Timer.set(() => {
			p.timer = undefined;
			if (this.pending === p) this.flash(container, p, "failed");
		}, WAIT_MS);
	}
	onResult(container) {
		if (this.sayCmd !== undefined && this.m.sayIt.status !== "sending") {
			this.sayCmd = undefined;
			this.onSayResult(container);
		}
		const p = this.pending;
		if (!p || p.done) return;
		const r = this.m.takeResult(p.cmdId);
		if (!r) return;
		if (r.ok) this.flash(container, p, "sent");
		else if (r.reason === "gone") this.flash(container, p, "already answered");
		else this.flash(container, p, "failed");
	}
	flash(container, p, label) {
		if (p.timer !== undefined) Timer.clear(p.timer);
		p.done = true;
		this.rowLabel(p.index, label);
		p.timer = Timer.set(() => {
			p.timer = undefined;
			if (this.pending !== p) return;
			this.pending = null;
			if (this.stale) this.rebuild(container);
			else this.rowLabel(p.index, p.title);
		}, FLASH_MS);
	}

	// Say it -------------------------------------------------------------

	sayIt(container, index, title) {
		this.clearSayTimer();
		this.sayCmd = undefined; // a transcript still out is superseded; its result is ignored
		const m = this.m;
		try {
			// A fresh session each round; the last one was closed when it ended.
			this.closeDictation();
			const view = this;
			this.dictation = new Dictation({
				onReadable() {
					view.onDictated(container, this.read());
				},
				onError(status) {
					view.onDictationError(container, status);
				},
			});
			this.dictation.configure({ confirm:true, errorDialogs:true });
			this.dictation.start();
		}
		catch (e) {
			console.log("pi-web: dictation unavailable: " + e);
			this.closeDictation();
			if (SAY_HOLD[m.sayIt.status]) {
				// `say it again` while a transcript was out: back to the usual rows.
				m.setSayIt({ status:"idle", text:"", options:[] });
				this.rebuild(container);
				title = "say it";
				index = homeRows(this.shownHome, m.sayIt).indexOf(title);
			}
			const p = this.pending = { cmdId:0, index, title, timer:undefined };
			this.flash(container, p, "failed");
			return;
		}
		m.setSayIt({ status:"listening" });
	}
	onDictated(container, text) {
		this.releaseDictation();
		const m = this.m;
		text = text ? String(text).trim() : "";
		if (m.sayIt.status !== "listening") return;
		if (!text) {
			this.sayIdle(container);
			return;
		}
		const id = this.shownId;
		const home = this.shownHome;
		const cmdId = id
			? controller.link.send("answer", { REQ_ID:id, TEXT:text })
			: controller.link.send("prompt", { SESSION_ID:(home && home.sessionId) || undefined, TEXT:text });
		this.sayCmd = cmdId;
		m.setSayIt({ status:"sending", text, cmdId, reqId:id, options:[] });
		this.rebuild(container, true);
		this.sayTimer = Timer.set(() => {
			this.sayTimer = undefined;
			if (this.sayCmd !== cmdId || m.sayIt.status !== "sending") return;
			this.sayCmd = undefined;
			m.setSayIt({ status:"failed" });
			this.onSayResult(container);
		}, WAIT_MS);
	}
	onDictationError(container, status) {
		// errorDialogs: true, so the firmware has shown (or shows) its own dialog.
		console.log("pi-web: dictation error " + status);
		this.releaseDictation();
		if (this.m.sayIt.status === "listening") this.sayIdle(container);
	}
	onSayResult(container) {
		this.clearSayTimer();
		const s = this.m.sayIt.status;
		if (s === "no_match") {
			// The request is still open: show what did not match and bring its options back.
			this.rebuild(container);
			return;
		}
		this.rowLabel(0, SAY_LABEL[s] || "failed", controller.theme.styles.row);
		this.sayTimer = Timer.set(() => {
			this.sayTimer = undefined;
			this.sayIdle(container);
		}, FLASH_MS);
	}
	sayIdle(container) {
		this.m.setSayIt({ status:"idle", text:"", options:[] });
		this.rebuild(container);
	}
	clearSayTimer() {
		if (this.sayTimer !== undefined) Timer.clear(this.sayTimer);
		this.sayTimer = undefined;
	}
	// From inside a Dictation callback: close the session once the callback has returned
	// (the firmware may still touch it while its callback runs).
	releaseDictation() {
		const d = this.dictation;
		this.dictation = null;
		if (d) Timer.set(() => {
			try {
				d.close();
			}
			catch (e) {
			}
		}, 0);
	}
	closeDictation() {
		if (!this.dictation) return;
		try {
			this.dictation.close();
		}
		catch (e) {
		}
		this.dictation = null;
	}

	// Buttons ------------------------------------------------------------

	clearHold() {
		if (this.hold !== undefined) Timer.clear(this.hold);
		this.hold = undefined;
	}
	onPressSelect(container) {
		this.clearHold();
		this.hold = Timer.set(() => {
			this.hold = undefined;
			console.log("pi-web: hold select -> MenuView (Task 9)");
			// controller.goTo("MenuView");
		}, HOLD_MS);
		return true;
	}
	onReleaseSelect(container) {
		if (this.hold !== undefined) {
			this.clearHold();
			if (this.menu) this.menu.behavior.pick(this.menu);
		}
		return true;
	}
	onPressBack(container) {
		if (this.exiting) return true;
		const id = this.shownId;
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
			// If the FFI exit fails, let the next Back through (it then returns false to the firmware).
			if (!controller.exit()) this.exiting = false;
		};
		const timer = Timer.set(() => {
			if (done) return;
			done = true;
			leave();
		}, EXIT_MS);
		controller.link.onFlushed(() => {
			if (done) return;
			done = true;
			Timer.clear(timer);
			leave();
		});
		return true;
	}
}

const HomeContainer = Container.template($ => ({
	left:0, right:0, top:0, bottom:0, Behavior:$.constructor.Behavior,
}));

export default class extends View {
	static get Behavior() { return HomeBehavior }
	constructor(data) {
		super(data);
	}
	get Template() { return HomeContainer }
};
