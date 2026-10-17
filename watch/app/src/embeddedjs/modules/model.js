const num = (v) => (typeof v === "number" && v >= 0 ? v : null);
const lines = (s) => (s ? String(s).split("\n") : []);

export function parseRows(kind, rows) {
	return rows.map((line) => {
		const f = line.split("\t");
		if (kind === "sessions")
			return { id: f[0], title: f[1], state: f[2], live: f[3] === "1", model: f[4] || "", ctx: f[5] === "-" || f[5] === undefined || f[5] === "" ? null : Number(f[5]), age: f[6] || "-" };
		if (kind === "history")
			return { i: Number(f[0]), role: f[1], text: f.slice(2).join("\t") };
		return { provider: f[0], id: f[1], name: f[2], current: f[3] === "1" };
	});
}

// While a transcript is out (sending, then its sent/gone feedback) the rows are
// the dimmed status row and `say it again`; otherwise the usual rows (after a
// no_match the request's options return so one can be picked).
const SAY_BUSY = { sending: 1, sent: 1, gone: 1 };

export function homeRows(home, sayIt) {
	if (sayIt && SAY_BUSY[sayIt.status]) return ["sending…", "say it again"];
	if (!home || !home.kind) return ["say it", "menu"];
	if (home.kind === "dialog") return [...home.options, "say it"];
	return ["say it", "dismiss"];
}

function emptyList() {
	return { rows: [], total: 0, complete: false };
}

export function createModel() {
	const results = new Map();
	const m = {
		home: null,
		stats: null,
		text: null,
		net: "connecting",
		cfg: { dark: false },
		lists: { sessions: emptyList(), history: emptyList(), models: emptyList() },
		sayIt: { text: "", status: "idle" },
		resetList(kind) {
			m.lists[kind] = emptyList();
		},
		setSayIt(patch) {
			m.sayIt = { ...m.sayIt, ...patch };
		},
		takeResult(cmdId) {
			const r = results.get(cmdId);
			if (!r) return null;
			results.delete(cmdId);
			return r;
		},
		apply(map) {
			const g = (k) => map.get(k);
			const kind = g("MSG");
			switch (kind) {
				case "home":
					m.home = {
						requestId: g("REQ_ID") || null,
						kind: g("REQ_KIND") || "",
						tool: g("REQ_TOOL") || "",
						text: g("REQ_TEXT") || "",
						options: lines(g("REQ_OPTIONS")),
						index: g("REQ_INDEX") || 0,
						count: g("REQ_COUNT") || 0,
						sessionId: g("SESSION_ID") || "",
						sessionTitle: g("SESSION_TITLE") || "",
						lastText: g("TEXT") || "",
					};
					return kind;
				case "stats":
					m.stats = {
						sessionId: g("SESSION_ID") || "",
						state: g("STATE") || "idle",
						model: g("MODEL") || "",
						ctxPercent: num(g("CTX_PERCENT")),
						ctxTokens: num(g("CTX_TOKENS")),
						ctxWindow: num(g("CTX_WINDOW")),
						tps: num(g("TPS")),
					};
					return kind;
				case "text":
					m.text = { sessionId: g("SESSION_ID") || "", text: g("TEXT") || "", streaming: g("STREAMING") === 1 };
					return kind;
				case "net":
					m.net = g("NET") || "connecting";
					return kind;
				case "result": {
					const r = { ok: g("OK") === 1, reason: g("REASON") || "", options: lines(g("OPTIONS")) };
					const s = m.sayIt;
					// The say-it command's result moves the say-it state; any other waits for takeResult.
					if (s.status === "sending" && s.cmdId !== undefined && g("CMD_ID") === s.cmdId) {
						if (r.ok) m.setSayIt({ status: "sent" });
						else if (r.reason === "no_match") m.setSayIt({ status: "no_match", options: r.options });
						else if (r.reason === "gone") m.setSayIt({ status: "gone" });
						else m.setSayIt({ status: "failed" });
					} else {
						results.set(g("CMD_ID"), r);
					}
					return kind;
				}
				case "list": {
					const name = g("LIST");
					if (!m.lists[name]) return null;
					const list = m.lists[name];
					const parsed = parseRows(name, lines(g("ROWS")));
					const offset = g("OFFSET") || 0;
					if (name === "history") {
						const byI = new Map(list.rows.map((r) => [r.i, r]));
						for (const r of parsed) byI.set(r.i, r);
						list.rows = [...byI.values()].sort((a, b) => a.i - b.i);
					} else {
						const next = list.rows.slice(0, offset);
						while (next.length < offset) next.push(undefined);
						parsed.forEach((r, k) => { next[offset + k] = r; });
						const tail = list.rows.slice(offset + parsed.length);
						list.rows = next.concat(tail).filter((r) => r !== undefined);
					}
					list.total = g("TOTAL") || 0;
					list.complete = g("MORE") !== 1;
					return kind;
				}
				case "cfg":
					m.cfg = { dark: g("DARK") === 1 };
					return kind;
				default:
					return null;
			}
		},
	};
	return m;
}
