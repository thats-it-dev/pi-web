// Wiring only: Pebble events, the hub client, the face model and Clay.
var createHubClient = require("../../../shared/pkjs/hub").createHubClient;
var normalizeHubUrl = require("../../../shared/pkjs/hub").normalizeHubUrl;
var createFace = require("./face").createFace;
var DEV_CONNECTION_PORT = require("./launch").DEV_CONNECTION_PORT;
var createWeather = require("./weather").createWeather;
var Clay = require("@rebble/clay");
var clay = new Clay(require("./config"), null, { autoHandleEvents: false });

// PebbleKit JS localStorage is per app on a phone: the face keeps its own hub URL
// under the same key name as the app, so it is entered in both settings pages.
var URL_KEY = "pi-web.hubUrl";
// The watch's pebble/message keeps one unread dict (see watch/README.md, Pacing):
// the next send waits this long after an ack.
var ACK_GAP_MS = 100;

var client = null;
var url = null;
var announced = false;
// The flick's loopback port: the phone's Developer Connection; in the emulator the
// phone simulator's port from the stub's /dev/settings (0 until then, or with
// --no-launch-port: no loopback, straight to the hub).
var launchPort = DEV_CONNECTION_PORT;

function log(m) {
	console.log(m);
}

function send(dict, onAck, onFail) {
	log("pi-web: send " + dict.MSG);
	Pebble.sendAppMessage(
		dict,
		function () {
			setTimeout(onAck, ACK_GAP_MS);
		},
		function (e) {
			log("pi-web: send " + dict.MSG + " failed" + (e && e.error ? ": " + JSON.stringify(e.error) : ""));
			onFail(e);
		}
	);
}

var face = createFace({
	send: send,
	storage: localStorage,
	setTimeout: function (fn, ms) {
		return setTimeout(fn, ms);
	},
	clearTimeout: function (id) {
		clearTimeout(id);
	},
	now: function () {
		return Date.now();
	},
	log: log,
	WebSocket: typeof WebSocket === "function" ? WebSocket : null,
	launchPort: function () {
		return launchPort;
	},
});

var weather = createWeather({
	hub: {
		get: function (path, cb) {
			if (client) client.get(path, cb);
			else cb(new Error("no hub URL"));
		},
	},
	geolocation: typeof navigator !== "undefined" ? navigator.geolocation : null,
	setTimeout: function (fn, ms) {
		return setTimeout(fn, ms);
	},
	clearTimeout: function (id) {
		clearTimeout(id);
	},
	now: function () {
		return Date.now();
	},
	log: log,
	onTemp: face.onWeather,
});

function onStatus(s) {
	if (s === "online" && !announced && client) {
		announced = true;
		log("pi-web: " + client.transport() + " online");
	}
	face.onStatus(s);
}

// A closed hub client stays closed, so the face's connect() after idling opens a new one.
function open() {
	if (client) client.close();
	announced = false;
	client = createHubClient({
		url: url,
		WebSocket: typeof WebSocket === "function" ? WebSocket : null,
		XMLHttpRequest: XMLHttpRequest,
		setTimeout: function (fn, ms) {
			return setTimeout(fn, ms);
		},
		clearTimeout: function (id) {
			clearTimeout(id);
		},
		onPending: face.onPending,
		onText: function () {},
		onStatus: onStatus,
		log: log,
	});
	client.connect();
}

var hub = {
	connect: function () {
		if (url) open();
	},
	close: function () {
		if (client) client.close();
	},
	showing: function (requestId, sessionId) {
		if (client) client.showing(requestId, sessionId);
	},
	get: function (path, cb) {
		if (client) client.get(path, cb);
		else cb(new Error("no hub URL"));
	},
	post: function (path, body, cb) {
		if (client) client.post(path, body, cb);
		else cb(new Error("no hub URL"));
	},
};

function connect(newUrl) {
	if (client) client.close();
	client = null;
	url = normalizeHubUrl(newUrl);
	face.setHub(hub);
	if (!url) {
		if (newUrl) log("pi-web: hub URL ignored (needs http:// or https://): " + newUrl);
		face.onStatus("unconfigured");
		return;
	}
	open();
}

Pebble.addEventListener("ready", function () {
	var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
	var qemu = !!(info && /^qemu/.test(info.model || ""));
	var stored = localStorage.getItem(URL_KEY);
	log("pi-web: face ready" + (qemu ? " (emulator)" : ""));
	if (qemu) launchPort = 0;
	face.start();
	connect(stored || (qemu ? "http://127.0.0.1:5173" : null));
	weather.start(localStorage.getItem("pi-web.unit") === "F" ? "F" : "C");
	if (qemu && client) {
		// The stub hub serves the theme and corners here, so screenshots can switch them.
		client.get("/dev/settings", function (err, json) {
			if (!err && json) {
				launchPort = typeof json.LAUNCH_PORT === "number" ? json.LAUNCH_PORT : 0;
				face.onSettings(json);
				weather.setUnit(json.UNIT);
			}
		});
	}
});

Pebble.addEventListener("appmessage", function (e) {
	face.onAppMessage(e.payload);
});

Pebble.addEventListener("showConfiguration", function () {
	Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener("webviewclosed", function (e) {
	if (!e || !e.response) return;
	// Unconverted: keys stay names and values stay strings/booleans.
	var raw;
	try {
		raw = clay.getSettings(e.response, false);
	} catch (err) {
		// A cancelled or malformed response: keep the current settings.
		log("pi-web: settings ignored: " + err.message);
		return;
	}
	var s = {};
	for (var k in raw) s[k] = raw[k] && typeof raw[k] === "object" ? raw[k].value : raw[k];
	s.HUB_URL = typeof s.HUB_URL === "string" ? s.HUB_URL.replace(/^\s+|\s+$/g, "") : "";
	s.DARK = !!s.DARK;
	face.onSettings(s);
	weather.setUnit(s.UNIT);
	if (normalizeHubUrl(s.HUB_URL) !== url) {
		connect(s.HUB_URL);
		// The hub changed: ask again now rather than at the next 20-minute tick.
		weather.start(s.UNIT);
	}
});
