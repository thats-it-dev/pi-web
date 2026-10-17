const test = require("node:test");
const assert = require("node:assert/strict");
const { createFace, selectSheet, piCounts } = require("../src/pkjs/face.js");
const { FakeTimers, FakeSocket } = require("../../app/test/support/fakes.js");

const MIN = 60 * 1000;

function req(id, createdAt, extra) {
	return Object.assign({ id: id, kind: "dialog", sessionId: "s1", sessionTitle: "t", tool: "bash", message: "Allow " + id + "?", options: ["allow", "deny"], createdAt: createdAt }, extra || {});
}
function session(id, state) {
	return { id: id, title: id, state: state, live: true };
}

function FakeHub() {
	this.calls = [];
}
FakeHub.prototype.showing = function (requestId, sessionId) {
	this.calls.push({ kind: "showing", requestId: requestId, sessionId: sessionId });
};
FakeHub.prototype.get = function (path, cb) {
	this.calls.push({ kind: "get", path: path, cb: cb });
};
FakeHub.prototype.post = function (path, body, cb) {
	this.calls.push({ kind: "post", path: path, body: body, cb: cb });
};
FakeHub.prototype.connect = function () {
	this.calls.push({ kind: "connect" });
};
FakeHub.prototype.close = function () {
	this.calls.push({ kind: "close" });
};
FakeHub.prototype.of = function (kind) {
	return this.calls.filter((c) => c.kind === kind);
};

function setup(opts) {
	opts = opts || {};
	const timers = new FakeTimers();
	const hub = new FakeHub();
	const store = Object.assign({}, opts.store || {});
	const dicts = [];
	const logs = [];
	let inFlight = null;
	let now = 0;
	const face = createFace({
		send: (dict, onAck, onFail) => {
			assert.equal(inFlight, null, "a second dict was sent while one is in flight");
			dicts.push(dict);
			inFlight = { onAck, onFail };
		},
		storage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		now: () => now,
		log: (m) => logs.push(m),
		WebSocket: opts.WebSocket === undefined ? null : opts.WebSocket,
		launchPort: () => (opts.launchPort === undefined ? 9000 : opts.launchPort),
	});
	face.setHub(hub);
	const t = {
		face,
		hub,
		timers,
		dicts,
		logs,
		store,
		inFlight: () => inFlight,
		advance(ms) {
			now += ms;
		},
		ack() {
			const f = inFlight;
			assert.ok(f, "nothing in flight to ack");
			inFlight = null;
			f.onAck();
		},
		fail() {
			const f = inFlight;
			assert.ok(f, "nothing in flight to fail");
			inFlight = null;
			f.onFail({ error: "nack" });
		},
		// Acks until the outbox is empty; returns the dicts sent from now on (including the one in flight).
		drain() {
			const from = inFlight ? dicts.length - 1 : dicts.length;
			while (inFlight) t.ack();
			return dicts.slice(from);
		},
		// Starts, answers the watch's hello and drains; returns the hello's burst.
		hello() {
			face.start();
			t.drain();
			face.onAppMessage({ CMD: "hello", CMD_ID: 1 });
			return t.drain();
		},
	};
	return t;
}

test("selectSheet picks the oldest pending request, null when none", () => {
	assert.equal(selectSheet([], null), null);
	assert.equal(selectSheet(undefined, null), null);
	assert.equal(selectSheet([req("b", 20), req("a", 10), req("c", 30)], null).id, "a");
	// Ties by id.
	assert.equal(selectSheet([req("y", 10), req("x", 10)], null).id, "x");
	// The shown request stays while it is pending (the sheet never rotates); once gone, the oldest.
	assert.equal(selectSheet([req("a", 10), req("b", 5)], "a").id, "a");
	assert.equal(selectSheet([req("a", 10), req("b", 5)], "gone").id, "b");
});

test("piCounts counts running sessions and pending requests", () => {
	assert.deepEqual(piCounts({ requests: [req("a", 1), req("b", 2)], sessions: [session("s1", "running"), session("s2", "idle"), session("s3", "running"), { id: "c1", state: "running", live: false }] }), { running: 2, pending: 2 });
	assert.deepEqual(piCounts({}), { running: 0, pending: 0 });
});

