// The phone-side model: turns hub frames into AppMessage dicts for the watch
// and watch commands into hub calls. ES5 only; all dependencies are injected.
// The dict shapes are the contract with the watch (see the task 7 report).

var MSG_BYTES = 1000; // spec §6.4: one AppMessage, whole dict
var ROW_SEP = "\x1e"; // between rows of a list
var FIELD_SEP = "\x1f"; // between fields of a row, and between options
var HOME_ROWS = 12;
var TITLE_MAX = 40;
var LABEL_MAX = 40;
var TEXT_MAX = 600;
var OPTION_MAX = 24;
var NOTICE_MAX = 120;
var HUB_ERROR_MAX = 40; // the notice box fits about this many characters
var RETRY_MS = 500;
var NOTICE_FAIL = "Hub unreachable";
var EMPTY_TEXT = "New session — send a ring note"; // a session with no turns yet (Home's "+ New session")
var DARK_KEY = "pi-web.dark";
var COALESCE = { home: true, net: true, cfg: true, reply: true };
var NETS = { connecting: true, online: true, offline: true, unconfigured: true };
var STATUS_LETTER = { waiting: "w", running: "r", done: "d", error: "e" };

function str(s) {
	return s === null || s === undefined ? "" : String(s);
}

// One line of text that cannot be mistaken for a separator.
function clean(s) {
	return str(s).replace(/[\t\n\r\x1e\x1f]/g, " ").replace(/^\s+|\s+$/g, "");
}

