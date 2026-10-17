// The pieces every screen shares (spec §7.1): the status line and the rule,
// and a list screen built from them: status with the time, an optional query
// block (title in 14 over 18 px lines) and rule, then a virtualised Menu.
// A screen supplies status(), count(), item(i), and optionally lines() (the
// query block), rows (menu height in rows when there is a query block),
// rowHeight, values, load() (on display) and onSelect.
import { METRICS } from "assets";
import { clock } from "format";
import Menu from "Menu";
import View from "piu/View";

const PAD = 4;
const SMALL = 16; // 14 px type on a 16 px line
const LINE = 22; // 18 px type, 22 px leading

export const Status = Container.template($ => ({
	left:0, right:0, top:0, height:METRICS.status,
	contents: [
		Label($, { left:PAD, right:60, top:1, style:$.styles.small, string:$.left }),
		Label($, { right:PAD, width:56, top:1, style:$.styles.smallRight, string:$.right }),
	],
}));

export const Rule = Content.template($ => ({
	left:0, right:0, top:$.top, height:METRICS.rule, skin:$.skins.rule,
}));

const Query = Container.template($ => ({
	left:0, right:0, top:$.top, height:$.height, clip:true,
	contents: [
		Label($, { left:PAD, right:PAD, top:0, height:SMALL, style:$.styles.meta, string:$.title }),
		...$.lines.map((line, k) => Label($, { left:PAD, right:PAD, top:SMALL + k * LINE, height:LINE, style:$.styles.body, string:line })),
	],
}));

export function sessionTitle(m) {
	return ((m.home && m.home.sessionTitle) || "").toUpperCase();
}

export class ListBehavior extends View.Behavior {
	get m() {
		return controller.model;
	}
	onDisplaying(container) {
		if (this.load) this.load();
		const theme = controller.theme;
		const top = METRICS.status;
		let height = container.height - top;
		container.add(new Status({ styles:theme.styles, left:this.status(), right:clock(new Date(), controller.h24) }));
		if (this.lines) {
			height = this.rows * METRICS.row;
			const ruleTop = container.height - height - 2 - METRICS.rule;
			container.add(new Query({ styles:theme.styles, top:top + 2, height:ruleTop - top - 2, title:sessionTitle(this.m), lines:this.lines() }));
			container.add(new Rule({ skins:theme.skins, top:ruleTop }));
		}
		this.list = new Menu({ count:this.count(), item:i => this.item(i), rowHeight:this.rowHeight, values:this.values, styles:theme.styles, skins:theme.skins });
		this.menu = new this.list.Template(this.list, { left:0, right:0, bottom:0, height });
		container.add(this.menu);
	}
	// Re-read status, query and rows from the model.
	update(container) {
		container.first.first.string = this.status();
		if (this.lines) {
			const query = container.content(1);
			query.first.string = sessionTitle(this.m);
			this.lines().forEach((line, k) => { query.content(k + 1).string = line; });
		}
		this.list.count = this.count();
		this.menu.behavior.refresh(this.menu);
	}
	onDisplayed(container) {
		if (controller.view === this.view) this.menu.focus();
	}
	onClockChanged(container) {
		container.first.last.string = clock(new Date(), controller.h24);
	}
	// The press that opened this screen (hold Select on Home) ends here: only a
	// press seen on this screen picks on release.
	onPressSelect(container) {
		this.armed = true;
		return true;
	}
	onReleaseSelect(container) {
		if (this.armed) this.menu.behavior.pick(this.menu);
		this.armed = false;
		return true;
	}
}

const ListContainer = Container.template($ => ({
	left:0, right:0, top:0, bottom:0, Behavior:$.constructor.Behavior,
}));

export function listScreen(Behavior) {
	return class extends View {
		static get Behavior() { return Behavior }
		get Template() { return ListContainer }
	};
}