test("start() sends the launch burst at once: the watch can write its hello only after the phone has sent", () => {
	const t = setup();
	t.face.start();
	assert.deepEqual(t.drain().map((d) => d.MSG), ["cfg", "net", "pi", "sheet"]);
});

test("hello → cfg then net then pi then sheet, one dict at a time, each after the previous ack", () => {
	const t = setup();
	t.face.start();
	t.drain();
	const from = t.dicts.length;
	t.face.onAppMessage({ CMD: "hello", CMD_ID: 1 });
	assert.equal(t.dicts.length, from + 1);
	assert.deepEqual(t.dicts[from], { MSG: "cfg", DARK: 1, CORNER_TL: "date", CORNER_TR: "pi", CORNER_BL: "hr", CORNER_BR: "steps", UNIT: "C" });
	t.ack();
	assert.deepEqual(t.dicts[from + 1], { MSG: "net", NET: "connecting" });
	t.ack();
	// No frame yet: the pi corner is unknown (-1), not 0/0.
	assert.deepEqual(t.dicts[from + 2], { MSG: "pi", PI_RUNNING: -1, PI_PENDING: -1 });
	t.ack();
	assert.deepEqual(t.dicts[from + 3], { MSG: "sheet", REQ_ID: "", REQ_KIND: "", REQ_TOOL: "", REQ_TEXT: "", REQ_INDEX: 0, REQ_COUNT: 0, VIBE: 0 });
	t.ack();
	assert.equal(t.dicts.length, from + 4);
	assert.equal(t.inFlight(), null);
	// Another hello (the face relaunched) sends the whole state again.
	t.face.onAppMessage({ CMD: "hello", CMD_ID: 1 });
	assert.deepEqual(t.drain().map((d) => d.MSG), ["cfg", "net", "pi", "sheet"]);
});

test("the watch's native ready message (a dict without CMD) is not a command", () => {
	const t = setup();
	t.face.start();
	t.drain();
	t.face.onAppMessage({});
	assert.deepEqual(t.drain(), []);
});

test("a new request on an empty list sends a sheet with index/count and reports showing(requestId, null)", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [], sessions: [session("s1", "idle")] });
	assert.deepEqual(t.drain(), [{ MSG: "pi", PI_RUNNING: 0, PI_PENDING: 0 }]);
	t.face.onPending({ requests: [req("d1", 10, { tool: "bash", message: "Allow bash?\ngit push" })], sessions: [session("s1", "needs_you")] });
	assert.deepEqual(t.drain(), [
		{ MSG: "sheet", REQ_ID: "d1", REQ_KIND: "dialog", REQ_TOOL: "bash", REQ_TEXT: "Allow bash?\ngit push", REQ_INDEX: 1, REQ_COUNT: 1, VIBE: 1 },
		{ MSG: "pi", PI_RUNNING: 0, PI_PENDING: 1 },
	]);
	// The first frame after start reports its (empty) sheet too; then only the change.
	assert.deepEqual(t.hub.of("showing").map((c) => [c.requestId, c.sessionId]), [[null, null], ["d1", null]]);
	assert.equal(t.face.shown(), "d1");
});

test("the sheet text is clipped to 240 characters and a missing tool is empty", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [req("f1", 1, { kind: "finished", tool: null, message: "x".repeat(300) })], sessions: [] });
	const sheet = t.drain().find((d) => d.MSG === "sheet");
	assert.equal(sheet.REQ_TEXT.length, 240);
	assert.equal(sheet.REQ_TOOL, "");
	assert.equal(sheet.REQ_KIND, "finished");
});