// Markdown -> plain text for the watch. Regex-based and forgiving: any
// surprise returns the input unchanged.
var HTML_TAGS = "br|hr|b|i|u|s|em|strong|p|div|span|a|code|pre|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|sup|sub|details|summary|img|blockquote|kbd|del|ins|mark|small|center";
var HTML_RE = new RegExp("<\\/?(?:" + HTML_TAGS + ")(?:\\s[^>\\n]*)?\\/?>", "gi");
var SCRUB_CAP = 6000;
function scrubMarkdown(text) {
	var input = str(text);
	try {
		// TEXT is clipped to 600 chars anyway; the cap keeps regex backtracking cheap.
		var s = input.slice(0, SCRUB_CAP).replace(/\r\n?/g, "\n");
		// Fenced blocks (an unterminated one runs to the end).
		s = s.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, function (m, body) {
			var lines = body.split("\n");
			for (var i = 0; i < lines.length; i++) {
				var l = lines[i].replace(/^\s+|\s+$/g, "");
				if (l) return l.length <= 40 ? "[code] " + l : "[code]";
			}
			return "[code]";
		});
		s = s.replace(/<br\s*\/?>/gi, "\n").replace(HTML_RE, "");
		s = s.replace(/`([^`\n]+)`/g, "$1");
		s = s.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, function (m, alt) { return alt || "[image]"; });
		s = s.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1");
		s = s.replace(/^[ \t]*#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, "$1");
		s = s.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");
		s = s.split("\n").filter(function (l) {
			return !(/^[\s|:-]+$/.test(l) && l.indexOf("-") >= 0 && l.indexOf("|") >= 0);
		}).join("\n");
		s = s.replace(/^[ \t]*\|(.*?)\|?[ \t]*$/gm, function (m, row) {
			return row.split("|").map(function (c) { return c.replace(/^\s+|\s+$/g, ""); }).join(" · ");
		});
		s = s.replace(/^(?:[ \t]*>)+[ \t]?/gm, "");
		s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
		s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1");
		s = s.replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w|\.\w)/gm, "$1$2");
		s = s.replace(/(^|\s)\*(?=\w)([^*\n]*?\w)\*(?![\w*])/gm, "$1$2");
		s = s.replace(/(^|\s)_(?=\w)([^_\n]*?\w)_(?!\w)/gm, "$1$2");
		s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
		return s.replace(/^\s+|\s+$/g, "");
	} catch (e) {
		return input;
	}
}

// Message TEXT keeps its line breaks (Piu Text wraps at "\n"): blank lines
// collapse to one break, separators and tabs become spaces.
function cleanText(s) {
	return scrubMarkdown(s)
		.replace(/[\x1e\x1f\t]/g, " ")
		.replace(/\r/g, "")
		.replace(/[ ]*\n(?:[ ]*\n)*[ ]*/g, "\n")
		.replace(/^\s+|\s+$/g, "");
}

// Piu wraps only at spaces (and CJK), so a long path would run off the
// watch's edge: within a long Latin token, a space after a "/" once the piece
// is 8 characters, and at most every 15 (16 with a clipping ellipsis).
var PIECE_MAX = 15;
function breakable(s) {
	return s.replace(/[\x21-\u2000]{16,}/g, function (token) {
		var out = "";
		var run = 0;
		for (var i = 0; i < token.length; i++) {
			var c = token.charAt(i);
			out += c;
			run++;
			if (i < token.length - 1 && ((c === "/" && run >= 8) || run >= PIECE_MAX)) {
				out += " ";
				run = 0;
			}
		}
		return out;
	});
}

function pad2(n) {
	return (n < 10 ? "0" : "") + n;
}

// "HH:MM", 24 h, phone local time; "" for no time.
function clock(ms) {
	if (typeof ms !== "number" || !isFinite(ms)) return "";
	var d = new Date(ms);
	return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// "4:12" (m:ss) under an hour, "1:05" (h:mm) after.
function elapsed(ms) {
	var s = Math.max(0, Math.floor(ms / 1000));
	if (s < 3600) return Math.floor(s / 60) + ":" + pad2(s % 60);
	return Math.floor(s / 3600) + ":" + pad2(Math.floor((s % 3600) / 60));
}

function utf8Length(s) {
	var n = 0;
	for (var i = 0; i < s.length; i++) {
		var c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

// Pebble's dict cost: a 1-byte count, then per tuple 7 bytes (key 4, type 1, length 2)
// plus the value (int32: 4; string: UTF-8 bytes plus NUL).
function dictBytes(dict) {
	var n = 1;
	for (var k in dict) {
		var v = dict[k];
		n += 7 + (typeof v === "string" ? utf8Length(v) + 1 : 4);
	}
	return n;
}

var ELLIPSIS = "…";
var OPTION_MIN = 12; // options are clipped no shorter than this before the text gives way entirely
var TEXT_MIN = 40;

// At most n UTF-16 units, never ending inside a surrogate pair.
function cut(s, n) {
	s = s.slice(0, Math.max(0, n));
	var c = s.charCodeAt(s.length - 1);
	return c >= 0xd800 && c <= 0xdbff ? s.slice(0, -1) : s;
}

function clipTo(s, n) {
	s = str(s);
	return s.length > n ? cut(s, n) : s;
}

// A label for display: at most n units, ending in an ellipsis when it was cut.
function clipLabel(s, n) {
	return s.length > n ? cut(s, n - 1) + ELLIPSIS : s;
}

// The longest option loses one character (keeping a trailing ellipsis); false when none is longer than min.
function clipLongest(shown, min) {
	var at = -1;
	for (var i = 0; i < shown.length; i++) if (shown[i].length > min && (at < 0 || shown[i].length > shown[at].length)) at = i;
	if (at < 0) return false;
	var s = shown[at];
	if (s.charAt(s.length - 1) === ELLIPSIS) s = s.slice(0, -1);
	shown[at] = cut(s, s.length - 1) + ELLIPSIS;
	return true;
}

// Fits dict[key] (a FIELD_SEP-joined list of shown) and dict.TEXT into MSG_BYTES: the text trims
// to TEXT_MIN, then options clip to OPTION_MIN, then the text trims away, then trailing options
// drop. Returns the shown options (index i is option i).
function fitQuery(dict, shown) {
	var text = dict.TEXT;
	var trimmed = false;
	function fits() {
		dict.OPTIONS = shown.join(FIELD_SEP);
		dict.TEXT = trimmed ? text + ELLIPSIS : text;
		return dictBytes(dict) <= MSG_BYTES;
	}
	function trimText(min) {
		while (!fits() && text.length > min) {
			text = cut(text, text.length - Math.max(1, Math.ceil((text.length - min) / 8)));
			trimmed = true;
		}
	}
	trimText(TEXT_MIN);
	while (!fits() && clipLongest(shown, OPTION_MIN)) {}
	trimText(0);
	while (!fits() && shown.length > 0) shown.pop();
	return shown;
}

// Drops rows from the end until dict[key] (rows joined by ROW_SEP) fits MSG_BYTES.
function fitRows(dict, key, rows) {
	rows = rows.slice();
	dict[key] = rows.join(ROW_SEP);
	while (dictBytes(dict) > MSG_BYTES && rows.length > 0) {
		rows.pop();
		dict[key] = rows.join(ROW_SEP);
	}
	return rows;
}

function byCreated(queries) {
	return (queries || []).slice().sort(function (a, b) {
		return a.createdAt - b.createdAt;
	});
}

function findBy(list, key, id) {
	if (id === null || id === undefined) return null;
	for (var i = 0; i < (list || []).length; i++) if (list[i][key] === id) return list[i];
	return null;
}

function darkValue(d) {
	return d === true || d === 1 || d === "1" || d === "true";
}

function createBridge(deps) {
	var hub = deps.hub;
	var storage = deps.storage;
	var log = deps.log || function () {};
	var frame = { queries: [], sessions: [], showing: null };
	var net = "connecting";
	var dark = storage.getItem(DARK_KEY) !== "0";
	var resync = false; // the stream came back: the next pending frame is sent in full
	var sentQuery = null; // the id of the query the watch was last told about
	var launchQuery = null; // a query the watch was launched for, current while it exists
	var fullOptions = {}; // query id -> the hub's option strings, index for index
	var answering = {}; // query ids with an answer or skip on its way to the hub
	var runStart = {}; // session id -> when the phone first saw it running
	var openSession = null; // the session whose reply the watch is looking at
	var openText = ""; // the text last sent for it
	var openMeta = ""; // its status and time as last sent (or, while its history loads, as now)
	var finalText = null; // the last finished message of its run (a text frame with streaming false)
	var fetching = null; // the session whose reply is being fetched from the history
	var gotFrame = false; // a real pending frame has arrived
	var showing = { id: null, sessionId: null }; // what the watch last said is on screen
	var creating = false; // a "+ New session" on its way to the hub

	var queue = [];
	var inFlight = null;
	var lastQueued = {};

	// Outbox ---------------------------------------------------------------

	function enqueue(dict, force) {
		var msg = dict.MSG;
		if (COALESCE[msg]) {
			var json = JSON.stringify(dict);
			if (!force && lastQueued[msg] === json) return;
			lastQueued[msg] = json;
			for (var i = 0; i < queue.length; i++) {
				if (queue[i].MSG === msg) {
					queue[i] = dict;
					return;
				}
			}
		}
		queue.push(dict);
		pump();
	}

	function queued(msg) {
		for (var i = 0; i < queue.length; i++) if (queue[i].MSG === msg) return true;
		return false;
	}

	function pump() {
		if (inFlight || queue.length === 0) return;
		transmit({ dict: queue.shift(), tries: 0 });
	}

	function transmit(item) {
		var settled = false;
		inFlight = item;
		item.tries++;
		deps.send(
			item.dict,
			function () {
				if (settled) return;
				settled = true;
				inFlight = null;
				pump();
			},
			function () {
				if (settled) return;
				settled = true;
				var msg = item.dict.MSG;
				if (item.tries < 2 && !(COALESCE[msg] && queued(msg))) {
					deps.setTimeout(function () {
						transmit(item);
					}, RETRY_MS);
					return;
				}
				log("pi-web: drop " + msg + " after " + item.tries + " tries");
				if (COALESCE[msg] && lastQueued[msg] === JSON.stringify(item.dict)) delete lastQueued[msg];
				inFlight = null;
				pump();
			}
		);
	}

	// What a failed hub call tells the user: the hub's own words when it answered, else reachability.
	function failText(err) {
		if (!err || typeof err.status !== "number") return NOTICE_FAIL;
		if (typeof err.hubError === "string" && clean(err.hubError)) return clipLabel(clean(err.hubError), HUB_ERROR_MAX);
		return "Hub error " + err.status;
	}

	function notice(text) {
		enqueue({ MSG: "notice", NOTICE: clipLabel(clean(text), NOTICE_MAX) });
	}

	// Home ------------------------------------------------------------------

	function sessionById(id) {
		return findBy(frame.sessions, "id", id);
	}

	function letterOf(s) {
		return STATUS_LETTER[s.status] || "d";
	}

	function subOf(s, now) {
		if (s.status === "running") return runStart[s.id] === undefined ? "" : elapsed(now - runStart[s.id]);
		if (s.status === "done") return clock(s.updatedAt);
		return "";
	}

	// Waiting sessions first, otherwise the hub's order.
	function ordered() {
		var waiting = [];
		var rest = [];
		for (var i = 0; i < frame.sessions.length; i++) (frame.sessions[i].status === "waiting" ? waiting : rest).push(frame.sessions[i]);
		return waiting.concat(rest);
	}

	function sendHome(force) {
		var now = deps.now();
		var rows = ordered()
			.slice(0, HOME_ROWS)
			.map(function (s) {
				return [clean(s.id), clipTo(clean(s.title), TITLE_MAX), letterOf(s), subOf(s, now)].join(FIELD_SEP);
			});
		var dict = { MSG: "home" };
		fitRows(dict, "ROWS", rows);
		enqueue(dict, force);
	}

	function trackRuns() {
		var now = deps.now();
		var seen = {};
		for (var i = 0; i < frame.sessions.length; i++) {
			var s = frame.sessions[i];
			if (s.status !== "running") continue;
			seen[s.id] = true;
			if (runStart[s.id] === undefined) runStart[s.id] = now;
		}
		for (var id in runStart) if (!seen[id]) delete runStart[id];
	}

	// Queries ---------------------------------------------------------------

	// The query the watch should be showing: the one it was launched for, else the oldest.
	function target() {
		var sorted = byCreated(frame.queries);
		return findBy(sorted, "id", launchQuery) || sorted[0] || null;
	}

	function queryDict(q) {
		var full = (q.options || []).map(str);
		var dict = {
			MSG: "query",
			ID: str(q.id),
			SOURCE: q.source === "ring-profile" ? "ring" : "pi",
			SESSION_ID: q.sessionId ? str(q.sessionId) : "",
			LABEL: clipTo(clean(q.label), LABEL_MAX),
			TEXT: clipTo(breakable(cleanText(q.text)), TEXT_MAX),
			OPTIONS: "",
			AT: clock(q.createdAt),
		};
		fitQuery(dict, full.map(function (o) { return clipLabel(clean(o), OPTION_MAX); }));
		fullOptions[q.id] = full;
		return dict;
	}

	function sendQuery(q) {
		enqueue(queryDict(q));
		sentQuery = q.id;
	}

	// query_gone for a query that left, then the next one; force re-sends the current one.
	function syncQuery(force) {
		var q = target();
		if (sentQuery !== null && (!q || q.id !== sentQuery)) {
			enqueue({ MSG: "query_gone", ID: sentQuery });
			sentQuery = null;
		}
		if (q && (sentQuery !== q.id || force)) sendQuery(q);
		for (var id in fullOptions) if (!findBy(frame.queries, "id", id)) delete fullOptions[id];
		for (var a in answering) if (!findBy(frame.queries, "id", a)) delete answering[a];
		if (gotFrame && launchQuery !== null && !findBy(frame.queries, "id", launchQuery)) launchQuery = null;
	}

	function update(force) {
		trackRuns();
		sendHome(force);
		syncQuery(force);
		if (openSession !== null) {
			var s = sessionById(openSession);
			var meta = s ? letterOf(s) + clock(s.updatedAt) : openMeta;
			if (meta === openMeta) return;
			// A fetch on its way sends with the status as it is then: sending the old
			// text now would show it under the new status until the fetch lands.
			if (fetching === openSession) {
				openMeta = meta;
				return;
			}
			// The run is over: its last turn comes from the history, sent once. Waiting
			// (a dialog mid-run) counts too, on purpose: the user has to act, so the
			// dots stop and the turn's latest message shows.
			if (openMeta.charAt(0) === "r" && meta.charAt(0) !== "r") {
				openMeta = meta;
				// Fallback if the history fails: the final frame is only the message's
				// last 240 characters (the hub's tail), the history gives up to 600 from its start.
				fetchReply(openSession, finalText !== null ? finalText : openText);
			} else sendReply(openSession, openText, false);
		}
	}

	function removeQuery(id) {
		frame.queries = frame.queries.filter(function (q) {
			return q.id !== id;
		});
		if (frame.showing && frame.showing.queryId === id) frame.showing = null;
	}

	// Replies ---------------------------------------------------------------

	function replyDict(sid, text) {
		var s = sessionById(sid);
		var dict = {
			MSG: "reply",
			SESSION_ID: str(sid),
			LABEL: s ? clipTo(clean(s.title), LABEL_MAX) : "",
			TEXT: clipTo(breakable(cleanText(text)), TEXT_MAX),
			AT: s ? clock(s.updatedAt) : "",
			STATUS: s ? letterOf(s) : "d",
		};
		// Multibyte text can exceed the dict even at TEXT_MAX characters.
		var t = dict.TEXT;
		while (dictBytes(dict) > MSG_BYTES && t.length > 0) {
			t = cut(t, t.length - Math.max(1, Math.ceil(t.length / 8)));
			dict.TEXT = t + ELLIPSIS;
		}
		return dict;
	}

	function sendReply(sid, text, force) {
		var dict = replyDict(sid, text);
		openText = text;
		var s = sessionById(sid);
		openMeta = s ? letterOf(s) + clock(s.updatedAt) : "";
		enqueue(dict, force);
	}

	// The last agent turn from the hub's history, sent as the open session's reply.
	// Without one (no agent turn, or no history), fallback; with no fallback, no
	// agent turn is "" and a failed fetch a notice.
	function fetchReply(sid, fallback) {
		fetching = sid;
		hub.get("/api/watch/history?session=" + encodeURIComponent(sid) + "&limit=6", function (err, json) {
			if (fetching === sid) fetching = null;
			if (openSession !== sid) return;
			var text = null;
			var turns = (json && json.turns) || [];
			for (var i = turns.length - 1; i >= 0 && text === null; i--) if (turns[i].role === "agent") text = str(turns[i].text);
			if (err || !json) log("pi-web: history for " + sid + " failed: " + (err && err.message));
			if (text === null && fallback === null && (err || !json)) {
				notice("Couldn't load the reply");
				return;
			}
			finalText = null;
			sendReply(sid, text !== null ? text : fallback !== null ? fallback : turns.length ? "" : EMPTY_TEXT, true);
		});
	}

	// Streamed text is not relayed: the watch shows the last finished reply and,
	// while the session runs, a typing indicator; the run's end sends the new reply.
	function open(sid) {
		var s = sessionById(sid);
		openSession = sid;
		openText = "";
		openMeta = s ? letterOf(s) + clock(s.updatedAt) : "";
		finalText = null;
		fetchReply(sid, null);
	}

	// Commands -------------------------------------------------------------

	function post(path, body, done) {
		hub.post(path, body, function (err, json) {
			if (err) {
				log("pi-web: " + path + " failed: " + err.message);
				notice(failText(err));
			}
			if (done) done(err, json);
		});
	}

	function answer(p) {
		var id = str(p.ID);
		var full = fullOptions[id];
		var option = full && typeof p.OK === "number" ? full[p.OK] : undefined;
		if (option === undefined) {
			log("pi-web: answer for " + id + " has no such option");
			return;
		}
		if (answering[id]) return;
		answering[id] = true;
		post("/api/watch/answer", { queryId: id, option: option }, function (err, json) {
			if (err) {
				delete answering[id];
				return;
			}
			if (json && (json.ok || json.reason === "gone")) {
				removeQuery(id);
				update();
				return;
			}
			delete answering[id];
			notice("Answer not accepted");
		});
	}

	function skip(p) {
		var id = str(p.ID);
		if (answering[id]) return;
		answering[id] = true;
		post("/api/watch/skip", { queryId: id }, function (err) {
			if (err) {
				delete answering[id];
				return;
			}
			removeQuery(id);
			update();
		});
	}

	function archive(sid) {
		post("/api/watch/archive", { sessionId: sid }, function (err) {
			if (err) return;
			frame.sessions = frame.sessions.filter(function (s) {
				return s.id !== sid;
			});
			update();
		});
	}

	// Home's "+ New session": an empty session in ~/pebble, opened like a session
	// alert's (the watch opens the reply that follows), but only while the watch
	// is still on Home: opening it over a session or query the user moved to
	// would take over that window's replies. Its next ring note is the prompt.
	function create() {
		if (creating) return;
		creating = true;
		post("/api/watch/new", {}, function (err, json) {
			creating = false;
			if (!err && json && json.sessionId && showing.id === null && showing.sessionId === null) open(str(json.sessionId));
		});
	}

	function models(sid) {
		hub.get("/api/watch/models?session=" + encodeURIComponent(sid), function (err, json) {
			if (err || !json) {
				log("pi-web: models for " + sid + " failed: " + (err && err.message));
				notice("Couldn't load models");
				return;
			}
			var rows = (json.models || []).map(function (m) {
				return [clean(m.provider), clean(m.id), clipTo(clean(m.name), LABEL_MAX)].join(FIELD_SEP);
			});
			var dict = { MSG: "models", SESSION_ID: sid };
			fitRows(dict, "LIST", rows);
			enqueue(dict);
		});
	}

	function launched(p) {
		var code = typeof p.CODE === "number" ? p.CODE : -1;
		// The code is a 32-bit pattern; the AppMessage int may arrive signed.
		if (code < 0) code = code >>> 0;
		hub.get("/api/watch/launch-target?code=" + code, function (err, json) {
			if (err || !json) {
				log("pi-web: launch target " + code + " unknown: " + (err && err.message));
				return;
			}
			if (json.queryId) {
				launchQuery = json.queryId;
				if (findBy(frame.queries, "id", json.queryId)) syncQuery(true);
			} else if (json.sessionId) {
				open(str(json.sessionId));
			}
		});
	}

	function onShowing(p) {
		var id = p.ID ? str(p.ID) : null;
		var sid = p.SESSION_ID ? str(p.SESSION_ID) : null;
		showing = { id: id, sessionId: sid };
		var was = openSession;
		openSession = id === null && sid !== null ? sid : null;
		if (openSession !== was) finalText = null;
		hub.showing(id, sid);
	}

	function onAppMessage(p) {
		p = p || {};
		var cmd = str(p.CMD);
		var sid = p.SESSION_ID ? str(p.SESSION_ID) : "";
		if (cmd === "showing") onShowing(p);
		else if (cmd === "answer") answer(p);
		else if (cmd === "skip") skip(p);
		else if (cmd === "open" && sid) open(sid);
		else if (cmd === "continue" && sid) post("/api/watch/prompt", { sessionId: sid, text: "continue" });
		else if (cmd === "stop" && sid) post("/api/watch/abort", { sessionId: sid });
		else if (cmd === "archive" && sid) archive(sid);
		else if (cmd === "models" && sid) models(sid);
		else if (cmd === "model" && sid) post("/api/watch/model", { sessionId: sid, provider: str(p.PROVIDER), modelId: str(p.MODEL_ID) });
		else if (cmd === "launched") launched(p);
		else if (cmd === "new") create();
		else log("pi-web: unknown command " + cmd);
	}

	function sendAll() {
		enqueue({ MSG: "cfg", DARK: dark ? 1 : 0 }, true);
		enqueue({ MSG: "net", NET: net }, true);
		update(true);
	}

	return {
		start: function () {
			sendAll();
		},
		setHub: function (h) {
			hub = h;
		},
		onPending: function (f) {
			if (!f) return;
			var force = resync;
			resync = false;
			gotFrame = true;
			frame = { queries: f.queries || [], sessions: f.sessions || [], showing: f.showing === undefined ? null : f.showing };
			update(force);
		},
		// Only finished messages (streaming false), and while the session runs only kept
		// for the run's end: one turn can finish several messages around its tool calls.
		onText: function (f) {
			if (!f || !f.sessionId || f.sessionId !== openSession || f.streaming === true) return;
			if (openMeta.charAt(0) === "r") finalText = str(f.text);
			else sendReply(f.sessionId, str(f.text), false);
		},
		onNotice: function (f) {
			if (f && f.text) notice(f.text);
		},
		onStatus: function (s) {
			if (!NETS[s]) return;
			net = s;
			enqueue({ MSG: "net", NET: s });
			if (s === "online") {
				resync = true;
				if (showing.id !== null || showing.sessionId !== null) hub.showing(showing.id, showing.sessionId);
			}
		},
		onAppMessage: onAppMessage,
		onSettings: function (s) {
			if (!s) return;
			if (s.DARK !== undefined && s.DARK !== null) dark = darkValue(s.DARK);
			enqueue({ MSG: "cfg", DARK: dark ? 1 : 0 });
		},
	};
}

module.exports = {
	createBridge: createBridge,
	clean: clean,
	breakable: breakable,
	scrubMarkdown: scrubMarkdown,
	clock: clock,
	elapsed: elapsed,
	dictBytes: dictBytes,
};
