import { createFaceModel, KEYS } from "face";
import { createLink } from "link";
import { makeTheme } from "assets";
import { Idle } from "idle";

const DARK_KEY = "pi-web.dark";

function storedDark() {
	try {
		return localStorage.getItem(DARK_KEY) !== "0";
	} catch (e) {
		return true;
	}
}

// The face: the model holds what the phone sent; the screen updates in one
// deferred pass per batch of dicts (pebble/message holds one unread dict, so
// the read callback applies the dict and returns at once).
class FaceBehavior extends Behavior {
	onCreate(app, $) {
		this.model = $.model;
		this.dark = $.model.cfg.dark;
		this.date = null;
	}
	onDisplaying(app) {
		this.link = createLink({ keys: KEYS, onMessage: (map) => this.onMessage(app, map) });
		this.link.send("hello");
		// Fires once at registration, then every minute.
		watch.addEventListener("minutechange", (e) => {
			this.date = e.date;
			app.distribute("onClockChanged", e.date);
			app.distribute("onCorners", this.data());
		});
	}
	data() {
		const m = this.model;
		return { corners: m.cfg.corners, date: this.date, pi: m.pi, temp: m.temp };
	}
	onMessage(app, map) {
		const kind = this.model.apply(map);
		if (!kind) return;
		if (!this.kinds) {
			this.kinds = [];
			app.defer("onModelChanged");
		}
		if (!this.kinds.includes(kind)) this.kinds.push(kind);
	}
	onModelChanged(app) {
		const kinds = this.kinds;
		this.kinds = null;
		const dark = this.model.cfg.dark;
		if (kinds.includes("cfg") && dark !== this.dark) {
			this.dark = dark;
			try {
				localStorage.setItem(DARK_KEY, dark ? "1" : "0");
			} catch (e) {
			}
			const theme = makeTheme(dark);
			app.skin = theme.skins.paper;
			app.distribute("onTheme", theme);
		}
		app.distribute("onCorners", this.data());
	}
}

const model = createFaceModel();
model.cfg.dark = storedDark();

const FaceApplication = Application.template($ => ({
	skin: $.theme.skins.paper, Behavior: FaceBehavior,
	contents: [ Idle($) ],
}));

export default new FaceApplication(
	{ model, theme: makeTheme(model.cfg.dark) },
	{ commandListLength: 2048, displayListLength: 2048, touchCount: 0, pixels: screen.width * 4 },
);
