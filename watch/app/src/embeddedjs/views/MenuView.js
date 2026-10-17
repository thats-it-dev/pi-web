// Menu (spec §7.6): status `MENU`; the session title (14) over
// `<model> · <state>` and `<used>k of <window>k`; rows with what is behind
// them on the right: sessions count, history turn count (only once a history
// page has loaded, ruling), the model's short name.
import { menuMeta } from "format";
import { ListBehavior, listScreen } from "ListScreen";

const ROWS = ["sessions", "history", "model"];
const SCREENS = ["Sessions", "History", "ModelView"];

class MenuBehavior extends ListBehavior {
	status() {
		return "MENU";
	}
	lines() {
		return menuMeta(this.m.stats);
	}
	get rows() {
		return 3;
	}
	get values() {
		return true;
	}
	count() {
		return 3;
	}
	load() {
		controller.link.send("page", { LIST:"sessions", OFFSET:0 });
	}
	item(i) {
		const m = this.m;
		const s = m.lists.sessions;
		const value = i === 0 ? (s.rows.length || s.complete ? String(s.total) : "")
			: i === 1 ? (m.lists.history.rows.length ? String(m.lists.history.total) : "")
			: ((m.stats && m.stats.model) || "").toUpperCase();
		return { title:ROWS[i], value };
	}
	onModel(container, kind) {
		if (this.menu && (kind === "list" || kind === "stats" || kind === "home")) this.update(container);
	}
	onSelect(container, index) {
		try {
			controller.goTo(SCREENS[index]);
		}
		catch (e) {
			console.log("pi-web: no " + SCREENS[index] + " screen yet");
		}
		return true;
	}
}

export default listScreen(MenuBehavior);