test("the shown request leaving the list sends the next oldest with the counter updated; the last one leaving sends REQ_ID \"\" and showing(null)", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [req("a", 10), req("b", 20)], sessions: [] });
	let sheets = t.drain().filter((d) => d.MSG === "sheet");
	assert.deepEqual(sheets.map((d) => [d.REQ_ID, d.REQ_INDEX, d.REQ_COUNT]), [["a", 1, 2]]);
	// A newer one arrives: the sheet stays on a, the counter updates.
	t.face.onPending({ requests: [req("a", 10), req("b", 20), req("c", 30)], sessions: [] });
	sheets = t.drain().filter((d) => d.MSG === "sheet");
	assert.deepEqual(sheets.map((d) => [d.REQ_ID, d.REQ_INDEX, d.REQ_COUNT]), [["a", 1, 3]]);
	// a is answered elsewhere.
	t.face.onPending({ requests: [req("b", 20), req("c", 30)], sessions: [] });
	sheets = t.drain().filter((d) => d.MSG === "sheet");
	assert.deepEqual(sheets.map((d) => [d.REQ_ID, d.REQ_INDEX, d.REQ_COUNT, d.VIBE]), [["b", 1, 2, 0]]);
	t.face.onPending({ requests: [], sessions: [] });
	sheets = t.drain().filter((d) => d.MSG === "sheet");
	assert.deepEqual(sheets.map((d) => [d.REQ_ID, d.REQ_INDEX, d.REQ_COUNT]), [["", 0, 0]]);
	assert.deepEqual(t.hub.of("showing").map((c) => [c.requestId, c.sessionId]), [["a", null], ["b", null], [null, null]]);
	assert.equal(t.face.shown(), null);
});

test("an identical pending frame (same ids, order and count) sends nothing", () => {
	const t = setup();
	t.hello();
	const frame = () => ({ requests: [req("a", 10), req("b", 20)], sessions: [session("s1", "running")] });
	t.face.onPending(frame());
	t.drain();
	const showing = t.hub.of("showing").length;
	t.face.onPending(frame());
	assert.deepEqual(t.drain(), []);
	assert.equal(t.hub.of("showing").length, showing);
});

test("sheet, pi, net and cfg coalesce: the newest replaces a queued one of the same kind", () => {
	const t = setup();
	t.hello();
	t.face.onStatus("online"); // in flight
	t.face.onPending({ requests: [req("a", 10)], sessions: [session("s1", "running")] });
	t.face.onPending({ requests: [req("a", 10), req("b", 20)], sessions: [session("s1", "running"), session("s2", "running")] });
	t.face.onStatus("offline");
	t.face.onStatus("online");
	t.face.onSettings({ DARK: false });
	t.face.onSettings({ DARK: true, UNIT: "F" });
	const sent = t.drain();
	// The queued offline was replaced by online (sent again: it differs from the last queued, offline).
	assert.deepEqual(sent.map((d) => d.MSG), ["net", "sheet", "pi", "net", "cfg"]);
	assert.deepEqual([sent[1].REQ_ID, sent[1].REQ_COUNT], ["a", 2]);
	assert.deepEqual([sent[2].PI_RUNNING, sent[2].PI_PENDING], [2, 2]);
	assert.equal(sent[3].NET, "online");
	assert.equal(sent[4].DARK, 1);
	assert.equal(sent[4].UNIT, "F");
});

test("a failed send is retried once after 500 ms, then dropped", () => {
	const t = setup();
	t.hello();
	t.face.onStatus("online");
	t.fail();
	assert.deepEqual(t.timers.pending(), [500]);
	t.timers.fire(0);
	assert.deepEqual(t.dicts.slice(-2), [{ MSG: "net", NET: "online" }, { MSG: "net", NET: "online" }]);
	t.fail();
	assert.deepEqual(t.timers.pending(), []);
	// Dropped: the outbox moves on, and the same net is sent again when it is reported again.
	t.face.onStatus("online");
	assert.deepEqual(t.dicts.slice(-1), [{ MSG: "net", NET: "online" }]);
});

