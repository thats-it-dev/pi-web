// The watch's state, as the phone's dicts build it (pure: tested in node).
// Rows are split by \x1e, fields by \x1f (watch/app/src/pkjs/bridge.js).
const ROW = "\x1e";
const FIELD = "\x1f";

const split = (s, sep) => (s ? String(s).split(sep) : []);

// id, title, status (w|r|d|e), sub
export function parseRows(s) {
	return split(s, ROW).map((line) => {
		const f = line.split(FIELD);
		return { id: f[0], title: f[1] || "", status: f[2] || "d", sub: f[3] || "" };
	});
}

export function parseOptions(s) {
	return split(s, FIELD);
}

// apply(dict) returns what changed (the dict's MSG), or null for nothing.
export function createModel() {
	const m = {
		home: [],
		query: null,
		reply: null,
		dark: false,
		net: "connecting",
		notice: null,
		apply(d) {
			const msg = d.get("MSG");
			const str = (k) => String(d.get(k) ?? "");
			if (msg === "home")
				m.home = parseRows(d.get("ROWS"));
			else if (msg === "query")
				m.query = { id: str("ID"), source: str("SOURCE"), label: str("LABEL"), text: str("TEXT"), options: parseOptions(d.get("OPTIONS")), at: str("AT") };
			else if (msg === "query_gone") {
				if (!m.query || m.query.id !== str("ID"))
					return null;
				m.query = null;
			}
			else if (msg === "reply")
				m.reply = { sessionId: str("SESSION_ID"), label: str("LABEL"), text: str("TEXT"), at: str("AT"), status: str("STATUS") };
			else if (msg === "notice")
				m.notice = str("NOTICE");
			else if (msg === "cfg")
				m.dark = !!d.get("DARK");
			else if (msg === "net")
				m.net = str("NET");
			else
				return null;
			return msg;
		},
	};
	return m;
}
