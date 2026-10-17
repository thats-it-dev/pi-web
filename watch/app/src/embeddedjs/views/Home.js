// Home: the request screen (spec §7.2, §7.3) and home with nothing pending (§7.5).
// Pieces top to bottom (§7.1): status line, toolbar, query block (+ hint when
// nothing is pending), rule, menu rows.
import { METRICS } from "assets";
import { homeRows } from "model";
import { toolbar, statusLeft, clock, queryText, hint } from "format";
import Menu from "Menu";
import Timer from "timer";
import View from "piu/View";

const PAD = 4;
const HINT = 16; // 14 px type on a 16 px line
const HOLD_MS = 500;
const FLASH_MS = 1000;
const WAIT_MS = 10000; // no result by then: treat as failed
const EXIT_MS = 400;

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
			left:4, width:METRICS.bar, height:8, skin:$.skins.dim,
			contents: [
				Content($, { left:0, top:0, bottom:0, width:$.fill, skin:$.skins.ink }),
			],
		}),
		Label($, { left:4, style:$.styles.small, string:$.ctx }),
		Label($, { left:6, style:$.styles.small, string:$.speed }),
		Label($, { left:6, style:$.styles.small, string:$.model }),
	],
}));

const Query = Container.template($ => ({
	left:0, right:0, top:$.top, height:$.height, clip:true,
	contents: [
		Text($, { left:PAD, right:PAD, top:0, style:$.styles.body, string:$.string }),
	],
}));

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
	}
	onDisplaying(container) {
		this.build(container);
	}
	onDisplayed(container) {
		this.focusMenu(container);
	}
	onUndisplaying(container) {
		this.clearHold();
		super.onUndisplaying(container);
	}

	// Rendering ----------------------------------------------------------

	get m() {
		return controller.model;
	}
	pendingRequest() {
		const home = this.m.home;
		return !!(home && home.requestId);
	}
	queryString() {
		const m = this.m;
		const home = m.home;
		if (this.pendingRequest()) return queryText(home);
		// A home dict can arrive mid-stream with an older lastText: the live tail wins.
		const t = m.text;
		if (t && home && t.sessionId === home.sessionId && t.streaming) return t.text;
		return home ? home.lastText : "";
	}
	build(container) {
		const theme = controller.theme;
		const m = this.m;
		const rows = homeRows(m.home);
		const items = rows.map(title => ({ title }));
		const menuHeight = rows.length * METRICS.row;
		const ruleTop = container.height - menuHeight - METRICS.rule;
		const top = METRICS.status + METRICS.toolbar + 2;
		const withHint = !this.pendingRequest();
		const queryHeight = ruleTop - top - (withHint ? HINT : 0);

		container.empty();
		container.add(new Status({ styles:theme.styles, left:statusLeft(m.home, m.net), right:clock(new Date(), controller.h24) }));
		container.add(new Toolbar(toolbarData(theme, m.stats)));
		container.add(new Query({ styles:theme.styles, top, height:queryHeight, string:this.queryString() }));
		if (withHint)
			container.add(new Hint({ styles:theme.styles, top:top + queryHeight, string:hint(m.home, m.stats) }));
		container.add(new Rule({ skins:theme.skins, top:ruleTop }));

		const selection = this.menuView && this.rowsKey === rows.join("\n") ? this.menuView.selection : 0;
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
	rebuild(container) {
		this.build(container);
		this.focusMenu(container);
	}
	rowLabel(index, string) {
		const row = this.menu && this.menu.last.content(index);
		if (row) row.first.string = string;
	}

	// Model --------------------------------------------------------------

	onModel(container, kind) {
		if (!container.length) return; // not built yet; onDisplaying builds from the model
		if (kind === "result") {
			this.onResult(container);
			return;
		}
		if (kind === "home") {
			// Keep the row feedback on screen; the new request shows when it ends.
			if (this.pending) this.stale = true;
			else this.rebuild(container);
			return;
		}
		if (kind === "stats") {
			container.replace(container.content(1), new Toolbar(toolbarData(controller.theme, this.m.stats)));
			if (!this.pendingRequest()) {
				const h = this.hintLabel(container);
				if (h) h.string = hint(this.m.home, this.m.stats);
			}
			return;
		}
		if (kind === "net") {
			container.first.first.string = statusLeft(this.m.home, this.m.net);
			return;
		}
		if (kind === "text") {
			const t = this.m.text;
			const home = this.m.home;
			if (!this.pendingRequest() && t && home && t.sessionId === home.sessionId)
				container.content(2).first.string = t.text;
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
		const home = this.m.home;
		const title = item.title;
		const isOption = home && home.kind === "dialog" && home.requestId && index < home.options.length;
		if (isOption) {
			this.wait(container, index, title, controller.link.send("answer", { REQ_ID:home.requestId, OPTION:title }));
		}
		else if (title === "dismiss" && home && home.requestId) {
			this.wait(container, index, title, controller.link.send("dismiss", { REQ_ID:home.requestId }));
		}
		else if (title === "say it") {
			console.log("pi-web: say it (Task 8)");
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
		const home = this.m.home;
		if (!(home && home.requestId))
			return controller.exit();
		this.exiting = true;
		controller.link.send("dismiss", { REQ_ID:home.requestId });
		// Exit once the dismiss has gone out (next onWritable) or after EXIT_MS, whichever is first.
		let done = false;
		const timer = Timer.set(() => {
			if (done) return;
			done = true;
			controller.exit();
		}, EXIT_MS);
		controller.link.onFlushed(() => {
			if (done) return;
			done = true;
			Timer.clear(timer);
			controller.exit();
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
