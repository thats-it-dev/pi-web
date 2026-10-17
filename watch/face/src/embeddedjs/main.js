import { createFaceModel, KEYS, SHEET_HEIGHT, RISE_MS, OPENING_MS } from "face";
import { createLink } from "link";
import { makeTheme } from "assets";
import { Idle } from "idle";
import { Sheet } from "sheet";
import Timeline from "piu/Timeline";
import Health from "pebble/health";
import Vibes from "pebble/vibes";
import Battery from "embedded:sensor/Battery";
import Accelerometer from "embedded:sensor/Accelerometer";
import Timer from "timer";

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
//
// The sheet: hidden → rising → up → falling → hidden. The rise is one Timeline
// (the idle group shrinks to the space above the sheet while the sheet slides
// up), driven by the application's clock; the fall plays it backwards. A sheet
// dict while the sheet is up only changes its texts. The sheet's tween is on `y`
// (Piu contents have no `top` accessor; the application is at 0, so y is the top).
class FaceBehavior extends Behavior {
	onCreate(app, $) {
		this.model = $.model;
		this.theme = $.theme;
		this.dark = $.model.cfg.dark;
		this.sheet = null;
		this.timeline = null;
		this.state = "hidden";
		this.date = null;
		this.hr = null;
		this.steps = null;
		this.battery = null;
		this.batteryPct = null;
		this.accel = null;
		this.launchId = null;
		this.openTimer = null;
	}
	onDisplaying(app) {
		this.idle = app.first;
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
	onUndisplaying(app) {
		this.listen(false);
		this.endOpening();
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
		return { corners: m.cfg.corners, date: this.date, pi: m.pi, net: m.net, temp: m.temp, hr: this.hr, steps: this.steps, battery: this.batteryPct };
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
			const theme = (this.theme = makeTheme(dark));
			app.skin = theme.skins.paper;
			app.distribute("onTheme", theme);
		}
		const r = this.model.result;
		if (kinds.includes("result") && r && r.id === this.launchId) {
			// OK 1: the app takes over the screen; the footer stays until the timer.
			console.log("pi-web: launch " + (r.ok ? "ok" : "failed"));
			if (r.ok) this.launchId = null;
			else this.endOpening();
		}
		if (kinds.includes("sheet")) {
			const m = this.model;
			if (m.vibe) {
				m.vibe = false;
				console.log("pi-web: vibe");
				try {
					Vibes.shortPulse();
				} catch (e) {
				}
			}
			if (m.sheet) this.showSheet(app, m.sheet);
			else this.hideSheet(app);
		}
		app.distribute("onCorners", this.data());
	}
	showSheet(app, sheet) {
		if (!this.sheet) {
			this.sheet = new Sheet({ theme: this.theme });
			app.add(this.sheet);
		}
		this.sheet.delegate("onSheet", sheet);
		if (this.state === "hidden" || this.state === "falling") this.run(app, "rising");
		this.listen(true);
	}
	hideSheet(app) {
		if (this.state === "hidden" || this.state === "falling") return;
		this.listen(false);
		this.endOpening();
		this.sheet.delegate("stop");
		this.run(app, "falling");
	}
	// Flick (spec §6.3): the accelerometer is open only while a sheet is up or rising.
	listen(on) {
		if (on && !this.accel) {
			try {
				this.accel = new Accelerometer({ onTap: () => this.flick() });
			} catch (e) {
				console.log("pi-web: no accelerometer: " + e);
			}
		} else if (!on && this.accel) {
			this.accel.close();
			this.accel = null;
		}
	}
	// A flick is ignored while the footer shows and until the launch's result (or
	// the sheet falls): a second flick mid-POST would launch twice.
	flick() {
		if (this.launchId !== null || this.openTimer !== null || !this.sheet) return;
		console.log("pi-web: flick");
		this.sheet.delegate("onOpening", true);
		this.launchId = this.link.send("launch");
		this.openTimer = Timer.set(() => {
			this.openTimer = null;
			if (this.sheet) this.sheet.delegate("onOpening", false);
		}, OPENING_MS);
	}
	endOpening() {
		if (this.openTimer !== null) Timer.clear(this.openTimer);
		this.openTimer = null;
		this.launchId = null;
		if (this.sheet) this.sheet.delegate("onOpening", false);
	}
	// Starts the rise or the fall; a reversal mid-way starts from where the other one was.
	run(app, state) {
		if (!this.timeline) {
			const top = screen.height - SHEET_HEIGHT;
			this.timeline = new Timeline()
				.to(this.idle, { height: top }, RISE_MS, Math.quadEaseOut, 0)
				.to(this.sheet, { y: top }, RISE_MS, Math.quadEaseOut, -RISE_MS);
		}
		const moving = this.state === "rising" || this.state === "falling";
		const time = moving ? RISE_MS - app.time : 0;
		this.state = state;
		app.stop();
		app.duration = RISE_MS;
		app.time = time;
		app.start();
	}
	onTimeChanged(app) {
		this.timeline.seekTo(this.state === "rising" ? app.time : RISE_MS - app.time);
		this.idle.delegate("place", this.idle.height);
	}
	onFinished(app) {
		this.onTimeChanged(app);
		if (this.state === "rising") {
			this.state = "up";
			return;
		}
		this.state = "hidden";
		app.remove(this.sheet);
		this.sheet = null;
		this.timeline = null;
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
