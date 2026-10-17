// Wiring only: Pebble events, the hub client, the bridge and Clay.
var createHubClient = require("./hub").createHubClient;
var normalizeHubUrl = require("./hub").normalizeHubUrl;
var createBridge = require("./bridge").createBridge;
var Clay = require("@rebble/clay");
var clay = new Clay(require("./config"), null, { autoHandleEvents: false });

var URL_KEY = "pi-web.hubUrl";
var DARK_KEY = "pi-web.dark";
var QUIET = { stats: true, text: true };
// The watch's pebble/message keeps one unread dict: a dict that lands before the
// JS has read the previous one overwrites it (pebble-appmessage.c messageReceived,
// "overwrites unread message"), and the firmware acks on receipt. So the next
// send waits this long after an ack, to give the watch time to read.
var ACK_GAP_MS = 100;

var client = null;
var url = null;
var qemu = false;
var announced = false;

function log(m) {
	console.log(m);
}

function send(dict, onAck, onFail) {
	if (!QUIET[dict.MSG]) log("pi-web: send " + dict.MSG);
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

var bridge = createBridge({
	hub: null,
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
});

function noHub() {
	return {
		showing: function () {},
		get: function (path, cb) {
			cb(new Error("no hub URL"));
		},
		post: function (path, body, cb) {
			cb(new Error("no hub URL"));
		},
	};
}

function onStatus(s) {
	if (s === "online" && !announced && client) {
		announced = true;
		log("pi-web: " + client.transport() + " online");
	}
	bridge.onStatus(s);
}

function connect(newUrl) {
	if (client) client.close();
	client = null;
	url = normalizeHubUrl(newUrl);
	announced = false;
	if (!url) {
		if (newUrl) log("pi-web: hub URL ignored (needs http:// or https://): " + newUrl);
		bridge.setHub(noHub());
		bridge.onStatus("unconfigured");
		return;
	}
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
		onPending: bridge.onPending,
		onText: bridge.onText,
		onStatus: onStatus,
		log: log,
	});
	bridge.setHub(client);
	client.connect();
}

Pebble.addEventListener("ready", function () {
	var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
	qemu = !!(info && /^qemu/.test(info.model || ""));
	var stored = localStorage.getItem(URL_KEY);
	log("pi-web: ready" + (qemu ? " (emulator)" : ""));
	bridge.start();
	connect(stored || (qemu ? "http://127.0.0.1:5173" : null));
	if (qemu && client) {
		// The stub hub serves its theme here, so screenshots can switch dark/light.
		client.get("/dev/settings", function (err, json) {
			if (!err && json) bridge.onSettings(json);
		});
	}
});

Pebble.addEventListener("appmessage", function (e) {
	bridge.onAppMessage(e.payload);
});

Pebble.addEventListener("showConfiguration", function () {
	Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener("webviewclosed", function (e) {
	if (!e || !e.response) return;
	// Unconverted: keys stay names and values stay strings/booleans (converted keys are numeric message keys).
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
	var newUrl = typeof s.HUB_URL === "string" ? s.HUB_URL.replace(/^\s+|\s+$/g, "") : "";
	localStorage.setItem(URL_KEY, newUrl);
	localStorage.setItem(DARK_KEY, s.DARK ? "1" : "0");
	bridge.onSettings({ HUB_URL: newUrl, DARK: !!s.DARK });
	if (normalizeHubUrl(newUrl) !== url) connect(newUrl);
});
