// Sessions (spec §7.7): status `SESSIONS n`, no query block, two-line rows
// (title; `<STATE> · <MODEL> · <ctx%>`, or `CLOSED · <age>` dimmed). Chunks
// re-bind the same few rows. Select makes the session current and goes home.
import { METRICS } from "assets";
import { sessionMeta } from "format";
import { ListBehavior, listScreen } from "ListScreen";

class SessionsBehavior extends ListBehavior {
	get rowHeight() {
		return METRICS.row2;
	}
	status() {
		const l = this.m.lists.sessions;
		return l.rows.length || l.complete ? "SESSIONS " + l.total : "SESSIONS";
	}
	count() {
		return this.m.lists.sessions.rows.length;
	}
	item(i) {
		const r = this.m.rowAt("sessions", i);
		return { title:r.title || r.id, meta:sessionMeta(r), dim:!r.live };
	}
	load() {
		this.m.resetList("sessions");
		controller.link.send("page", { LIST:"sessions", OFFSET:0 });
	}
	onModel(container, kind) {
		if (kind === "list" && this.menu) this.update(container);
	}
	onSelect(container, index) {
		const r = this.m.rowAt("sessions", index);
		if (this.leaving) return true;
		this.leaving = true;
		this.m.resetList("history"); // history belongs to the session it was read from
		controller.link.send("show", { SESSION_ID:r.id });
		controller.goHome();
		return true;
	}
}

export default listScreen(SessionsBehavior);
