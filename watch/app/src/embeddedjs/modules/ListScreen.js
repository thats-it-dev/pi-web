// The pieces every screen shares (spec §7.1): the status line (its own clock)
// and the rule, and a list screen built from them: status, an optional query
// block (title in 14 over 18 px lines) and rule, then a virtualised Menu.
// A screen supplies status(), count(), item(i), and optionally lines() (the
// query block), rows (menu height in rows when there is a query block),
// rowHeight, values, load() (on display) and onSelect.
import { METRICS, ROUND } from "assets";
import { clock } from "format";
import Menu from "Menu";
import View from "piu/View";

const PAD = METRICS.pad;
const SMALL = 16; // 14 px type on a 16 px line
const LINE = 22; // 18 px type, 22 px leading

const now = () => clock(new Date(), !watch.hour12);

class StatusBehavior extends Behavior {
	onClockChanged(status) {
		status.last.string = now();
	}
}

// $ is the left text (first), the time is last. Round: the time centred on top, the text under it.
export const Status = Container.template($ => ({
	left:0, right:0, top:0, height:METRICS.status, Behavior:StatusBehavior,
	contents: [
		Label($, { left:PAD, right:ROUND ? PAD : 60, top:ROUND ? 19 : 1, style:controller.theme.styles.status, string:$ }),
		Label($, ROUND ? { left:0, right:0, top:3, style:controller.theme.styles.status, string:now() } : { right:PAD, width:56, top:1, style:controller.theme.styles.smallRight, string:now() }),
	],
}));

export const Rule = Content.template($ => ({
	left:0, right:0, top:$, height:METRICS.rule, skin:controller.theme.skins.ink,
}));

const label = (top, height, style, string) => new Label(null, { left:PAD, right:PAD, top, height, style, string });

export class ListBehavior extends View.Behavior {
	get m() {
		return controller.model;
	}
	sessionId() {
		const m = this.m;
		return (m.home && m.home.sessionId) || (m.stats && m.stats.sessionId) || undefined;
	}
	onDisplaying(container) {
		if (this.load) this.load();
		const styles = controller.theme.styles;
		const top = METRICS.status;
		let height = container.height - top - METRICS.bottom;
		container.add(new Status(this.status()));
		if (this.lines) {
			height = this.rows * METRICS.row;
			const ruleTop = container.height - METRICS.bottom - height - 2 - METRICS.rule;
			container.add(new Container(null, { left:0, right:0, top:top + 2, height:ruleTop - top - 2, clip:true, contents:[
				label(0, SMALL, styles.hint, (this.m.home && this.m.home.sessionTitle || "").toUpperCase()),
				...this.lines().map((line, k) => label(SMALL + k * LINE, LINE, styles.query, line)),
			] }));
			container.add(new Rule(ruleTop));
		}
		this.list = new Menu({ count:this.count(), item:i => this.item(i), rowHeight:this.rowHeight, values:this.values });
		this.menu = new this.list.Template(this.list, { left:0, right:0, bottom:METRICS.bottom, height });
		container.add(this.menu);
	}
	// Re-read status, query and rows from the model.
	update(container) {
		container.first.first.string = this.status();
		if (this.lines) {
			const query = container.content(1);
			query.first.string = (this.m.home && this.m.home.sessionTitle || "").toUpperCase();
			this.lines().forEach((line, k) => { query.content(k + 1).string = line; });
		}
		this.list.count = this.count();
		this.menu.behavior.refresh(this.menu);
	}
	onDisplayed(container) {
		if (this.menu && controller.view === this.view) this.menu.focus();
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
