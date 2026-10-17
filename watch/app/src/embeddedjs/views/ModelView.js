// Model (spec §7.9): status `MODEL`; the session title (14) over `model for
// this session`; pi's models, `CURRENT` on the right of the current one (a
// word: the font subset is Basic Latin). Select sets it: `…` while it goes,
// then `set` for a second and back to the menu (or `failed`, and the row returns).
import Timer from "timer";
import { ListBehavior, listScreen } from "ListScreen";

const LINES = ["model for this session"];

class ModelBehavior extends ListBehavior {
	status() {
		return "MODEL";
	}
	lines() {
		return LINES;
	}
	get rows() {
		return 5;
	}
	get values() {
		return true;
	}
	sessionId() {
		const m = this.m;
		return (m.home && m.home.sessionId) || (m.stats && m.stats.sessionId) || undefined;
	}
	count() {
		return this.m.lists.models.rows.length;
	}
	item(i) {
		const r = this.m.rowAt("models", i);
		const p = this.pending;
		return { title:r.name || r.id, value:p && p.index === i ? p.label : r.current ? "CURRENT" : "" };
	}
	load() {
		this.m.resetList("models");
		controller.link.send("page", { LIST:"models", SESSION_ID:this.sessionId(), OFFSET:0 });
	}
	onModel(container, kind) {
		if (!this.menu) return;
		const p = this.pending;
		if (kind === "list") {
			// Open on the current model when the rows first arrive.
			if (!this.list.count)
				for (let i = this.count() - 1; i >= 0; i--)
					if (this.m.rowAt("models", i).current) this.list.selection = i;
			this.update(container);
		}
		else if (kind === "result" && p && !p.done) {
			const r = this.m.takeResult(p.cmdId);
			if (r) this.settle(container, p, r.ok);
		}
	}
	onSelect(container, index) {
		if (this.pending) return true;
		const r = this.m.rowAt("models", index);
		const p = this.pending = { index, label:"…" };
		p.cmdId = controller.link.send("model", { SESSION_ID:this.sessionId(), PROVIDER:r.provider, MODEL_ID:r.id });
		this.update(container);
		p.timer = Timer.set(() => this.settle(container, p, false), 10000);
		return true;
	}
	// `set` or `failed` for a second; then back to the menu, or the row as it was.
	settle(container, p, ok) {
		Timer.clear(p.timer);
		p.done = true;
		p.label = ok ? "set" : "failed";
		this.update(container);
		p.timer = Timer.set(() => {
			this.pending = null;
			if (ok) controller.goBack();
			else this.update(container);
		}, 1000);
	}
	onUndisplaying(container) {
		if (this.pending) Timer.clear(this.pending.timer);
		this.pending = null;
		super.onUndisplaying(container);
	}
}

export default listScreen(ModelBehavior);
