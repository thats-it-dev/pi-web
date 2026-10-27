// Phone-side client for the pi-web watch hub: a WebSocket stream with a
// long-poll fallback. ES5 only; all dependencies are injected.

var MIN_DELAY = 1000;
var MAX_DELAY = 30000;
var POLL_TIMEOUT = 35000;
var POST_TIMEOUT = 15000;

// An http(s) URL with a lower-case scheme and no trailing slash, or null for anything else.
function normalizeHubUrl(s) {
	s = s === null || s === undefined ? "" : String(s).replace(/^\s+|\s+$/g, "");
	var m = /^(https?):\/\/(.+)$/i.exec(s);
	if (!m) return null;
	var rest = m[2].replace(/\/+$/, "");
	if (!rest || rest.charAt(0) === "/") return null;
	return m[1].toLowerCase() + "://" + rest;
}

function socketUrl(base) {
	return base.replace(/^http/, "ws") + "/api/watch/stream";
}

function createHubClient(opts) {
	var base = opts.url;
	var WS = opts.WebSocket;
	var Xhr = opts.XMLHttpRequest;
	var delay = MIN_DELAY;
	var closed = false;
	var started = false;
	var mode = null;
	var socket = null;
	var socketOpen = false;
	var timer = null;
	var pollXhr = null;
	var cursor = 0;
	var lastStatus = null;

	function log(m) {
		if (opts.log) opts.log(m);
	}

	// A callback that throws must not end the poll loop or the socket handler.
	function deliver(fn, arg, what) {
		if (!fn) return;
		try {
			fn(arg);
		} catch (err) {
			log("pi-web: " + what + " handler failed: " + (err && err.message));
		}
	}

	function status(s) {
		if (s === lastStatus) return;
		lastStatus = s;
		if (opts.onStatus) opts.onStatus(s);
	}

	function bumpDelay() {
		var d = delay;
		delay = Math.min(delay * 2, MAX_DELAY);
		return d;
	}

	function request(method, path, body, timeout, cb) {
		var x = new Xhr();
		var done = false;
		function finish(err, json) {
			if (done) return;
			done = true;
			cb(err, json);
		}
		x.open(method, base + path);
		if (body !== null) x.setRequestHeader("Content-Type", "application/json");
		x.timeout = timeout;
		x.onload = function () {
			var json;
			if (x.status < 200 || x.status >= 300) {
				var e = new Error("hub answered " + x.status);
				e.status = x.status;
				finish(e);
				return;
			}
			try {
				json = JSON.parse(x.responseText);
			} catch (err) {
				finish(err);
				return;
			}
			finish(null, json);
		};
		x.onerror = function () {
			finish(new Error("network error"));
		};
		x.ontimeout = function () {
			finish(new Error("timeout"));
		};
		x.send(body === null ? undefined : body);
		return x;
	}

	function schedule(fn) {
		timer = opts.setTimeout(function () {
			timer = null;
			if (!closed) fn();
		}, bumpDelay());
	}

	function openSocket() {
		var s;
		try {
			s = new WS(socketUrl(base));
		} catch (err) {
			log("pi-web: socket failed: " + (err && err.message));
			socket = null;
			socketOpen = false;
			status("offline");
			schedule(openSocket);
			return;
		}
		socket = s;
		socketOpen = false;
		s.onopen = function () {
			if (closed || s !== socket) return;
			socketOpen = true;
			delay = MIN_DELAY;
			status("online");
		};
		s.onmessage = function (ev) {
			var frame;
			if (closed || s !== socket) return;
			try {
				frame = JSON.parse(ev.data);
			} catch (err) {
				return;
			}
			if (!frame) return;
			if (frame.type === "pending") {
				delete frame.type;
				deliver(opts.onPending, frame, "pending");
			} else if (frame.type === "text") {
				deliver(opts.onText, { sessionId: frame.sessionId, text: frame.text, streaming: frame.streaming }, "text");
			} else if (frame.type === "notice") {
				deliver(opts.onNotice, { text: frame.text }, "notice");
			}
		};
		s.onerror = function () {};
		s.onclose = function () {
			if (closed || s !== socket) return;
			socket = null;
			socketOpen = false;
			status("offline");
			schedule(openSocket);
		};
	}

	function poll() {
		pollXhr = request("GET", "/api/watch/pending?since=" + cursor + "&wait=1", null, POLL_TIMEOUT, function (err, json) {
			pollXhr = null;
			if (closed) return;
			if (err) {
				status("offline");
				schedule(poll);
				return;
			}
			delay = MIN_DELAY;
			status("online");
			if (json && typeof json.cursor === "number") cursor = json.cursor;
			deliver(opts.onPending, json, "pending");
			if (!closed) poll();
		});
	}

	return {
		connect: function () {
			if (started || closed) return;
			started = true;
			status("connecting");
			if (WS) {
				mode = "ws";
				openSocket();
			} else {
				mode = "poll";
				poll();
			}
		},
		close: function () {
			closed = true;
			if (timer !== null) {
				opts.clearTimeout(timer);
				timer = null;
			}
			if (pollXhr && pollXhr.abort) pollXhr.abort();
			if (socket) {
				try {
					socket.close();
				} catch (err) {}
			}
			socketOpen = false;
			status("offline");
		},
		showing: function (queryId, sessionId) {
			var body = JSON.stringify({ type: "showing", queryId: queryId, sessionId: sessionId });
			if (socket && socketOpen) {
				socket.send(body);
			} else {
				request("POST", "/api/watch/showing", body, POST_TIMEOUT, function () {});
			}
		},
		get: function (path, cb) {
			request("GET", path, null, POST_TIMEOUT, cb);
		},
		post: function (path, body, cb) {
			request("POST", path, JSON.stringify(body), POST_TIMEOUT, cb);
		},
		transport: function () {
			return mode;
		},
	};
}

module.exports = { createHubClient: createHubClient, socketUrl: socketUrl, normalizeHubUrl: normalizeHubUrl };
