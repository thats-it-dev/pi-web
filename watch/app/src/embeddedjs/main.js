// The app: pebble-ui's window stack with Home at the bottom, fed by the phone's
// dicts through the model. Windows read WindowStack.current.model and send
// commands with WindowStack.current.link; they hear onModel(kind) after each
// batch of dicts.
import WindowStack from "pebble-ui/WindowStack";
import Vibes from "pebble/vibes";
import { createModel } from "model";
import { createLink } from "link";

// Same order as package.json pebble.messageKeys: pebble/message maps index n to key 10000 + n.
export const KEYS = (
	"MSG CMD CMD_ID ID SESSION_ID LABEL SOURCE TEXT OPTIONS ROWS AT STATUS " +
	"NOTICE NET DARK HUB_URL LIST PROVIDER MODEL_ID CODE OK"
).split(" ");

const DARK_KEY = "pi-web.dark";

class PiStack extends WindowStack {
	onCreate(application, $) {
		super.onCreate(application, $);
		const model = this.model = createModel();
		try {
			model.dark = localStorage.getItem(DARK_KEY) === "1";
		} catch (e) {
		}
		// A dict is applied as it is read (pebble/message holds one unread dict);
		// the windows update once, after the read, for everything that arrived.
		this.link = createLink({
			keys: KEYS,
			onMessage: (dict) => {
				const dark = model.dark, kind = model.apply(dict);
				if (!kind)
					return;
				if (dark !== model.dark) {
					try {
						localStorage.setItem(DARK_KEY, model.dark ? "1" : "0");
					} catch (e) {
					}
				}
				if (!this.kinds) {
					this.kinds = [];
					application.defer("onModelChanged");
				}
				if (!this.kinds.includes(kind))
					this.kinds.push(kind);
			},
		});
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
			Vibes.shortPulse();
			this.open("query", id);
		}
	}
	// windows/text arrives with the session and query screens (Task 9); until
	// then opening one only logs.
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
