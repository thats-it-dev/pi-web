// The app: pebble-ui's window stack with Home at the bottom, fed by the phone's
// dicts through the model. Windows read WindowStack.current.model and send
// commands with WindowStack.current.link; they hear onModel(kind) after each
// batch of dicts.
import WindowStack from "pebble-ui/WindowStack";
import Vibes from "pebble/vibes";
import Timer from "timer";
import { createModel } from "model";
import { createLink } from "link";

// Same order as package.json pebble.messageKeys: pebble/message maps index n to key 10000 + n.
export const KEYS = (
	"MSG CMD CMD_ID ID SESSION_ID LABEL SOURCE TEXT OPTIONS ROWS AT STATUS " +
	"NOTICE NET DARK HUB_URL LIST PROVIDER MODEL_ID CODE OK"
).split(" ");

const DARK_KEY = "pi-web.dark";
const CONNECTING_MS = 10000; // "connecting" for this long reads as offline
const SESSION_BIT = 0x80000000; // a launch code for a session alert; without it, a query
const LAUNCH_MS = 10000; // how long a launch waits for the phone's answer
const COALESCE = ["home", "reply", "net", "cfg"]; // a later dict of these replaces an earlier one (bridge.js)

class PiStack extends WindowStack {
	onCreate(application, $) {
		super.onCreate(application, $);
		const model = this.model = createModel();
		try {
			model.dark = localStorage.getItem(DARK_KEY) === "1";
		} catch (e) {
		}
		// A dict is applied as it is read (pebble/message holds one unread dict),
		// or after a slide (receive); the windows update once, after the read,
		// for everything that arrived.
		this.link = createLink({
			keys: KEYS,
			onMessage: (dict) => this.receive(dict),
		});
		this.watchNet();
		this.launch();
	}
	// A dict that lands while a window slides is held until the slide ends.
	// Both screens are up then, and popping back to Home builds its menu at
	// the slide's start from the rows it had: a home dict parsed there (new
	// rows while the old ones are drawn) ran the chunk heap out. The phone
	// answers Archive with a home dict, so that slide got one every time.
	receive(dict) {
		if (this.sliding) {
			const held = this.held ??= [], msg = dict.get("MSG");
			const at = COALESCE.includes(msg) ? held.findIndex(d => d.get("MSG") === msg) : -1;
			if (at < 0)
				held.push(dict);
			else
				held[at] = dict; // the phone coalesces these too: only the latest counts
			return;
		}
		const model = this.model, dark = model.dark, net = model.net, kind = model.apply(dict);
		if (!kind)
			return;
		if (dark !== model.dark) {
			try {
				localStorage.setItem(DARK_KEY, model.dark ? "1" : "0");
			} catch (e) {
			}
		}
		if (net !== model.net)
			this.watchNet();
		// Kept until a window lands to show it (notice.js).
		if (kind === "notice")
			this.notice = { string: model.notice, at: Date.now() };
		this.changed(kind);
	}
	// Set after super.display: a slide still running is completed inside it
	// (run(null) ends it, so onTransitionEnded clears the flag) before the new one starts.
	display(container, view, backwards) {
		const from = this.view;
		super.display(container, view, backwards);
		if (from)
			this.sliding = true;
	}
	// The screen that slid out is gone and purged: apply what was held.
	onTransitionEnded(container) {
		this.sliding = false;
		super.onTransitionEnded(container);
		const held = this.held;
		this.held = null;
		if (held)
			for (const dict of held)
				this.receive(dict);
	}
	// Queues kind for the one deferred onModelChanged.
	changed(kind) {
		if (!this.kinds) {
			this.kinds = [];
			this.container.defer("onModelChanged");
		}
		if (!this.kinds.includes(kind))
			this.kinds.push(kind);
	}
	// A phone stuck connecting shows as offline ("Hub unreachable") after 10 s.
	watchNet() {
		if (this.netTimer !== undefined)
			Timer.clear(this.netTimer);
		this.netTimer = undefined;
		if (this.model.net === "connecting")
			this.netTimer = Timer.set(() => {
				this.netTimer = undefined;
				this.model.net = "offline";
				this.changed("net");
			}, CONNECTING_MS);
	}
	// Opened from an alert: the phone resolves the launch code to a query
	// (sent as query; the alert has buzzed already, so for 10 s a new query
	// doesn't) or a session (sent as reply: the first reply in 10 s opens it,
	// unless a session window is up already). The reason and arguments are
	// logged to check them on the watch (emulator: 6 and the unsigned code).
	launch() {
		const launch = watch.launch ?? {};
		console.log("pi-web: launch reason " + launch.reason + " arguments " + launch.arguments);
		const code = Number(launch.arguments) >>> 0;
		if (!code)
			return;
		if (code >= SESSION_BIT)
			this.sessionUntil = Date.now() + LAUNCH_MS;
		else
			this.quietUntil = Date.now() + LAUNCH_MS;
		this.link.send("launched", { CODE: code | 0 });
	}
	onModelChanged(application) {
		// The first dicts can arrive before Home is up: wait for it.
		if (!this.view) {
			application.defer("onModelChanged");
			return;
		}
		const kinds = this.kinds;
		this.kinds = null;
		this.syncQuery(kinds.includes("query"));
		if (kinds.includes("notice"))
			this.sessionUntil = 0; // e.g. "+ New session" refused: no later reply opens
		if (Date.now() < this.sessionUntil && kinds.includes("reply")) {
			this.sessionUntil = 0;
			if (!this.windows.some(view => view.data.mode === "session"))
				this.open("session", this.model.reply.sessionId);
		}
		for (const kind of kinds)
			application.distribute("onModel", kind);
	}
	// The stack from the bottom, the current window last.
	get windows() {
		return this.history.concat(this.view);
	}
	// The query window leaves when its query does; a new query opens over
	// whatever is showing, with one buzz.
	syncQuery(arrived) {
		const query = this.model.query, id = query ? query.id : null;
		const windows = this.windows;
		const at = windows.findIndex(view => view.data.mode === "query");
		if (at > 0 && windows[at].data.id !== id)
			this.pop(windows.length - at);
		if (arrived && id !== null && id !== this.buzzed) {
			this.buzzed = id;
			if (!(Date.now() < this.quietUntil))
				Vibes.shortPulse();
			this.open("query", id);
		}
	}
	// A window that fails to build logs instead of stopping the app.
	open(mode, id) {
		try {
			this.push("windows/text", { mode, id });
		}
		catch (e) {
			console.log("pi-web: no " + mode + " window: " + e);
		}
	}
	// Tells the phone (and the hub) what is on screen: the topmost query or
	// session window under any action menu, else Home.
	onScreenDisplayed(container) {
		super.onScreenDisplayed(container);
		const shown = this.windows.findLast(view => view.data.mode);
		const data = shown && shown.data;
		this.link.send("showing", data && (data.mode === "query" ? { ID: data.id } : { SESSION_ID: data.id }));
	}
}

const App = Application.template($ => ({ behavior: new PiStack }));

export default new App(
	{ View: "windows/home" },
	{ commandListLength: 1024, displayListLength: 1024, touchCount: 0, pixels: screen.width * 4 },
);
