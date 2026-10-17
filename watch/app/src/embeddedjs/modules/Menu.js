// Adapted from the Alloy `words` example (piu/apps/words/modules/Menu.js):
// rows from $.data.items ({ title, meta?, dim? }), Up/Down with repeat, the same
// bounce tween. Select is left to the containing view (it times the press for
// hold-Select); a tap on a row selects and picks it.
//
// The selected row is inverted, but not with Piu's Inverter: on emery and gabbro
// (8-bit framebuffers) the firmware treats GCompOpAssignInverted as plain
// Assign (fw/applib/graphics/8_bit/bitblt_private.c), so an Inverter draws
// nothing. Instead an ink bar slides behind the rows and the selected row's
// labels switch to paper-coloured text (Style colour arrays, label.state = 1).
//
// Positions are kept relative (coordinates), so the menu can be placed before
// Piu has laid it out.
import { METRICS } from "assets";
import Timer from "timer";
import View from "piu/View";

function rowTop(column, index) {
	let y = 0;
	for (let i = 0; i < index; i++) y += column.content(i).coordinates.height;
	return y;
}

class MenuBehavior extends View.Behavior {
	computeTweens(menu, selection, limit, direction) {
		const bounce = 8;
		const column = menu.last;
		const item = column.content(selection);
		const itemHeight = item.coordinates.height;
		const menuHeight = menu.coordinates.height;
		const offset = rowTop(column, selection);
		const delta = Math.max(0, Math.min(rowTop(column, column.length) - menuHeight, offset - ((menuHeight - itemHeight) >> 1)));
		{
			let { from, on, to } = this.columnTween;
			from.y = this.columnY;
			to.y = -delta;
			on.y = to.y;
			if (direction) {
				if (direction < 0) {
					if (selection == 0)
						on.y = to.y + bounce;
				}
				else {
					if ((selection > 0) && (selection == limit))
						on.y = to.y - bounce;
				}
			}
		}
		{
			let { from, on, to } = this.barTween;
			from.y = this.barY;
			from.height = this.barHeight;
			to.y = offset - delta;
			to.height = itemHeight;
			on.y = to.y;
			on.height = to.height;
			if (direction) {
				if (direction < 0) {
					if (selection > 0)
						on.y = to.y - bounce;
				}
				else {
					if ((selection > 0) && (selection == limit))
						on.y = to.y - bounce;
				}
				on.height = to.height + bounce;
			}
		}
	}
	onCreate(menu, $) {
		super.onCreate(menu, $);
		this.columnTween = {
			from: { y:0 },
			on: { y:0 },
			to: { y:0 },
		}
		this.barTween = {
			from: { y:0, height:0 },
			on: { y:0, height:0 },
			to: { y:0, height:0 },
		}
		this.columnY = 0;
		this.barY = 0;
		this.barHeight = 0;
		this.selection = $.selection ?? 0;
		this.place(menu);
	}
	set(menu, columnY, barY, barHeight) {
		const column = menu.last;
		const bar = column.previous;
		this.columnY = columnY;
		this.barY = barY;
		this.barHeight = barHeight;
		column.coordinates = { left:0, right:0, top:columnY };
		bar.coordinates = { left:0, right:0, top:barY, height:barHeight };
	}
	highlight(menu, selection) {
		const column = menu.last;
		for (let i = 0; i < column.length; i++) {
			const state = i === selection ? 1 : 0;
			for (let label = column.content(i).first; label; label = label.next)
				label.state = state;
		}
	}
	place(menu) {
		const column = menu.last;
		if (!column.length) {
			this.set(menu, 0, 0, 0);
			return;
		}
		if (this.selection >= column.length)
			this.selection = column.length - 1;
		this.computeTweens(menu, this.selection);
		this.set(menu, this.columnTween.to.y, this.barTween.to.y, this.barTween.to.height);
		this.highlight(menu, this.selection);
	}
	onPress(menu, direction) {
		this.onStep(menu, direction);
		this.timer = Timer.set(() => {
			this.onStep(menu, direction);
		}, 400, 100);
	}
	onPressDown(menu) {
		this.onPress(menu, 1);
		return true;
	}
	onPressUp(menu) {
		this.onPress(menu, -1);
		return true;
	}
	onRelease(menu) {
		if (this.timer !== undefined)
			Timer.clear(this.timer);
		delete this.timer;
	}
	onReleaseDown(menu) {
		this.onRelease(menu);
		return true;
	}
	onReleaseUp(menu) {
		this.onRelease(menu);
		return true;
	}
	onUndisplaying(menu) {
		this.onRelease(menu);
		super.onUndisplaying(menu);
	}
	onStep(menu, direction) {
		const column = menu.last;
		if (!column.length)
			return;
		if (menu.running) {
			menu.stop();
			menu.time = menu.duration;
		}
		let selection = this.selection;
		let limit = column.length - 1;
		selection += direction;
		if (selection < 0)
			selection = 0;
		else if (selection > limit)
			selection = limit;
		this.selection = this.view.selection = selection;
		this.highlight(menu, selection);
		this.computeTweens(menu, selection, limit, direction);
		menu.duration = 250;
		menu.time = 0;
		menu.start();
	}
	// The containing view calls this on Select release; a tap calls it with the row's index.
	pick(menu, index = this.selection) {
		const column = menu.last;
		const item = column.content(index);
		if (!item)
			return;
		if (index !== this.selection) {
			if (menu.running)
				menu.stop();
			this.selection = this.view.selection = index;
			this.place(menu);
		}
		menu.bubble("onSelect", index, item.behavior.$);
	}
	onTimeChanged(menu) {
		let fraction = Math.quadEaseOut(menu.fraction);
		fraction *= 4;
		let a, b;
		if (fraction < 3) {
			fraction /= 3;
			a = "from";
			b = "on";
		}
		else {
			fraction -= 3;
			a = "on";
			b = "to";
		}
		const c = this.columnTween, s = this.barTween;
		this.set(menu,
			c[a].y + Math.round((c[b].y - c[a].y) * fraction),
			s[a].y + Math.round((s[b].y - s[a].y) * fraction),
			s[a].height + Math.round((s[b].height - s[a].height) * fraction));
	}
}