test("idle policy: 10 minutes with nothing pending and nothing running closes the socket and polls once a minute; a poll with a request reopens it; net is 'idle' meanwhile", () => {
	const t = setup();
	t.hello();
	t.face.onStatus("online");
	t.face.onPending({ requests: [], sessions: [session("s1", "running")] });
	t.drain();
	assert.deepEqual(t.timers.pending(), [], "a running session keeps the socket open");
	t.face.onPending({ requests: [], sessions: [session("s1", "idle")] });
	t.drain();
	assert.deepEqual(t.timers.pending(), [10 * MIN]);
	// Another quiet frame does not restart the ten minutes.
	t.face.onPending({ requests: [], sessions: [session("s1", "idle"), session("s2", "idle")] });
	assert.deepEqual(t.timers.pending(), [10 * MIN]);
	// Activity clears it; quiet again re-arms it.
	t.face.onPending({ requests: [req("a", 1)], sessions: [session("s1", "idle")] });
	assert.deepEqual(t.timers.pending(), []);
	t.face.onPending({ requests: [], sessions: [session("s1", "idle")] });
	t.drain();
	assert.deepEqual(t.timers.pending(), [10 * MIN]);

	t.timers.fire(0);
	assert.equal(t.hub.of("close").length, 1);
	// The client's own "offline" on close does not replace idle.
	t.face.onStatus("offline");
	assert.deepEqual(t.drain(), [{ MSG: "net", NET: "idle" }]);
	assert.deepEqual(t.timers.pending(), [MIN]);

	// A quiet poll: poll again in a minute.
	t.timers.fire(0);
	let gets = t.hub.of("get");
	assert.equal(gets.length, 1);
	assert.equal(gets[0].path, "/api/watch/pending");
	gets[0].cb(null, { cursor: 5, requests: [], showing: null, sessions: [session("s1", "idle")] });
	assert.deepEqual(t.timers.pending(), [MIN]);
	assert.equal(t.hub.of("connect").length, 0);
	// A failed poll: poll again in a minute.
	t.timers.fire(0);
	t.hub.of("get")[1].cb(new Error("network error"));
	assert.deepEqual(t.timers.pending(), [MIN]);

	// A poll that sees a request reopens the socket and shows the sheet.
	t.timers.fire(0);
	const frame = { cursor: 6, requests: [req("d1", 50)], showing: null, sessions: [session("s1", "needs_you")] };
	t.hub.of("get")[2].cb(null, frame);
	assert.equal(t.hub.of("connect").length, 1);
	assert.deepEqual(t.timers.pending(), []);
	const sent = t.drain();
	assert.deepEqual(sent.filter((d) => d.MSG === "sheet").map((d) => d.REQ_ID), ["d1"]);
	// The reconnecting client's status shows again.
	t.face.onStatus("connecting");
	t.face.onStatus("online");
	assert.deepEqual(t.drain().map((d) => d.NET), ["connecting", "online"]);
	// The reopened socket's first frame repeats the poll's result: no second sheet.
	t.face.onPending(JSON.parse(JSON.stringify(frame)));
	assert.deepEqual(t.drain(), []);
});

test("idle: a poll that sees a running session reopens the socket", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [], sessions: [] });
	t.drain();
	t.timers.fire(0); // idle
	assert.deepEqual(t.drain(), [{ MSG: "net", NET: "idle" }]);
	t.timers.fire(0); // poll
	t.hub.of("get")[0].cb(null, { requests: [], sessions: [session("s1", "running")] });
	assert.equal(t.hub.of("connect").length, 1);
	assert.deepEqual(t.drain(), [{ MSG: "pi", PI_RUNNING: 1, PI_PENDING: 0 }]);
});

