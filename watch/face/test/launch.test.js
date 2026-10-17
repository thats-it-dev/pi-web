const test = require("node:test");
const assert = require("node:assert/strict");
const { launchFrame, launchViaLoopback, launchViaHub, launch, APP_UUID, DEV_CONNECTION_PORT, LAUNCH_TIMEOUT_MS } = require("../src/pkjs/launch.js");
const { FakeSocket, FakeTimers } = require("../../app/test/support/fakes.js");

function hex(bytes) {
	return Array.prototype.map.call(new Uint8Array(bytes), (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

function FakeHub(answer) {
	this.posts = [];
	this.answer = answer;
}
FakeHub.prototype.post = function (path, body, cb) {
	this.posts.push({ path, body });
	if (this.answer) this.answer(cb);
	else this.cb = cb;
};

function opts(timers, extra) {
	return Object.assign({ WebSocket: FakeSocket, port: DEV_CONNECTION_PORT, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }, extra || {});
}

test("the constants", () => {
	assert.equal(APP_UUID, "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b");
	assert.equal(DEV_CONNECTION_PORT, 9000);
	assert.equal(LAUNCH_TIMEOUT_MS, 2500);
});

test("launchFrame bytes match the hub's", () => {
	const f = launchFrame(APP_UUID);
	assert.ok(f instanceof Uint8Array);
	assert.equal(f.length, 22);
	assert.equal(hex(f), "0100110034016d55f4ea2ff6419ea2be1ebdfd4f8f0b");
});

test("loopback: opens ws://127.0.0.1:9000/, sends the frame once on open, closes, cb(true)", () => {
	FakeSocket.reset();
	const timers = new FakeTimers();
	const results = [];
	launchViaLoopback(opts(timers), APP_UUID, (ok) => results.push(ok));
	assert.equal(FakeSocket.instances.length, 1);
	const s = FakeSocket.instances[0];
	assert.equal(s.url, "ws://127.0.0.1:9000/");
	assert.deepEqual(s.sent, []);
	assert.deepEqual(timers.pending(), [LAUNCH_TIMEOUT_MS]);
	s.onopen();
	assert.equal(s.sent.length, 1);
	assert.ok(s.sent[0] instanceof ArrayBuffer);
	assert.equal(hex(s.sent[0]), "0100110034016d55f4ea2ff6419ea2be1ebdfd4f8f0b");
	assert.equal(s.closed, true);
	assert.deepEqual(results, [true]);
	assert.deepEqual(timers.pending(), []);
	// The close that follows does not report again.
	if (s.onclose) s.onclose();
	assert.deepEqual(results, [true]);
});

test("loopback: the port comes from opts (the emulator's LAUNCH_PORT); binaryType is set when the socket has one", () => {
	FakeSocket.reset();
	const timers = new FakeTimers();
	function Typed(url) {
		FakeSocket.call(this, url);
		this.binaryType = "blob";
	}
	Typed.prototype = Object.create(FakeSocket.prototype);
	launchViaLoopback(opts(timers, { WebSocket: Typed, port: 45678 }), APP_UUID, () => {});
	assert.equal(FakeSocket.instances[0].url, "ws://127.0.0.1:45678/");
	assert.equal(FakeSocket.instances[0].binaryType, "arraybuffer");
});

test("loopback: error before open → cb(false); no WebSocket in the runtime → cb(false) at once", () => {
	FakeSocket.reset();
	const timers = new FakeTimers();
	const results = [];
	launchViaLoopback(opts(timers), APP_UUID, (ok) => results.push(ok));
	const s = FakeSocket.instances[0];
	s.onerror();
	if (s.onclose) s.onclose();
	assert.deepEqual(results, [false]);
	assert.deepEqual(s.sent, []);
	assert.deepEqual(timers.pending(), []);

	const none = [];
	launchViaLoopback(opts(timers, { WebSocket: null }), APP_UUID, (ok) => none.push(ok));
	assert.deepEqual(none, [false]);

	const throwing = [];
	launchViaLoopback(opts(timers, { WebSocket: function () { throw new Error("refused"); } }), APP_UUID, (ok) => throwing.push(ok));
	assert.deepEqual(throwing, [false]);
	assert.deepEqual(timers.pending(), []);
});

test("loopback: no open within LAUNCH_TIMEOUT_MS → cb(false) and the socket is closed", () => {
	FakeSocket.reset();
	const timers = new FakeTimers();
	const results = [];
	launchViaLoopback(opts(timers), APP_UUID, (ok) => results.push(ok));
	const s = FakeSocket.instances[0];
	timers.fire();
	assert.deepEqual(results, [false]);
	assert.equal(s.closed, true);
	// A late open sends nothing.
	s.onopen();
	assert.deepEqual(s.sent, []);
	assert.deepEqual(results, [false]);
});

test("launchViaHub posts /api/watch/launch { uuid } and is ok only on { ok: true }", () => {
	const answers = [
		[null, { ok: true }, true],
		[null, { ok: false, reason: "unreachable" }, false],
		[new Error("hub answered 502"), undefined, false],
	];
	for (const [err, json, want] of answers) {
		const hub = new FakeHub((cb) => cb(err, json));
		const results = [];
		launchViaHub(hub, APP_UUID, (ok) => results.push(ok));
		assert.deepEqual(hub.posts, [{ path: "/api/watch/launch", body: { uuid: APP_UUID } }]);
		assert.deepEqual(results, [want]);
	}
	const results = [];
	launchViaHub(null, APP_UUID, (ok) => results.push(ok));
	assert.deepEqual(results, [false]);
});

test("launch tries loopback, then POST /api/watch/launch { uuid }, reports which path worked", () => {
	FakeSocket.reset();
	const timers = new FakeTimers();
	const hub = new FakeHub((cb) => cb(null, { ok: true }));
	const results = [];
	launch(opts(timers, { hub }), APP_UUID, (ok, path) => results.push([ok, path]));
	FakeSocket.instances[0].onopen();
	assert.deepEqual(results, [[true, "loopback"]]);
	assert.deepEqual(hub.posts, []);

	launch(opts(timers, { hub }), APP_UUID, (ok, path) => results.push([ok, path]));
	FakeSocket.instances[1].onerror();
	assert.deepEqual(hub.posts, [{ path: "/api/watch/launch", body: { uuid: APP_UUID } }]);
	assert.deepEqual(results, [[true, "loopback"], [true, "hub"]]);

	// Port 0 (the emulator without a phone simulator port) skips the loopback.
	launch(opts(timers, { hub, port: 0 }), APP_UUID, (ok, path) => results.push([ok, path]));
	assert.equal(FakeSocket.instances.length, 2);
	assert.deepEqual(results[2], [true, "hub"]);
});

test("launch with both failing → cb(false, 'none')", () => {
	FakeSocket.reset();
	const timers = new FakeTimers();
	const hub = new FakeHub((cb) => cb(new Error("hub answered 502")));
	const results = [];
	launch(opts(timers, { hub }), APP_UUID, (ok, path) => results.push([ok, path]));
	timers.fire();
	assert.deepEqual(results, [[false, "none"]]);
	assert.equal(hub.posts.length, 1);
});
