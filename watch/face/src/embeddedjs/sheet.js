// The request sheet (spec §6.2): 84 px over the bottom of the screen, a 2 px
// rule along its top, the eyebrow, the message in a two-line clip and the
// footer. main moves it (the rise); this only fills it. A message longer than
// two lines scrolls a line at a time (scrollNext): a 240-character message is
// unreadable as a horizontal marquee, and the clip already wraps.
//
// On gabbro the sheet is the bottom 84 px segment of the circle, whose chord is
// about 226 px under the rule, 160 px at the second message line and under 50 px
// at the bottom. So the rows are tighter, the counter rides in the eyebrow (the
// widest part), the footer is FLICK TO OPEN alone, and the message wraps to 148 px.
import { sheetText, scrollNext, SHEET_HEIGHT } from "face";
import Timer from "timer";

const ROUND = screen.round;
const LINE = ROUND ? 20 : 22;
const INSET = ROUND ? 32 : 8;
// The message's inset; on gabbro a full line keeps about 4 px off the rim at the second line's baseline.
const BODY_INSET = ROUND ? 56 : 8;
// The eyebrow's height, then where the clip and the footer start.
const EYEBROW = ROUND ? 16 : 18;
const BODY_TOP = 2 + EYEBROW;
const FOOTER_TOP = BODY_TOP + 2 * LINE;

class SheetBehavior extends Behavior {
	onCreate(c, $) {
		this.styles = $.theme.styles;
		this.id = null;
		this.text = null;
		this.timer = null;
		this.t = null;
		this.opening = false;
	}
	// sheet: { id, kind, tool, text, index, count }. Only a new request or new
	// text rebuilds the lines and restarts the scroll; a counter change does not.
	onSheet(c, sheet) {
		const t = (this.t = sheetText(sheet));
		this.footer(c);
		if (sheet.id === this.id && sheet.text === this.text) return;
		this.stop(c);
		this.id = sheet.id;
		this.text = sheet.text;
		const col = this.column(c);
		col.empty();
		const style = ROUND ? this.styles.bodyCenter : this.styles.body;
		const lines = t.lines(c.width - 2 * BODY_INSET, (s) => style.measure(s).width);
		for (const string of lines) col.add(new Label(null, { left: BODY_INSET, right: BODY_INSET, height: LINE, style, string }));
		this.max = lines.length - 2;
		this.k = -1;
		this.step(c);
	}
	// After a flick (main): opening… until the app launches or main gives up.
	onOpening(c, on) {
		this.opening = on;
		if (this.t) this.footer(c);
	}
	// The eyebrow and the footer; on gabbro the counter is in the eyebrow.
	footer(c) {
		const footer = c.content(3);
		const f = this.t.footer(this.opening);
		if (ROUND) {
			c.content(1).string = this.t.eyebrow + " · " + f[1];
			footer.first.string = f[0];
		} else {
			c.content(1).string = this.t.eyebrow;
			footer.first.string = f[0];
			footer.last.string = f[1];
		}
	}
	column(c) {
		return c.content(2).first;
	}
	step(c) {
		const [k, wait] = scrollNext(this.k, this.max);
		this.k = k;
		this.column(c).coordinates = { left: 0, right: 0, top: -k * LINE };
		this.timer = this.max > 0 ? Timer.set(() => this.step(c), wait) : null;
	}
	// Ends the scroll (main calls it when the sheet starts to fall); the next
	// onSheet then rebuilds, even for the same request.
	stop(c) {
		if (this.timer !== null) Timer.clear(this.timer);
		this.timer = null;
		this.id = this.text = null;
	}
	onUndisplaying(c) {
		this.stop(c);
	}
	onTheme(c, theme) {
		const s = (this.styles = theme.styles);
		c.skin = theme.skins.paper;
		c.content(0).skin = theme.skins.ink;
		c.content(1).style = ROUND ? s.smallCenter : s.small;
		for (let l = this.column(c).first; l; l = l.next) l.style = ROUND ? s.bodyCenter : s.body;
		const footer = c.content(3);
		footer.first.style = ROUND ? s.smallCenter : s.small;
		if (!ROUND) footer.last.style = s.smallRight;
	}
}

// Starts below the screen; main's rise moves its top.
export const Sheet = Container.template($ => ({
	left: 0, right: 0, top: screen.height, height: SHEET_HEIGHT, skin: $.theme.skins.paper, Behavior: SheetBehavior,
	contents: [
		Content($, { left: 0, right: 0, top: 0, height: 2, skin: $.theme.skins.ink }),
		Label($, { left: INSET, right: INSET, top: 2, height: EYEBROW, style: ROUND ? $.theme.styles.smallCenter : $.theme.styles.small, string: "" }),
		Container($, { left: 0, right: 0, top: BODY_TOP, height: 2 * LINE, clip: true, contents: [
			Column($, { left: 0, right: 0, top: 0, contents: [] }),
		] }),
		Container($, { left: 0, right: 0, top: FOOTER_TOP, height: EYEBROW, contents: ROUND
			? [ Label($, { left: 0, right: 0, style: $.theme.styles.smallCenter, string: "" }) ]
			: [
				Label($, { left: INSET, style: $.theme.styles.small, string: "" }),
				Label($, { right: INSET, style: $.theme.styles.smallRight, string: "" }),
			] }),
	],
}));
