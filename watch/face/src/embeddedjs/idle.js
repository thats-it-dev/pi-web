// The idle screen: the time centred, four corners. Positions come from
// layout() for the container's height, so a shorter group (under the sheet)
// lays out the same way.
import { layout, cornerText } from "face";
import { clock } from "format";

class IdleBehavior extends Behavior {
	onDisplaying(c) {
		this.place(c, c.height);
	}
	place(c, h) {
		const w = c.width;
		const L = layout(w, h, screen.round);
		const k = L.corners;
		const half = (w >> 1) - k.inset;
		const bottom = h - k.top - k.height;
		c.content(0).coordinates = { left: 0, width: w, top: L.time.top, height: L.time.height };
		c.content(1).coordinates = { left: k.inset, width: half, top: k.top, height: k.height };
		c.content(2).coordinates = { left: w - k.inset - half, width: half, top: k.top, height: k.height };
		c.content(3).coordinates = { left: k.inset, width: half, top: bottom, height: k.height };
		c.content(4).coordinates = { left: w - k.inset - half, width: half, top: bottom, height: k.height };
	}
	onClockChanged(c, date) {
		c.content(0).string = clock(date, !watch.hour12);
	}
	// data: { corners: [tl, tr, bl, br], date, pi, temp, hr, steps, battery }.
	onCorners(c, data) {
		for (let i = 0; i < 4; i++) c.content(i + 1).string = cornerText(data.corners[i], data);
	}
	onTheme(c, theme) {
		const s = theme.styles;
		c.skin = theme.skins.paper;
		c.content(0).style = s.time;
		for (let i = 1; i < 5; i++) c.content(i).style = i & 1 ? s.corner : s.cornerRight;
	}
}

export const Idle = Container.template($ => ({
	left: 0, right: 0, top: 0, bottom: 0, skin: $.theme.skins.paper, Behavior: IdleBehavior,
	contents: [
		Label($, { left: 0, top: 0, style: $.theme.styles.time, string: "" }),
		Label($, { left: 0, top: 0, style: $.theme.styles.corner, string: "" }),
		Label($, { left: 0, top: 0, style: $.theme.styles.cornerRight, string: "" }),
		Label($, { left: 0, top: 0, style: $.theme.styles.corner, string: "" }),
		Label($, { left: 0, top: 0, style: $.theme.styles.cornerRight, string: "" }),
	],
}));
