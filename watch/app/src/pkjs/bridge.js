// The phone-side model: turns hub frames into AppMessage dicts for the watch
// and watch commands into hub calls. ES5 only; all dependencies are injected.

var TEXT_MAX = 240;
var MSG_BYTES = 1000; // spec §6.4: one AppMessage, whole dict
var TITLE_MAX = 60;
var NAME_MAX = 40;
var STATS_MS = 1000;
var RETRY_MS = 500;
var HISTORY_PAGE = 12;
var LAST_SESSION = "pi-web.lastSession";
var DARK_KEY = "pi-web.dark";
var COALESCE = { home: true, stats: true, text: true, net: true, cfg: true };
var NETS = { connecting: true, online: true, offline: true, unconfigured: true };

function str(s) {
	return s === null || s === undefined ? "" : String(s);
}

function clean(s) {
	return str(s).replace(/[\t\n\r]/g, " ").replace(/^\s+|\s+$/g, "");
}

function clipTo(s, n) {
	s = str(s);
	return s.length > n ? s.slice(0, n) : s;
}

function clip(s) {
	return clipTo(s, TEXT_MAX);
}

function num(n) {
	return typeof n === "number" && isFinite(n) ? Math.round(n) : -1;
}

function ageLabel(ms) {
	var m = Math.max(0, Math.floor(ms / 60000));
	if (m < 60) return m + "m";
	var h = Math.floor(m / 60);
	if (h < 24) return h + "h";
	return Math.floor(h / 24) + "d";
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

// Rows joined by "\n" per chunk, each chunk at most maxBytes of UTF-8; a row is
// never split, and a row that alone exceeds maxBytes travels alone.
function packRows(rows, maxBytes) {
	var chunks = [];
	var cur = null;
	var curBytes = 0;
	for (var i = 0; i < rows.length; i++) {
		var row = rows[i];
		var b = utf8Length(row);
		if (cur !== null && curBytes + 1 + b <= maxBytes) {
			cur += "\n" + row;
			curBytes += 1 + b;
		} else {
			if (cur !== null) chunks.push(cur);
			cur = row;
			curBytes = b;
		}
	}
	if (cur !== null) chunks.push(cur);
	return chunks;
}

function byCreated(requests) {
	return (requests || []).slice().sort(function (a, b) {
		return a.createdAt - b.createdAt;
	});
}

function findById(list, id) {
	if (id === null || id === undefined) return null;
	for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
	return null;
}

// The current request if still present, else the hub's showing if present, else the oldest.
function selectRequest(requests, currentId, hubShowing) {
	var sorted = byCreated(requests);
	return findById(sorted, currentId) || findById(sorted, hubShowing) || sorted[0] || null;
}

function newest(sessions, live) {
	var best = null;
	for (var i = 0; i < sessions.length; i++) {
		var s = sessions[i];
		if (!!s.live !== live) continue;
		if (!best || s.updatedAt > best.updatedAt) best = s;
	}
	return best;
}

// The last session if listed, else the most recently updated live one, else the most recently updated closed one.
function selectSession(sessions, lastSessionId) {
	sessions = sessions || [];
	return findById(sessions, lastSessionId) || newest(sessions, true) || newest(sessions, false);
}

function stateOf(session) {
	if (!session) return "idle";
	return session.live === false ? "closed" : str(session.state) || "idle";
}

var ELLIPSIS = "\u2026";
var OPTION_MIN = 12; // options are clipped no shorter than this before the request text gives way entirely
var REQ_TEXT_MIN = 40;

// At most n UTF-16 units, never ending inside a surrogate pair.
function cut(s, n) {
	s = s.slice(0, Math.max(0, n));
	var c = s.charCodeAt(s.length - 1);
	return c >= 0xd800 && c <= 0xdbff ? s.slice(0, -1) : s;
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

// Fits dict[key] (a "\n"-joined list of shown) and, when textKey is given, dict[textKey]
// into MSG_BYTES: the text trims to REQ_TEXT_MIN, then options clip to OPTION_MIN, then the
// text trims away, then trailing options drop. Returns the shown options (index i is option i).
function fitOptions(dict, key, shown, textKey) {
	var text = textKey ? dict[textKey] : "";
	var trimmed = false;
	function fits() {
		dict[key] = shown.join("\n");
		if (textKey) dict[textKey] = trimmed ? text + ELLIPSIS : text;
		return dictBytes(dict) <= MSG_BYTES;
	}
	function trimText(min) {
		while (!fits() && text.length > min) {
			text = cut(text, text.length - Math.max(1, Math.ceil((text.length - min) / 8)));
			trimmed = true;
		}
	}
	if (textKey) trimText(REQ_TEXT_MIN);
	while (!fits() && clipLongest(shown, OPTION_MIN)) {}
	if (textKey) trimText(0);
	while (!fits() && shown.length > 0) shown.pop();
	return shown;
}

// The home dict and the options it shows. With a request, TEXT is empty (Home shows
// the request, not the last reply), so the dict always fits the watch's inbox.
function fitHome(req, index, count, session, lastText) {
	var dict = {
		MSG: "home",
		REQ_ID: req ? str(req.id) : "",
		REQ_KIND: req ? str(req.kind) : "",
		REQ_TOOL: req ? clipTo(req.tool, NAME_MAX) : "",
		REQ_TEXT: req ? clip(req.message) : "",
		REQ_OPTIONS: "",
		REQ_INDEX: index,
		REQ_COUNT: count,
		SESSION_ID: req ? str(req.sessionId) : session ? str(session.id) : "",
		SESSION_TITLE: clipTo(req ? req.sessionTitle : session ? session.title : "", TITLE_MAX),
		STATE: session ? stateOf(session) : req && req.kind === "dialog" ? "needs_you" : "idle",
		TEXT: req ? "" : clip(lastText),
	};
	var shown = req ? fitOptions(dict, "REQ_OPTIONS", (req.options || []).map(clean), "REQ_TEXT") : [];
	return { dict: dict, shown: shown };
}

function packHome(req, index, count, session, lastText) {
	return fitHome(req, index, count, session, lastText).dict;
}

function packStats(session) {
	return {
		MSG: "stats",
		SESSION_ID: str(session.id),
		STATE: stateOf(session),
		MODEL: clipTo(session.model, NAME_MAX),
		CTX_PERCENT: num(session.contextPercent),
		CTX_TOKENS: num(session.contextTokens),
		CTX_WINDOW: num(session.contextWindow),
		TPS: num(session.tps),
	};
}

function sessionRow(s, now) {
	var ctx = typeof s.contextPercent === "number" ? String(Math.round(s.contextPercent)) : "-";
	var age = s.live === false ? ageLabel(now - s.updatedAt) : "-";
	return [clean(s.id), clipTo(clean(s.title), TITLE_MAX), stateOf(s), s.live === false ? "0" : "1", clipTo(clean(s.model), NAME_MAX), ctx, age].join("\t");
}

function darkValue(d) {
	return d === true || d === 1 || d === "1" || d === "true";
}

function createBridge(deps) {
	var hub = deps.hub;
	var storage = deps.storage;
	var log = deps.log || function () {};
	var frame = { requests: [], sessions: [], showing: null };
	var currentReq = null;
	var currentSession = null;
	var pin = null; // a session the watch chose with nothing selected, and the requests it saw then
	// The last reply per session. It is dropped when a session becomes current again,
	// unless a final text frame for it arrived while it was not current (fresh).
	var lastText = {};
	var fresh = {};
	var textFetching = {};
	var fetchFailed = {};
	var net = "connecting";
	// Per request id, the options last shown on the watch and the hub's options they stand for.
	var shownOptions = {};
	var dark = storage.getItem(DARK_KEY) !== "0";

	var queue = [];
	var inFlight = null;
	var lastQueued = {};
	var statsAt = null;
	var statsSession = null;
	var statsHeld = null;
	var statsTimer = null;

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
		var dict = queue.shift();
		transmit({ dict: dict, tries: 0 });
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

	// Options ----------------------------------------------------------------

	function remember(reqId, shown, full) {
		shownOptions[reqId] = { shown: shown.slice(), full: (full || []).slice() };
	}

	// The watch sends the option text it shows; the hub wants its own option string.
	function hubOption(reqId, option) {
		var m = shownOptions[reqId];
		if (m) {
			var i = m.shown.indexOf(option);
			if (i >= 0 && i < m.full.length) return str(m.full[i]);
		}
		var req = findById(frame.requests, reqId);
		var opts = (req && req.options) || [];
		for (var k = 0; k < opts.length; k++) if (clean(opts[k]) === option) return str(opts[k]);
		return option;
	}

	// Model ----------------------------------------------------------------

	function sessionById(id) {
		return findById(frame.sessions, id);
	}

	function sendStats(force) {
		var s = sessionById(currentSession);
		if (!s) return;
		var dict = packStats(s);
		if (!force && lastQueued.stats === JSON.stringify(dict)) {
			statsHeld = null;
			return;
		}
		var now = deps.now();
		// The limit is for speed ticks within one session; a session switch goes at once.
		if (force || statsAt === null || now - statsAt >= STATS_MS || s.id !== statsSession) {
			if (statsTimer !== null) {
				deps.clearTimeout(statsTimer);
				statsTimer = null;
			}
			statsHeld = null;
			statsAt = now;
			statsSession = s.id;
			enqueue(dict, force);
			return;
		}
		statsHeld = dict;
		if (statsTimer === null) {
			statsTimer = deps.setTimeout(function () {
				statsTimer = null;
				var held = statsHeld;
				statsHeld = null;
				if (!held || held.SESSION_ID !== currentSession) return;
				statsAt = deps.now();
				statsSession = held.SESSION_ID;
				enqueue(held);
			}, statsAt + STATS_MS - now);
		}
	}

	function sendHome(force) {
		var sorted = byCreated(frame.requests);
		var req = findById(sorted, currentReq);
		var index = 0;
		for (var i = 0; i < sorted.length; i++) if (req && sorted[i].id === req.id) index = i + 1;
		var session = sessionById(currentSession);
		if (!session && !req && currentSession) session = { id: currentSession, title: "", live: true, state: "idle" };
		var home = fitHome(req, index, sorted.length, session, lastText[currentSession] || "");
		if (req) remember(req.id, home.shown, req.options);
		enqueue(home.dict, force);
	}

	function ensureText(sid) {
		if (!sid || lastText[sid] !== undefined || textFetching[sid] || fetchFailed[sid]) return;
		textFetching[sid] = true;
		hub.get("/api/watch/history?session=" + encodeURIComponent(sid) + "&limit=4", function (err, json) {
			textFetching[sid] = false;
			if (err || !json) {
				// Not cached: the next switch to this session tries again.
				fetchFailed[sid] = true;
				log("pi-web: history for " + sid + " failed: " + (err && err.message));
				return;
			}
			if (lastText[sid] !== undefined) return;
			var text = "";
			var turns = json.turns || [];
			for (var i = turns.length - 1; i >= 0; i--) {
				if (turns[i].role === "agent") {
					text = str(turns[i].text);
					break;
				}
			}
			lastText[sid] = text;
			if (sid === currentSession) sendHome();
		});
	}

	function update(force) {
		var sorted = byCreated(frame.requests);
		var req = null;
		if (pin) {
			for (var i = 0; i < sorted.length; i++) {
				if (!pin.seen[sorted[i].id]) {
					pin = null;
					break;
				}
			}
		}
		if (!pin) req = selectRequest(sorted, currentReq, frame.showing);
		var sid;
		if (req) sid = req.sessionId;
		else if (pin) sid = pin.sessionId;
		else {
			var s = selectSession(frame.sessions, storage.getItem(LAST_SESSION));
			sid = s ? s.id : null;
		}
		var reqId = req ? req.id : null;
		if (reqId !== currentReq || sid !== currentSession) {
			currentReq = reqId;
			if (sid !== currentSession && sid) {
				if (fresh[sid]) delete fresh[sid];
				else delete lastText[sid];
				delete fetchFailed[sid];
			}
			currentSession = sid;
			if (sid) storage.setItem(LAST_SESSION, sid);
			if (sid || reqId) hub.showing(reqId, sid);
		}
		ensureText(currentSession);
		sendHome(force);
		sendStats(force);
	}

	function removeRequest(id) {
		frame.requests = (frame.requests || []).filter(function (r) {
			return r.id !== id;
		});
		if (frame.showing === id) frame.showing = null;
		delete shownOptions[id];
	}

	function sendAll() {
		enqueue({ MSG: "cfg", DARK: dark ? 1 : 0 }, true);
		enqueue({ MSG: "net", NET: net }, true);
		update(true);
	}

	// Commands -------------------------------------------------------------

	function result(cmdId, err, json, requestId) {
		var dict = { MSG: "result", CMD_ID: num(cmdId) };
		if (err) {
			dict.OK = 0;
			dict.REASON = "error";
			dict.OPTIONS = "";
		} else if (json && json.ok) {
			dict.OK = 1;
		} else {
			dict.OK = 0;
			dict.REASON = json && (json.reason === "gone" || json.reason === "no_match") ? json.reason : "error";
			var full = (json && json.options) || [];
			var shown = fitOptions(dict, "OPTIONS", full.map(clean), null);
			if (requestId && shown.length) remember(requestId, shown, full);
		}
		enqueue(dict);
	}

	// Posts a command; a request that is answered (ok) or gone leaves locally at once.
	function postCommand(path, body, cmdId, requestId) {
		hub.post(path, body, function (err, json) {
			result(cmdId, err, json, requestId);
			if (err) log("pi-web: " + path + " failed: " + err.message);
			if (!err && requestId && json && (json.ok || json.reason === "gone")) {
				removeRequest(requestId);
				update();
			}
		});
	}

	function sendList(list, sid, rows, firstOffset, offsetOf, total) {
		var base = { MSG: "list", LIST: list };
		if (sid !== null) base.SESSION_ID = sid;
		// The rows get what the other tuples of this message leave of MSG_BYTES.
		var chunks = packRows(rows, MSG_BYTES - dictBytes(dict("", 0, 0)));
		function dict(rowsStr, offset, more) {
			var d = {};
			for (var k in base) d[k] = base[k];
			d.ROWS = rowsStr;
			d.OFFSET = offset;
			d.TOTAL = total;
			d.MORE = more;
			return d;
		}
		if (chunks.length === 0) {
			enqueue(dict("", firstOffset, 0));
			return;
		}
		var at = 0;
		for (var i = 0; i < chunks.length; i++) {
			enqueue(dict(chunks[i], offsetOf(at), i < chunks.length - 1 ? 1 : 0));
			at += chunks[i].split("\n").length;
		}
	}

	function page(p) {
		var list = str(p.LIST);
		var sid = p.SESSION_ID ? str(p.SESSION_ID) : currentSession;
		if (list === "sessions") {
			var now = deps.now();
			var rows = (frame.sessions || []).map(function (s) {
				return sessionRow(s, now);
			});
			sendList("sessions", null, rows, 0, function (at) {
				return at;
			}, rows.length);
			return;
		}
		if (!sid) {
			sendList(list, "", [], 0, null, -1);
			return;
		}
		var q = "?session=" + encodeURIComponent(sid);
		if (list === "history") {
			var before = typeof p.OFFSET === "number" && p.OFFSET >= 0 ? "&before=" + p.OFFSET : "";
			hub.get("/api/watch/history" + q + before + "&limit=" + HISTORY_PAGE, function (err, json) {
				if (err || !json) {
					log("pi-web: history page failed: " + (err && err.message));
					sendList(list, sid, [], 0, null, -1);
					return;
				}
				var turns = json.turns || [];
				var rows = turns.map(function (t) {
					return [num(t.i), clean(t.role), clip(clean(t.text))].join("\t");
				});
				sendList(list, sid, rows, 0, function (at) {
					return num(turns[at].i);
				}, num(json.total));
			});
			return;
		}
		if (list === "models") {
			hub.get("/api/watch/models" + q, function (err, json) {
				if (err || !json) {
					log("pi-web: models page failed: " + (err && err.message));
					sendList(list, sid, [], 0, null, -1);
					return;
				}
				var cur = json.current;
				var models = json.models || [];
				var rows = models.map(function (m) {
					var isCur = cur && cur.provider === m.provider && cur.id === m.id ? "1" : "0";
					return [clean(m.provider), clean(m.id), clipTo(clean(m.name), NAME_MAX), isCur].join("\t");
				});
				sendList(list, sid, rows, 0, function (at) {
					return at;
				}, rows.length);
			});
			return;
		}
		log("pi-web: unknown list " + list);
	}

	function show(p) {
		if (p.REQ_ID && findById(frame.requests, p.REQ_ID)) {
			pin = null;
			currentReq = str(p.REQ_ID);
			update();
			return;
		}
		if (!p.SESSION_ID) return;
		var sid = str(p.SESSION_ID);
		var forSession = byCreated(frame.requests).filter(function (r) {
			return r.sessionId === sid;
		})[0];
		if (forSession) {
			pin = null;
			currentReq = forSession.id;
			update();
			return;
		}
		var seen = {};
		(frame.requests || []).forEach(function (r) {
			seen[r.id] = true;
		});
		pin = { sessionId: sid, seen: seen };
		update();
	}

	function onAppMessage(p) {
		p = p || {};
		var cmd = str(p.CMD);
		var sid = p.SESSION_ID ? str(p.SESSION_ID) : currentSession;
		if (cmd === "hello") {
			sendAll();
		} else if (cmd === "answer") {
			var body = { requestId: str(p.REQ_ID) };
			if (p.OPTION !== undefined && p.OPTION !== null && p.OPTION !== "") body.option = hubOption(body.requestId, str(p.OPTION));
			else body.text = str(p.TEXT);
			postCommand("/api/watch/answer", body, p.CMD_ID, body.requestId);
		} else if (cmd === "dismiss") {
			postCommand("/api/watch/dismiss", { requestId: str(p.REQ_ID) }, p.CMD_ID, str(p.REQ_ID));
		} else if (cmd === "prompt") {
			postCommand("/api/watch/prompt", { sessionId: sid, text: str(p.TEXT) }, p.CMD_ID, null);
		} else if (cmd === "model") {
			postCommand("/api/watch/model", { sessionId: sid, provider: str(p.PROVIDER), modelId: str(p.MODEL_ID) }, p.CMD_ID, null);
		} else if (cmd === "show") {
			show(p);
		} else if (cmd === "page") {
			page(p);
		} else {
			log("pi-web: unknown command " + cmd);
		}
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
			frame = { requests: f.requests || [], sessions: f.sessions || [], showing: f.showing === undefined ? null : f.showing };
			for (var id in shownOptions) if (!findById(frame.requests, id)) delete shownOptions[id];
			update();
		},
		onText: function (f) {
			if (!f || !f.sessionId) return;
			var streaming = f.streaming ? 1 : 0;
			if (f.sessionId !== currentSession) {
				// Never shown (Review Focus 5); a final reply is kept for when the session is current again.
				if (!streaming) {
					lastText[f.sessionId] = str(f.text);
					fresh[f.sessionId] = true;
				}
				return;
			}
			if (!streaming) lastText[f.sessionId] = str(f.text);
			enqueue({ MSG: "text", SESSION_ID: str(f.sessionId), TEXT: clip(f.text), STREAMING: streaming });
		},
		onStatus: function (s) {
			if (!NETS[s]) return;
			net = s;
			enqueue({ MSG: "net", NET: s });
			if (s === "online" && (currentReq || currentSession)) hub.showing(currentReq, currentSession);
		},
		onAppMessage: onAppMessage,
		onSettings: function (s) {
			if (!s) return;
			if (s.DARK !== undefined && s.DARK !== null) dark = darkValue(s.DARK);
			enqueue({ MSG: "cfg", DARK: dark ? 1 : 0 });
		},
		current: function () {
			return { requestId: currentReq, sessionId: currentSession };
		},
	};
}

module.exports = {
	createBridge: createBridge,
	selectRequest: selectRequest,
	selectSession: selectSession,
	packRows: packRows,
	packHome: packHome,
	packStats: packStats,
	clean: clean,
	ageLabel: ageLabel,
	dictBytes: dictBytes,
};
