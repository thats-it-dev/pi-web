// The face's phone-side model: turns hub frames into AppMessage dicts for the
// watchface (the sheet, the pi corner, weather, settings) and idles the socket
// when nothing happens. ES5 only; all dependencies are injected.
var launcher = require("./launch");

var TEXT_MAX = 240;
var NAME_MAX = 40;
var RETRY_MS = 500;
var IDLE_MS = 10 * 60 * 1000;
var POLL_MS = 60 * 1000;
// A sheet unchanged this long is sent again with the next frame: the watch acks a
// dict even when its one unread slot was overwritten, so a lost sheet is otherwise
// durable. The watch ignores a sheet identical to the one it shows.
var RESEND_MS = 5 * 60 * 1000;
var CORNERS_KEY = "pi-web.face.corners";
var DARK_KEY = "pi-web.dark";
var URL_KEY = "pi-web.hubUrl";
var UNIT_KEY = "pi-web.unit";
var CORNER_KEYS = ["CORNER_TL", "CORNER_TR", "CORNER_BL", "CORNER_BR"];
var DEFAULT_CORNERS = ["date", "pi", "hr", "steps"];
var WIDGETS = { date: true, pi: true, hr: true, steps: true, battery: true, weather: true, none: true };
var NETS = { connecting: true, online: true, offline: true, unconfigured: true };

function str(s) {
	return s === null || s === undefined ? "" : String(s);
}

function clipTo(s, n) {
	s = str(s);
	return s.length > n ? s.slice(0, n) : s;
}

