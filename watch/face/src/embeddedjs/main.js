import { createFaceModel, KEYS } from "face";
import { createLink } from "link";
import { makeTheme } from "assets";
import { Idle } from "idle";
import Health from "pebble/health";
import Battery from "embedded:sensor/Battery";

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
		this.hr = null;
		this.steps = null;
		this.battery = null;
		this.batteryPct = null;
	}
	onDisplaying(app) {
		this.link = createLink({ keys: KEYS, onMessage: (map) => this.onMessage(app, map) });
		this.link.send("hello");
		try {
			this.battery = new Battery({
				onSample: () => {
					this.readBattery();
					app.distribute("onCorners", this.data());
				},
			});
			this.readBattery();
		} catch (e) {
		}
		this.readSteps();
		this.readHeart();
		// Fires once at registration, then every minute.
		watch.addEventListener("minutechange", (e) => {
			this.date = e.date;
			this.readSteps();
			app.distribute("onClockChanged", e.date);
			app.distribute("onCorners", this.data());
		});
		watch.addEventListener("health", (subtype) => {
			if (subtype === "heart rate" || subtype === "significant") this.readHeart();
			if (subtype === "significant" || subtype === "movement" || subtype === "metric") this.readSteps();
			app.distribute("onCorners", this.data());
		});
	}
	// Each read is guarded: an inaccessible metric throws or reads 0, and the corner shows --.
	readSteps() {
		try {
			let steps = Health.metric.get("step count");
			if (!steps) {
				// The emulator's live value stays 0; its day total is there.
				const now = new Date();
				const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
				steps = Health.metric.query({ metric: "step count", start: midnight, end: now, aggregation: "sum" });
			}
			this.steps = steps;
		} catch (e) {
			this.steps = null;
		}
	}
	readHeart() {
		try {
			this.hr = Health.metric.get("heart rate");
		} catch (e) {
			this.hr = null;
		}
	}
	readBattery() {
		try {
			this.batteryPct = this.battery.sample().percent;
		} catch (e) {
			this.batteryPct = null;
		}
	}
	data() {
		const m = this.model;
		return { corners: m.cfg.corners, date: this.date, pi: m.pi, temp: m.temp, hr: this.hr, steps: this.steps, battery: this.batteryPct };
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