class MenuItemBehavior extends Behavior {
	onCreate(row, $) {
		this.$ = $;
	}
	onTouchEnded(row, id, x, y, ticks) {
		const menu = row.container.container;
		menu.behavior.pick(menu, row.index);
		return true;
	}
}

const MenuContainer = Container.template($ => ({
	Behavior:$.constructor.Behavior, clip:true,
	contents: [
		Content($, { left:0, right:0, top:0, height:0, skin:$.skins.ink }),
		Column($, {
			left:0, right:0, top:0,
			contents: $.data.items.map($$ => new $.constructor.Item({ title:$$.title, meta:$$.meta, dim:$$.dim, styles:$.styles }))
		}),
	]
}));

// $.styles.row / rowDim / rowMeta are Style instances with [normal, selected] colours.
const MenuItemRow = Container.template($ => ({
	left:0, right:0, height:$.meta ? METRICS.row2 : METRICS.row, active:true, Behavior:MenuItemBehavior,
	contents: [
		Label($, { left:6, right:6, top:$.meta ? 2 : 5, height:22, style:$.dim ? $.styles.rowDim : $.styles.row, string:$.title }),
		$.meta ? Label($, { left:6, right:6, top:24, height:18, style:$.styles.rowMeta, string:$.meta }) : null,
	],
}));

export default class MenuView extends View {
	static get Behavior() { return MenuBehavior }
	static get ItemBehavior() { return MenuItemBehavior }
	static get Item() { return MenuItemRow }

	// data: { items: [{ title, meta?, dim? }], styles, skins, selection? }
	constructor(data) {
		super(data);
		this.selection = data?.selection ?? 0;
		this.styles = data?.styles;
		this.skins = data?.skins;
	}
	select(selection) {
		this.selection = selection;
	}
	get Template() { return MenuContainer }
};