function byAge(a, b) {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sorted(requests) {
	return (requests || []).slice().sort(byAge);
}

// The request the sheet shows: the one it shows if still pending (the sheet
// never rotates), else the oldest (smallest createdAt, ties by id); null when none.
function selectSheet(requests, currentId) {
	var list = sorted(requests);
	for (var i = 0; i < list.length; i++) if (currentId !== null && currentId !== undefined && list[i].id === currentId) return list[i];
	return list[0] || null;
}

function piCounts(frame) {
	var running = 0;
	var sessions = (frame && frame.sessions) || [];
	for (var i = 0; i < sessions.length; i++) if (sessions[i].live !== false && sessions[i].state === "running") running++;
	return { running: running, pending: ((frame && frame.requests) || []).length };
}

// Spec §6.2: the watch vibes when the list goes from empty to non-empty or a
// request appears while others are pending, i.e. when an id is new since the
// previous frame. A switch to the next oldest, a count change or a replayed
// list (reconnect, poll) has no new id. The first frame after launch has no
// previous one and does not vibe.
function arrived(before, now) {
	var seen = {};
	var i;
	for (i = 0; i < before.length; i++) seen[before[i].id] = true;
	for (i = 0; i < now.length; i++) if (!seen[now[i].id]) return true;
	return false;
}

function noVibe(key, value) {
	return key === "VIBE" ? undefined : value;
}

function content(dict) {
	return JSON.stringify(dict, noVibe);
}

function darkValue(d) {
	return d === true || d === 1 || d === "1" || d === "true";
}

function storedCorners(storage) {
	var c = null;
	try {
		c = JSON.parse(storage.getItem(CORNERS_KEY));
	} catch (e) {}
	var out = DEFAULT_CORNERS.slice();
	for (var i = 0; i < 4; i++) if (c && WIDGETS[c[i]]) out[i] = c[i];
	return out;
}

function createFace(deps) {
	var storage = deps.storage;
	var log = deps.log || function () {};
	var hub = null;
	var frame = null;
	var shownId = null;
	// Report showing on the next frame even if shownId did not change: after a
	// start, a new hub or a (re)opened socket the hub may still hold the app's.
	var report = true;
	var sheetAt = deps.now();
	var net = "connecting";
	var temp = null;
	var idle = false;
	var idleTimer = null;
	var pollTimer = null;
	var corners = storedCorners(storage);
	var dark = storage.getItem(DARK_KEY) !== "0";
	var unit = storage.getItem(UNIT_KEY) === "F" ? "F" : "C";

	// Outbox: one dict in flight; every kind but result coalesces to the latest.
	// VIBE is not content: a sheet that differs only by it is the same sheet, a
	// sheet with VIBE 1 always goes out, and a queued vibe survives being replaced.
	var queue = [];
	var inFlight = null;
	var lastQueued = {};

	function enqueue(dict, force) {
		var msg = dict.MSG;
		if (msg !== "result") {
			var json = content(dict);
			if (!force && !dict.VIBE && lastQueued[msg] === json) return;
			lastQueued[msg] = json;
			for (var i = 0; i < queue.length; i++) {
				if (queue[i].MSG === msg) {
					if (queue[i].VIBE) dict.VIBE = 1;
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
				if (item.tries < 2 && !(msg !== "result" && queued(msg))) {
					deps.setTimeout(function () {
						transmit(item);
					}, RETRY_MS);
					return;
				}
				log("pi-web: drop " + msg + " after " + item.tries + " tries");
				// A vibe that never arrived rides on the newer sheet queued behind it.
				if (item.dict.VIBE) for (var i = 0; i < queue.length; i++) if (queue[i].MSG === msg) queue[i].VIBE = 1;
				if (lastQueued[msg] === content(item.dict)) delete lastQueued[msg];
				inFlight = null;
				pump();
			}
		);
	}

	// Dicts -----------------------------------------------------------------

	function cfgDict() {
		var d = { MSG: "cfg", DARK: dark ? 1 : 0 };
		for (var i = 0; i < 4; i++) d[CORNER_KEYS[i]] = corners[i];
		d.UNIT = unit;
		return d;
	}

	function piDict() {
		var c = frame ? piCounts(frame) : { running: -1, pending: -1 };
		return { MSG: "pi", PI_RUNNING: c.running, PI_PENDING: c.pending };
	}

	function sheetDict(vibe) {
		var list = sorted(frame && frame.requests);
		var r = null;
		var index = 0;
		for (var i = 0; i < list.length; i++) {
			if (list[i].id === shownId) {
				r = list[i];
				index = i + 1;
			}
		}
		return {
			MSG: "sheet",
			REQ_ID: r ? str(r.id) : "",
			REQ_KIND: r ? str(r.kind) : "",
			REQ_TOOL: r ? clipTo(r.tool, NAME_MAX) : "",
			REQ_TEXT: r ? clipTo(r.message, TEXT_MAX) : "",
			REQ_INDEX: index,
			REQ_COUNT: r ? list.length : 0,
			VIBE: vibe ? 1 : 0,
		};
	}

	function sendAll() {
		enqueue(cfgDict(), true);
		enqueue({ MSG: "net", NET: net }, true);
		enqueue(piDict(), true);
		enqueue(sheetDict(), true);
		if (temp !== null) enqueue({ MSG: "weather", TEMP: temp }, true);
	}

	// Idle policy -------------------------------------------------------------

	function quiet(f) {
		var c = piCounts(f);
		return c.pending === 0 && c.running === 0;
	}

	function goIdle() {
		idleTimer = null;
		idle = true;
		log("pi-web: idle, polling once a minute");
		if (hub) hub.close();
		net = "idle";
		enqueue({ MSG: "net", NET: net });
		schedulePoll();
	}

	function schedulePoll() {
		pollTimer = deps.setTimeout(function () {
			pollTimer = null;
			if (!idle || !hub) return;
			hub.get("/api/watch/pending", function (err, json) {
				if (!idle) return;
				if (err || !json || quiet(json)) {
					// The OFF cue: a failed poll shows offline, a quiet one idle again.
					net = err || !json ? "offline" : "idle";
					enqueue({ MSG: "net", NET: net });
					schedulePoll();
					return;
				}
				idle = false;
				log("pi-web: activity, reopening the socket");
				hub.connect();
				try {
					onPending(json);
				} catch (e) {
					log("pi-web: poll handler failed: " + (e && e.message));
				}
			});
		}, POLL_MS);
	}

	function wake() {
		if (idleTimer !== null) deps.clearTimeout(idleTimer);
		if (pollTimer !== null) deps.clearTimeout(pollTimer);
		idleTimer = pollTimer = null;
		idle = false;
	}

	// Frames ------------------------------------------------------------------

	function onPending(f) {
		if (!f || idle) return;
		var previous = frame;
		frame = { requests: f.requests || [], sessions: f.sessions || [] };
		var vibe = previous !== null && arrived(previous.requests, frame.requests);
		var r = selectSheet(frame.requests, shownId);
		var id = r ? r.id : null;
		if (id !== shownId || report) {
			shownId = id;
			report = false;
			if (hub) hub.showing(id, null);
		}
		// enqueue drops a sheet or pi identical to the last one queued: only changes go out.
		var sheet = sheetDict(vibe);
		var stale = deps.now() - sheetAt >= RESEND_MS;
		if (stale || content(sheet) !== lastQueued.sheet) sheetAt = deps.now();
		enqueue(sheet, stale);
		enqueue(piDict());
		if (!quiet(frame)) {
			if (idleTimer !== null) deps.clearTimeout(idleTimer);
			idleTimer = null;
		} else if (idleTimer === null) {
			idleTimer = deps.setTimeout(goIdle, IDLE_MS);
		}
	}

	// Flick (spec §8): the Developer Connection on the phone, then the hub; the
	// watch hears back in a result dict for its command.
	function launchApp(cmdId) {
		var port = deps.launchPort ? deps.launchPort() : launcher.DEV_CONNECTION_PORT;
		launcher.launch(
			{ WebSocket: deps.WebSocket || null, port: port, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, hub: hub },
			launcher.APP_UUID,
			function (ok, path) {
				log(ok ? "pi-web: launch via " + path : "pi-web: launch failed");
				enqueue({ MSG: "result", CMD_ID: typeof cmdId === "number" ? cmdId : Number(cmdId) || 0, OK: ok ? 1 : 0 });
			}
		);
	}

	return {
		// The launch burst. The watch's pebble/message can write only after it has
		// received a dict (pebble-appmessage.c: pkjsReady is set in messageReceived),
		// so the phone speaks first; the watch's hello then asks for it again.
		start: function () {
			report = true;
			sendAll();
		},
		setHub: function (h) {
			wake();
			hub = h;
			report = true;
		},
		onPending: onPending,
		onStatus: function (s) {
			if (idle || !NETS[s]) return;
			if (s === "online") report = true;
			net = s;
			enqueue({ MSG: "net", NET: s });
		},
		onAppMessage: function (p) {
			var cmd = str(p && p.CMD);
			if (cmd === "hello") {
				sendAll();
			} else if (cmd === "launch") {
				launchApp(p.CMD_ID);
			} else {
				log("pi-web: unknown command " + cmd);
			}
		},
		onSettings: function (s) {
			if (!s) return;
			for (var i = 0; i < 4; i++) if (WIDGETS[s[CORNER_KEYS[i]]]) corners[i] = s[CORNER_KEYS[i]];
			if (s.DARK !== undefined && s.DARK !== null) dark = darkValue(s.DARK);
			if (s.UNIT === "C" || s.UNIT === "F") unit = s.UNIT;
			storage.setItem(CORNERS_KEY, JSON.stringify(corners));
			storage.setItem(DARK_KEY, dark ? "1" : "0");
			storage.setItem(UNIT_KEY, unit);
			if (typeof s.HUB_URL === "string") storage.setItem(URL_KEY, s.HUB_URL);
			enqueue(cfgDict());
		},
		onWeather: function (t) {
			temp = str(t);
			enqueue({ MSG: "weather", TEMP: temp });
		},
		shown: function () {
			return shownId;
		},
	};
}

module.exports = { createFace: createFace, selectSheet: selectSheet, piCounts: piCounts };
