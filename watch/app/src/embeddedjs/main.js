import { createModel } from "model";
import { createLink } from "link";
import { makeTheme } from "assets";

// Same order as package.json pebble.messageKeys: pebble/message maps index n to key 10000 + n.
export const KEYS = (
	"MSG CMD CMD_ID REQ_ID REQ_KIND REQ_TOOL REQ_TEXT REQ_OPTIONS REQ_INDEX REQ_COUNT " +
	"SESSION_ID SESSION_TITLE STATE MODEL CTX_PERCENT CTX_TOKENS CTX_WINDOW TPS TEXT STREAMING " +
	"NET OK REASON OPTIONS LIST ROWS OFFSET TOTAL MORE OPTION PROVIDER MODEL_ID DARK HUB_URL"
).split(" ");

const DARK_KEY = "pi-web.dark";

function storedDark() {
	try {
		return localStorage.getItem(DARK_KEY) !== "0";
	} catch (e) {
		return true;
	}
}

// The screen stack: goTo pushes, goBack/goHome pop; each screen is rebuilt from
// its view (and the shared model) when shown, and swapped in without a
// transition (the spec asks for none, and it keeps the mod small: in the
// emulator the archive is copied into the app heap).
class PiController extends Behavior {
	constructor(dark) {
		super();
		this.dark = dark;
		this.theme = makeTheme(dark);
		this.history = [];
		this.view = null;
	}
	onCreate(application, $) {
		this.container = application;
		// $ only names the home view; the model is the views' shared app model.
		this.screens = $;
		this.model = createModel();
		this.model.cfg.dark = this.dark;
		application.skin = this.theme.skins.paper;
		watch.addEventListener("minutechange", () => application.distribute("onClockChanged"));
		this.link = createLink({
			keys: KEYS,
			onMessage: (map) => this.onMessage(application, map),
		});
		this.link.send("hello");
	}
	onDisplaying(container) {
		const View = importNow(this.screens.home.View).default;
		const view = new View(this.screens.home);
		view.id = this.screens.home.View;
		this.display(container, view);
	}
	display(container, view, backwards) {
		const old = this.view;
		const content = new view.Template(view, { left:0, right:0, top:0, bottom:0 });
		if (old) {
			container.first.distribute("onUndisplaying");
			if (!backwards) this.history.push(old);
			container.replace(container.first, content);
			old.purge();
			container.purge();
		}
		else
			container.add(content);
		this.view = view;
		// After Piu has sent onDisplaying (the screens build there).
		container.defer("onScreenDisplayed");
	}
	onScreenDisplayed(container) {
		container.first.distribute("onDisplayed");
	}
	goBack() {
		if (this.history.length)
			this.container.defer("display", this.history.pop(), true);
	}
	goHome() {
		if (this.history.length) {
			const view = this.history[0];
			this.history.length = 0;
			this.container.defer("display", view, true);
		}
	}
	goTo(id) {
		const view = new (importNow(id).default)();
		view.id = id;
		this.container.defer("display", view);
	}
	// The dict is read and applied at once (pebble/message holds one unread dict,
	// and the next overwrites it); the screens update after the read callback has
	// returned, once for all the kinds that arrived meanwhile.
	onMessage(container, map) {
		const kind = this.model.apply(map);
		if (!kind) return;
		if (!this.kinds) {
			this.kinds = [];
			container.defer("onModelChanged");
		}
		if (!this.kinds.includes(kind)) this.kinds.push(kind);
	}
	onModelChanged(container) {
		const kinds = this.kinds;
		this.kinds = null;
		for (const kind of kinds) {
			const dark = this.model.cfg.dark;
			if (kind === "cfg" && dark !== this.dark) {
				this.dark = dark;
				try {
					localStorage.setItem(DARK_KEY, dark ? "1" : "0");
				} catch (e) {
				}
				this.theme = makeTheme(dark);
				container.skin = this.theme.skins.paper;
				if (this.view) {
					// Rebuild the screen on show in the new theme.
					container.first.distribute("onUndisplaying");
					container.replace(container.first, new this.view.Template(this.view));
					container.purge();
					container.defer("onScreenDisplayed");
				}
			}
			container.distribute("onModel", kind);
		}
	}
	// Leaves the app for the watchface. Returns false when the FFI call is unavailable.
	exit() {
		try {
			Natives.pi_exit();
			return true;
		} catch (e) {
			console.log("pi-web: exit failed: " + e);
			return false;
		}
	}
}

globalThis.controller = new PiController(storedDark());

const PiApplication = Application.template($ => ({
	behavior: globalThis.controller,
}));

export default new PiApplication(
	{ home: { View: "Home" } },
	{ commandListLength: 2048, displayListLength: 2048, touchCount: 1, pixels: screen.width * 4 },
);
