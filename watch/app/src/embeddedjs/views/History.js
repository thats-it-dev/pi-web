// History (spec §7.8): status `HISTORY · i/n` (the turn at the top of the
// view, of n), then the turns as a chat: yours right-aligned, inset 32 from the
// left; the agent's left-aligned, inset 24 from the right; tool calls one dim
// 14 px line. No fills, scrollbar, fades or cursors. Opens at the bottom; Up and
// Down scroll half a view; the top loads the 12 turns before.
//
// Not a Scroller, and no Text (each holds 1 KB of chunk heap): turns wrap into
// lines (wrapLines) and only the turns on screen exist, a Label a line in a
// Column moved by the scroll offset and re-bound as the view scrolls.
// Turn heights are cached per row until the rows change.
import { METRICS, ROUND } from "assets";
import { wrapLines } from "format";
import { ListBehavior, Status } from "ListScreen";
import { scrollTurns } from "listWindow";
import View from "piu/View";

const PAD = METRICS.pad;
const R = ROUND ? 14 : 0; // Round 2: turns sit further in from the rim, and end higher
const GAP = 6; // paper above each turn
const LINE = 22; // 18 px type, 22 px leading
const TOOL = 16; // a tool call: one 14 px line

const inset = role => role === "you" ? { left:32 + R, right:PAD + R } : { left:PAD + R, right:24 + R };

class HistoryBehavior extends ListBehavior {
	onDisplaying(container) {
		this.styles = controller.theme.styles;
		this.menu = container; // focused by ListBehavior; Select does nothing
		container.add(this.status = new Status("HISTORY"));
		container.add(this.port = new Container(null, { left:0, right:0, top:METRICS.status, bottom:ROUND ? 34 : 0, clip:true, contents:[
			this.column = new Column(null, { left:0, right:0, top:0 }),
		] }));
		this.top = this.dy = 0;
		this.hs = [];
		this.m.resetList("history");
		this.page(-1);
	}
	pick() {
	}
	page(offset) {
		this.loading = true;
		controller.link.send("page", { LIST:"history", SESSION_ID:this.sessionId(), OFFSET:offset });
	}
	lines(r) {
		if (r.role === "tool") return [r.text];
		const at = inset(r.role);
		return wrapLines(r.text, this.port.width - at.left - at.right, s => this.styles.body.measure(s).width);
	}
	// A turn's height, with the gap above it.
	h(i) {
		let v = this.hs[i];
		if (v === undefined) {
			const r = this.m.rowAt("history", i);
			v = this.hs[i] = GAP + (r.role === "tool" ? TOOL : LINE * this.lines(r).length);
		}
		return v;
	}
	render(d) {
		const rows = this.m.lists.history.rows;
		const n = rows.length;
		const view = this.port.height;
		const h = i => this.h(i);
		const s = scrollTurns(this.top, this.dy, d, n, view, h);
		const top = this.top = s.top;
		const column = this.column;
		const styles = this.styles;
		let c = column.first;
		// Bind the turns that reach into the view, a Label a line.
		for (let i = top, y = -(this.dy = s.dy); i < n && y < view; y += h(i++)) {
			const r = this.m.rowAt("history", i);
			const tool = r.role === "tool";
			const lines = this.lines(r);
			for (let j = 0; j < lines.length; j++) {
				if (!c) column.add(c = new Label(null, {}));
				const at = inset(r.role);
				at.top = j ? 0 : GAP;
				at.height = tool ? TOOL : LINE;
				c.coordinates = at;
				c.style = tool ? styles.meta : r.role === "you" ? styles.bodyRight : styles.body;
				c.string = lines[j];
				c = c.next;
			}
		}
		while (c) {
			const next = c.next;
			column.remove(c);
			c = next;
		}
		column.coordinates = { left:0, right:0, top:-s.dy };
		this.topI = parseInt(rows[top]);
		this.status.first.string = n ? "HISTORY · " + (this.topI + 1) + "/" + this.m.lists.history.total : "HISTORY";
	}
	onModel(container, kind) {
		if (kind !== "list" || !this.port) return;
		const l = this.m.lists.history;
		this.hs = [];
		// The first page opens at the bottom; an older one keeps the top turn in view.
		const k = this.opened ? l.rows.findIndex(r => parseInt(r) === this.topI) : -1;
		if (k < 0) this.dy = 0;
		this.top = k < 0 ? Math.max(0, l.rows.length - 1) : k;
		if (l.complete) this.opened = true;
		this.loading = !l.complete;
		this.render(0);
	}
	step(direction) {
		this.render(direction * (this.port.height >> 1));
		const earliest = this.m.lists.history.earliest;
		if (!this.top && !this.dy && earliest > 0 && !this.loading) this.page(earliest);
		return true;
	}
	onPressUp() {
		return this.step(-1);
	}
	// Not while a page loads: its rows would move the view to the trimmed bottom.
	onPressDown() {
		return this.loading || this.step(1);
	}
}

const HistoryContainer = Container.template($ => ({
	left:0, right:0, top:0, bottom:0, Behavior:HistoryBehavior,
}));

export default class extends View {
	static get Behavior() { return HistoryBehavior }
	get Template() { return HistoryContainer }
}
