// Launching the watchapp from the face (spec §8). Path 1: the phone's own
// Developer Connection on ws://127.0.0.1:9000/, one binary frame that the phone
// relays to the watch. Path 2: POST /api/watch/launch, and the hub sends the
// same frame to the phone's Developer Connection over the tailnet. ES5 only.

var APP_UUID = "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b";
var DEV_CONNECTION_PORT = 9000;
var LAUNCH_TIMEOUT_MS = 2500;

// RelayToWatch (0x01), length 17 and endpoint 0x0034 (AppRunState), both
// big-endian, then START (0x01) and the uuid's 16 bytes: the hub's launchFrame.
function launchFrame(uuid) {
	var hex = String(uuid).replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("A valid uuid is required");
	var f = new Uint8Array(22);
	f[0] = 0x01;
	f[1] = 0x00;
	f[2] = 0x11;
	f[3] = 0x00;
	f[4] = 0x34;
	f[5] = 0x01;
	for (var i = 0; i < 16; i++) f[6 + i] = parseInt(hex.substr(2 * i, 2), 16);
	return f;
}

// opts: { WebSocket, port, timeoutMs, setTimeout, clearTimeout }. cb(ok) once:
// true when the socket opened and the frame went out.
function launchViaLoopback(opts, uuid, cb) {
	var WS = opts.WebSocket;
	var done = false;
	var timer = null;
	var socket = null;
	function settle(ok) {
		if (done) return;
		done = true;
		if (timer !== null) opts.clearTimeout(timer);
		timer = null;
		if (socket) {
			try {
				socket.close();
			} catch (e) {}
		}
		cb(ok);
	}
	if (typeof WS !== "function" || !opts.port) {
		cb(false);
		return;
	}
	var frame = launchFrame(uuid);
	try {
		socket = new WS("ws://127.0.0.1:" + opts.port + "/");
	} catch (e) {
		socket = null;
		settle(false);
		return;
	}
	if ("binaryType" in socket) socket.binaryType = "arraybuffer";
	timer = opts.setTimeout(function () {
		timer = null;
		settle(false);
	}, opts.timeoutMs || LAUNCH_TIMEOUT_MS);
	socket.onopen = function () {
		if (done) return;
		try {
			socket.send(frame.buffer);
		} catch (e) {
			settle(false);
			return;
		}
		settle(true);
	};
	socket.onerror = function () {
		settle(false);
	};
	socket.onclose = function () {
		settle(false);
	};
}

// cb(ok): ok when the hub answered { ok: true }.
function launchViaHub(hub, uuid, cb) {
	if (!hub) {
		cb(false);
		return;
	}
	hub.post("/api/watch/launch", { uuid: uuid }, function (err, json) {
		cb(!err && !!json && json.ok === true);
	});
}

// opts: launchViaLoopback's plus { hub }. cb(ok, path), path "loopback" | "hub" | "none".
function launch(opts, uuid, cb) {
	launchViaLoopback(opts, uuid, function (ok) {
		if (ok) return cb(true, "loopback");
		launchViaHub(opts.hub, uuid, function (ok2) {
			cb(ok2, ok2 ? "hub" : "none");
		});
	});
}

module.exports = {
	APP_UUID: APP_UUID,
	DEV_CONNECTION_PORT: DEV_CONNECTION_PORT,
	LAUNCH_TIMEOUT_MS: LAUNCH_TIMEOUT_MS,
	launchFrame: launchFrame,
	launchViaLoopback: launchViaLoopback,
	launchViaHub: launchViaHub,
	launch: launch,
};
