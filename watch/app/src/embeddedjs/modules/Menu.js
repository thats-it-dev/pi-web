// Rows with a selection bar, after the Alloy `words` example's Menu, without
// its tweens (the bar and the rows move at once; less code in the mod).
// Up/Down step with repeat and stop at the ends. Select is left to the
// containing view (it times the press for hold-Select); a tap picks a row.
//
// The selected row is inverted, but not with Piu's Inverter: on emery and gabbro
// (8-bit framebuffers) the firmware treats GCompOpAssignInverted as plain
// Assign, so an Inverter draws nothing. Instead an ink bar sits behind the
// selected row and its labels switch to paper-coloured text (label.state = 1).
//
// Virtualised: rows have one fixed height, and only the rows that fit plus one
// exist as Piu containers (listWindow.js); scrolling re-binds them to the next
// items, so a 26-row list costs six rows of Piu memory.
//
// Data: { items: [{ title, meta?, value?, dim? }] } or { count, item(i) } read
// at bind time; rowHeight (METRICS.row, or row2 for title + meta line);
// values: true for a right-aligned 14 px value. Needs its height up front.
// Round 2: rows are inset from the rim, and a list longer than the view keeps
// the selected row centred, also at its ends (§7.10).
import { METRICS, ROUND } from "assets";
import { poolSize, scrollFor, windowFirst, stepIndex } from "listWindow";
import Timer from "timer";
import View from "piu/View";

const INSET = ROUND ? 24 : 6;
const VALUE = ROUND ? 64 : INSET; // a value's right inset: on Round 2 it clears the rim on the bottom row

class MenuBehavior extends View.Behavior {
	onCreate(menu, view) {
		super.onCreate(menu, view);
		this.refresh(menu);
	}
	// After view.count or the items change: size the pool, keep the selection in range, re-bind.
	refresh(menu) {
		const view = this.view;
		const column = menu.last;
		const need = poolSize(view.count, menu.height || menu.coordinates.height, view.rowHeight);
		while (column.length < need)
			column.add(new MenuItemRow(view));
		while (column.length > need)
			column.remove(column.last);
		view.selection = Math.max(0, Math.min(view.selection, view.count - 1));
		this.first = -1;
		this.place(menu);
	}
	place(menu) {
		const view = this.view;
		const h = view.rowHeight;
		const column = menu.last;
		const height = menu.height || menu.coordinates.height;
		const scroll = scrollFor(view.selection, view.count, height, h, ROUND);
		const first = windowFirst(scroll, view.count, column.length, h);
		column.coordinates = { left:0, right:0, top:first * h - scroll };
		column.previous.coordinates = { left:0, right:0, top:view.selection * h - scroll, height:view.count ? h : 0 };
		// Re-bind only when the window moved (a view may have written feedback into a row).
		const rebind = first !== this.first;
		this.first = first;
		for (let k = 0, row = column.first; row; k++, row = row.next) {
			if (rebind)
				this.bind(row, first + k);
			for (let label = row.first; label; label = label.next)
				label.state = first + k === view.selection ? 1 : 0;
		}
	}
	bind(row, i) {
		const view = this.view;
		const styles = controller.theme.styles;
		const item = view.item(i);
		let label = row.first;
		label.string = item.title;
		label.style = item.dim ? styles.rowDim : styles.row;
		const title = label;
		if (view.rowHeight === METRICS.row2) {
			label = label.next;
			label.string = item.meta || "";
		}
		if (view.values) {
			label = label.next;
			const value = item.value || "";
			const w = value ? styles.rowValue.measure(value).width : 0;
			label.coordinates = { right:VALUE, width:w, top:8, height:18 };
			label.string = value;
			title.coordinates = { left:INSET, right:w ? VALUE + INSET + w : INSET, top:5, height:22 };
		}
	}
	onPress(menu, direction) {
		this.onStep(menu, direction);
		this.timer = Timer.set(() => this.onStep(menu, direction), 400, 100);
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
		return true;
	}
	onReleaseDown(menu) {
		return this.onRelease(menu);
	}
	onReleaseUp(menu) {
		return this.onRelease(menu);
	}
	onUndisplaying(menu) {
		this.onRelease(menu);
		super.onUndisplaying(menu);
	}
	onStep(menu, direction) {
		const view = this.view;
		if (!view.count)
			return;
		view.selection = stepIndex(view.selection, direction, view.count);
		this.place(menu);
	}
	// The containing view calls this on Select release; a tap calls it with the row's index.
	pick(menu, index = this.view.selection) {
		const view = this.view;
		if (index < 0 || index >= view.count)
			return;
		if (index !== view.selection) {
			view.selection = index;
			this.place(menu);
		}
		menu.bubble("onSelect", index, view.item(index));
	}
}

class MenuItemBehavior extends Behavior {
	onTouchEnded(row) {
		const menu = row.container.container;
		menu.behavior.pick(menu, menu.behavior.first + row.index);
		return true;
	}
}

const MenuContainer = Container.template($ => ({
	Behavior:MenuBehavior, clip:true,
	contents: [
		Content($, { left:0, right:0, top:0, height:0, skin:controller.theme.skins.ink }),
		Column($, { left:0, right:0, top:0, contents:[] }),
	]
}));

// One pooled row ($ is the menu's view); bind() sets its strings and states.
// The styles row / rowDim / rowMeta / rowValue have [normal, selected] colours.
const MenuItemRow = Container.template($ => ({
	left:0, right:0, height:$.rowHeight, active:true, Behavior:MenuItemBehavior,
	contents: [
		Label($, { left:INSET, right:INSET, top:$.rowHeight === METRICS.row2 ? 2 : 5, height:22, style:controller.theme.styles.row }),
		$.rowHeight === METRICS.row2 ? Label($, { left:INSET, right:INSET, top:24, height:18, style:controller.theme.styles.rowMeta }) : null,
		$.values ? Label($, { right:INSET, width:0, top:8, height:18, style:controller.theme.styles.rowValue }) : null,
	],
}));

export default class MenuView extends View {
	constructor(data) {
		super(data);
		const items = data.items;
		this.count = items ? items.length : (data.count ?? 0);
		this.item = items ? (i => items[i]) : data.item;
		this.rowHeight = data.rowHeight ?? METRICS.row;
		this.values = !!data.values;
		this.selection = data.selection ?? 0;
	}
	get Template() { return MenuContainer }
};