test("onSettings persists the corners, dark, unit and hub URL and sends cfg", () => {
	const t = setup();
	t.hello();
	t.face.onSettings({ CORNER_TL: "battery", CORNER_TR: "weather", CORNER_BL: "none", CORNER_BR: "pi", DARK: false, UNIT: "F", HUB_URL: "https://hub.example" });
	assert.deepEqual(t.drain(), [{ MSG: "cfg", DARK: 0, CORNER_TL: "battery", CORNER_TR: "weather", CORNER_BL: "none", CORNER_BR: "pi", UNIT: "F" }]);
	assert.deepEqual(JSON.parse(t.store["pi-web.face.corners"]), ["battery", "weather", "none", "pi"]);
	assert.equal(t.store["pi-web.dark"], "0");
	assert.equal(t.store["pi-web.unit"], "F");
	assert.equal(t.store["pi-web.hubUrl"], "https://hub.example");
	// Partial settings (the stub's /dev/settings has no HUB_URL) keep the rest; bad values are ignored.
	t.face.onSettings({ DARK: "1", CORNER_TL: "moon", UNIT: "K" });
	assert.deepEqual(t.drain(), [{ MSG: "cfg", DARK: 1, CORNER_TL: "battery", CORNER_TR: "weather", CORNER_BL: "none", CORNER_BR: "pi", UNIT: "F" }]);
	assert.equal(t.store["pi-web.hubUrl"], "https://hub.example");
});

test("stored settings are what the first cfg carries", () => {
	const t = setup({ store: { "pi-web.face.corners": JSON.stringify(["steps", "hr", "date", "weather"]), "pi-web.dark": "0", "pi-web.unit": "F" } });
	const sent = t.hello();
	assert.deepEqual(sent[0], { MSG: "cfg", DARK: 0, CORNER_TL: "steps", CORNER_TR: "hr", CORNER_BL: "date", CORNER_BR: "weather", UNIT: "F" });
});

test("a malformed stored corners value falls back to the defaults", () => {
	const t = setup({ store: { "pi-web.face.corners": "{not json" } });
	const sent = t.hello();
	assert.deepEqual([sent[0].CORNER_TL, sent[0].CORNER_TR, sent[0].CORNER_BL, sent[0].CORNER_BR], ["date", "pi", "hr", "steps"]);
});

test("onWeather sends the temperature; hello repeats the last one", () => {
	const t = setup();
	t.hello();
	t.face.onWeather("12°");
	assert.deepEqual(t.drain(), [{ MSG: "weather", TEMP: "12°" }]);
	t.face.onAppMessage({ CMD: "hello", CMD_ID: 1 });
	assert.deepEqual(t.drain().map((d) => d.MSG), ["cfg", "net", "pi", "sheet", "weather"]);
});

test("VIBE is 1 when a request id appears that the previous frame did not have; 0 for a switch, a counter change or a replay", () => {
	const t = setup();
	t.hello();
	const vibes = (frame) => {
		t.face.onPending(frame);
		return t.drain().filter((d) => d.MSG === "sheet").map((d) => [d.REQ_ID, d.REQ_COUNT, d.VIBE]);
	};
	assert.deepEqual(vibes({ requests: [], sessions: [] }), []);
	// [] → [a]: the list went from empty to non-empty.
	assert.deepEqual(vibes({ requests: [req("a", 10)], sessions: [] }), [["a", 1, 1]]);
	// [a] → [a, b]: a new request while others are pending (the sheet stays on a).
	assert.deepEqual(vibes({ requests: [req("a", 10), req("b", 20)], sessions: [] }), [["a", 2, 1]]);
	// The same list again: nothing goes out (VIBE does not count as a change).
	assert.deepEqual(vibes({ requests: [req("a", 10), req("b", 20)], sessions: [] }), []);
	// [a, b] → [b]: a switch to the next oldest.
	assert.deepEqual(vibes({ requests: [req("b", 20)], sessions: [] }), [["b", 1, 0]]);
	// A reconnect replaying [b], and the watch's hello: no vibe.
	assert.deepEqual(vibes({ requests: [req("b", 20)], sessions: [] }), []);
	t.face.onAppMessage({ CMD: "hello", CMD_ID: 1 });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "sheet").map((d) => d.VIBE), [0]);
	// A request that leaves and one that arrives in the same frame (count unchanged): still a vibe.
	assert.deepEqual(vibes({ requests: [req("b", 20), req("c", 30)], sessions: [] }), [["b", 2, 1]]);
	assert.deepEqual(vibes({ requests: [req("b", 20), req("d", 40)], sessions: [] }), [["b", 2, 1]]);
});

