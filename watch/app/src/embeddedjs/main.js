import Controller from "piu/Controller";
import { createModel } from "model";
import { createLink } from "link";
import { theme } from "assets";

// Same order as package.json pebble.messageKeys: pebble/message maps index n to key 10000 + n.
export const KEYS = [
	"MSG", "CMD", "CMD_ID", "REQ_ID", "REQ_KIND", "REQ_TOOL", "REQ_TEXT", "REQ_OPTIONS", "REQ_INDEX", "REQ_COUNT",
	"SESSION_ID", "SESSION_TITLE", "STATE", "MODEL", "CTX_PERCENT", "CTX_TOKENS", "CTX_WINDOW", "TPS", "TEXT", "STREAMING",
	"NET", "OK", "REASON", "OPTIONS", "LIST", "ROWS", "OFFSET", "TOTAL", "MORE", "OPTION",
	"PROVIDER", "MODEL_ID", "DARK", "HUB_URL",
];

const DARK_KEY = "pi-web.dark";

function readDark() {
	try {
		return localStorage.getItem(DARK_KEY) !== "0";
	} catch (e) {
		return true;
	}
}

function writeDark(dark) {
	try {
		localStorage.setItem(DARK_KEY, dark ? "1" : "0");
	} catch (e) {
		console.log("pi-web: cannot store theme: " + e);
	}
}

// theme() returns plain descriptors; Piu needs Skin and Style instances.
function makeTheme(dark) {
	const t = theme(dark);
	const skins = {};
	const styles = {};
	for (const k in t.skins) skins[k] = new Skin(t.skins[k]);
	for (const k in t.styles) styles[k] = new Style(t.styles[k]);
	// Menu rows: [normal, selected] colours; the selected row sits on an ink bar (Menu.js).
	styles.row = new Style({ ...t.styles.body, color: [t.ink, t.paper] });
	styles.rowMeta = new Style({ ...t.styles.meta, color: [t.dim, t.paper] });
	styles.rowDim = new Style({ ...t.styles.body, color: [t.dim, t.paper] });
	styles.rowValue = new Style({ ...t.styles.meta, horizontal: "right", color: [t.dim, t.paper] });
	return { paper: t.paper, ink: t.ink, dim: t.dim, skins, styles };
}

function clock24() {
	try {
		return Natives.pi_clock_24h() === 1;
	} catch (e) {
		return false;
	}
}

class PiController extends Controller {
	constructor(dark) {
		super();
		this.dark = dark;
		this.theme = makeTheme(dark);
		this.h24 = clock24();
	}
	onCreate(application, $) {
		super.onCreate(application, $);
		// The Controller's own model is the views' shared app model; $ only names the home view.
		this.screens = $;
		this.model = createModel();
		this.model.cfg.dark = this.dark;
		application.skin = this.theme.skins.paper;
		this.onTimeChanged(application);
		this.link = createLink({
			keys: KEYS,
			onMessage: (map) => this.onMessage(application, map),
		});
		this.link.send("hello");
	}
	onDisplaying(container) {
		const home = this.screens.home;
		const View = importNow(home.View).default;
		const view = new View(home);
		view.id = home.View;
		view.model = this.model;
		this.history = [];
		this.display(container, view, false);
	}
	onMessage(container, map) {
		const kind = this.model.apply(map);
		if (!kind) return;
		if (kind === "cfg") {
			const dark = this.model.cfg.dark;
			if (dark !== this.dark) {
				this.dark = dark;
				writeDark(dark);
				this.theme = makeTheme(dark);
				container.skin = this.theme.skins.paper;
				if (this.view) this.redisplay();
			}
		}
		container.distribute("onModel", kind);
	}
	redisplay() {
		const container = this.container;
		this.onScreenUndisplaying(container, this.view);
		container.replace(container.first, new this.view.Template(this.view));
		this.onScreenDisplayed(container, this.view);
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

const dark = readDark();
globalThis.controller = new PiController(dark);

const PiApplication = Application.template($ => ({
	behavior: globalThis.controller,
}));

const application = new PiApplication(
	{ home: { View: "Home" } },
	{ commandListLength: 2048, displayListLength: 2048, touchCount: 1, pixels: screen.width * 4 },
);

export default application;