test("a queued vibe survives coalescing: a newer sheet without a vibe keeps VIBE 1", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [], sessions: [] });
	t.drain();
	t.face.onStatus("online"); // in flight
	t.face.onPending({ requests: [req("a", 10), req("b", 20)], sessions: [] });
	// a leaves before the vibing sheet went out: the switch to b replaces it in the queue.
	t.face.onPending({ requests: [req("b", 20)], sessions: [] });
	const sheets = t.drain().filter((d) => d.MSG === "sheet");
	assert.deepEqual(sheets.map((d) => [d.REQ_ID, d.REQ_COUNT, d.VIBE]), [["b", 1, 1]]);
});

test("launch: the loopback opens → result OK 1 for the command's CMD_ID, logged as via loopback", () => {
	FakeSocket.reset();
	const t = setup({ WebSocket: FakeSocket });
	t.hello();
	t.face.onAppMessage({ CMD: "launch", CMD_ID: 7 });
	assert.equal(FakeSocket.instances.length, 1);
	assert.equal(FakeSocket.instances[0].url, "ws://127.0.0.1:9000/");
	FakeSocket.instances[0].onopen();
	assert.deepEqual(t.drain(), [{ MSG: "result", CMD_ID: 7, OK: 1 }]);
	assert.ok(t.logs.includes("pi-web: launch via loopback"));
	assert.deepEqual(t.hub.of("post"), []);
});

test("launch: the loopback fails → POST /api/watch/launch; ok → result 1 via hub; both failing → result 0", () => {
	FakeSocket.reset();
	const t = setup({ WebSocket: FakeSocket, launchPort: 45678 });
	t.hello();
	t.face.onAppMessage({ CMD: "launch", CMD_ID: 3 });
	assert.equal(FakeSocket.instances[0].url, "ws://127.0.0.1:45678/");
	FakeSocket.instances[0].onerror();
	const posts = t.hub.of("post");
	assert.equal(posts.length, 1);
	assert.equal(posts[0].path, "/api/watch/launch");
	assert.deepEqual(posts[0].body, { uuid: "6d55f4ea-2ff6-419e-a2be-1ebdfd4f8f0b" });
	posts[0].cb(null, { ok: true });
	assert.deepEqual(t.drain(), [{ MSG: "result", CMD_ID: 3, OK: 1 }]);
	assert.ok(t.logs.includes("pi-web: launch via hub"));

	// No loopback port (the emulator without a phone simulator port), hub says no phone.
	const u = setup({ WebSocket: FakeSocket, launchPort: 0 });
	u.hello();
	u.face.onAppMessage({ CMD: "launch", CMD_ID: 4 });
	u.hub.of("post")[0].cb(null, { ok: false, reason: "no_phone" });
	assert.deepEqual(u.drain(), [{ MSG: "result", CMD_ID: 4, OK: 0 }]);
	assert.ok(u.logs.includes("pi-web: launch failed"));
});

test("result dicts are FIFO, not coalesced: two launches answer in order, both sent", () => {
	const t = setup({ WebSocket: null });
	t.hello();
	t.face.onAppMessage({ CMD: "launch", CMD_ID: 1 });
	t.face.onAppMessage({ CMD: "launch", CMD_ID: 2 });
	const posts = t.hub.of("post");
	assert.equal(posts.length, 2);
	// Both answers arrive while the first result is in flight.
	posts[0].cb(null, { ok: true });
	posts[1].cb(new Error("hub answered 502"));
	assert.deepEqual(t.drain(), [
		{ MSG: "result", CMD_ID: 1, OK: 1 },
		{ MSG: "result", CMD_ID: 2, OK: 0 },
	]);
});

test("showing(null, null) on the first frame after start and after every (re)open: it clears the app's showing on the hub", () => {
	const t = setup();
	t.hello();
	t.face.onStatus("online");
	t.face.onPending({ requests: [], sessions: [] });
	assert.deepEqual(t.hub.of("showing").map((c) => [c.requestId, c.sessionId]), [[null, null]]);
	t.face.onPending({ requests: [], sessions: [session("s1", "idle")] });
	assert.equal(t.hub.of("showing").length, 1, "an unchanged sheet is not reported again on the same socket");
	// A reconnect.
	t.face.onStatus("offline");
	t.face.onStatus("connecting");
	t.face.onStatus("online");
	t.face.onPending({ requests: [], sessions: [] });
	assert.deepEqual(t.hub.of("showing").map((c) => [c.requestId, c.sessionId]), [[null, null], [null, null]]);
	// A new hub (settings) reports again as well.
	t.face.setHub(t.hub);
	t.face.onPending({ requests: [], sessions: [] });
	assert.equal(t.hub.of("showing").length, 3);
});

test("idle: a failed poll shows offline, a quiet poll after it shows idle again", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [], sessions: [] });
	t.drain();
	t.timers.fire(0); // idle
	assert.deepEqual(t.drain(), [{ MSG: "net", NET: "idle" }]);
	t.timers.fire(0); // poll
	t.hub.of("get")[0].cb(new Error("network error"));
	assert.deepEqual(t.drain(), [{ MSG: "net", NET: "offline" }]);
	t.timers.fire(0);
	t.hub.of("get")[1].cb(null, { requests: [], sessions: [] });
	assert.deepEqual(t.drain(), [{ MSG: "net", NET: "idle" }]);
	// hello repeats the current one.
	t.face.onAppMessage({ CMD: "hello" });
	assert.equal(t.drain().find((d) => d.MSG === "net").NET, "idle");
	assert.deepEqual(t.timers.pending(), [MIN]);
});

test("idle: a poll reply that throws in the frame handler is logged, not thrown", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [], sessions: [] });
	t.drain();
	t.timers.fire(0); // idle
	t.timers.fire(0); // poll
	assert.doesNotThrow(() => t.hub.of("get")[0].cb(null, { requests: 5, sessions: [] }));
	assert.ok(t.logs.some((m) => m.indexOf("pi-web: poll handler failed: ") === 0));
	assert.equal(t.hub.of("connect").length, 1);
});

test("a vibing sheet dropped after failing with a newer sheet queued hands its VIBE to that sheet", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [], sessions: [] });
	t.drain();
	t.face.onPending({ requests: [req("a", 10)], sessions: [] });
	assert.deepEqual([t.dicts[t.dicts.length - 1].REQ_ID, t.dicts[t.dicts.length - 1].VIBE], ["a", 1]); // in flight
	t.face.onPending({ requests: [req("a", 10, { message: "Allow a, edited?" })], sessions: [] });
	t.fail(); // dropped at once: a newer sheet is queued
	assert.deepEqual(t.timers.pending(), []);
	const sheets = t.drain().filter((d) => d.MSG === "sheet");
	assert.deepEqual(sheets.map((d) => [d.REQ_ID, d.REQ_TEXT, d.VIBE]), [["a", "Allow a, edited?", 1]]);
});

test("a sheet unchanged for 5 minutes is sent again with the next frame (a lost sheet dict is not durable)", () => {
	const t = setup();
	t.hello();
	t.face.onPending({ requests: [req("a", 10)], sessions: [session("s1", "running")] });
	t.drain();
	t.advance(4 * MIN);
	t.face.onPending({ requests: [req("a", 10)], sessions: [session("s1", "idle")] });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "sheet"), []);
	t.advance(MIN);
	t.face.onPending({ requests: [req("a", 10)], sessions: [session("s1", "running")] });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "sheet").map((d) => [d.REQ_ID, d.VIBE]), [["a", 0]]);
	// The clock restarts: the next frame within 5 minutes sends nothing.
	t.advance(MIN);
	t.face.onPending({ requests: [req("a", 10)], sessions: [session("s1", "idle")] });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "sheet"), []);
	// A changed sheet restarts it as well.
	t.advance(4 * MIN);
	t.face.onPending({ requests: [], sessions: [] });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "sheet").map((d) => d.REQ_ID), [""]);
	t.advance(4 * MIN);
	t.face.onPending({ requests: [], sessions: [session("s1", "idle")] });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "sheet"), []);
});
