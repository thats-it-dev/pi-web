const test = require("node:test");
const assert = require("node:assert/strict");
const { createHubClient, socketUrl, normalizeHubUrl } = require("../../shared/pkjs/hub.js");
const { FakeSocket, FakeXhr, FakeTimers } = require("./support/fakes.js");

function setup(opts) {
	opts = opts || {};
	FakeSocket.reset();
	FakeXhr.reset();
	const timers = new FakeTimers();
	const pending = [];
	const texts = [];
	const notices = [];
	const statuses = [];
	const logs = [];
	const hub = createHubClient({
		url: "https://h:7878",
		WebSocket: opts.noWs ? null : opts.WebSocket || FakeSocket,
		XMLHttpRequest: FakeXhr,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		onPending: (f) => {
			pending.push(f);
			if (opts.throwPending) throw new Error("boom");
		},
		onText: (f) => texts.push(f),
		onNotice: (f) => notices.push(f),
		onStatus: (s) => statuses.push(s),
		log: (m) => logs.push(m),
	});
	return { hub, timers, pending, texts, notices, statuses, logs };
}
const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const xhr = () => FakeXhr.instances[FakeXhr.instances.length - 1];

test("socketUrl maps http(s) to ws(s) and appends the stream path", () => {
	assert.equal(socketUrl("https://h:7878"), "wss://h:7878/api/watch/stream");
	assert.equal(socketUrl("http://127.0.0.1:5173"), "ws://127.0.0.1:5173/api/watch/stream");
});

test("with a WebSocket: connecting, open → online, pending and text frames are dispatched", () => {
	const t = setup();
	t.hub.connect();
	assert.equal(t.hub.transport(), "ws");
	assert.equal(sock().url, "wss://h:7878/api/watch/stream");
	sock().onopen();
	assert.deepEqual(t.statuses, ["connecting", "online"]);
	sock().onmessage({ data: JSON.stringify({ type: "pending", cursor: 3, queries: [] }) });
	assert.deepEqual(t.pending, [{ cursor: 3, queries: [] }]);
	sock().onmessage({ data: JSON.stringify({ type: "text", sessionId: "s1", text: "hi", streaming: true }) });
	assert.deepEqual(t.texts, [{ sessionId: "s1", text: "hi", streaming: true }]);
	sock().onmessage({ data: "not json" });
	assert.equal(t.pending.length, 1);
});

test("a notice frame is dispatched to onNotice", () => {
	const t = setup();
	t.hub.connect();
	sock().onopen();
	sock().onmessage({ data: JSON.stringify({ type: "notice", text: "Session closed" }) });
	assert.deepEqual(t.notices, [{ text: "Session closed" }]);
	assert.equal(t.pending.length, 0);
});

test("showing with a null query sends nulls", () => {
	const t = setup();
	t.hub.connect();
	sock().onopen();
	t.hub.showing(null, "s1");
	assert.equal(sock().sent[0], '{"type":"showing","queryId":null,"sessionId":"s1"}');
});

test("connect is idempotent and transport is null before connect", () => {
	const t = setup();
	assert.equal(t.hub.transport(), null);
	t.hub.connect();
	t.hub.connect();
	assert.equal(FakeSocket.instances.length, 1);
});

test("showing goes over the open socket as a frame, and over POST when the socket is not open", () => {
	const t = setup();
	t.hub.connect();
	t.hub.showing("q1", "s1");
	assert.equal(sock().sent.length, 0);
	assert.equal(xhr().method, "POST");
	assert.equal(xhr().url, "https://h:7878/api/watch/showing");
	assert.equal(xhr().body, '{"type":"showing","queryId":"q1","sessionId":"s1"}');
	sock().onopen();
	t.hub.showing("q1", "s1");
	assert.equal(sock().sent[0], '{"type":"showing","queryId":"q1","sessionId":"s1"}');
});

test("close → offline and a reconnect after 1 s, then 2, 4 … capped at 30 s; an open resets to 1 s", () => {
	const t = setup();
	t.hub.connect();
	const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
	expected.forEach((ms) => {
		sock().onclose();
		assert.deepEqual(t.timers.pending(), [ms]);
		t.timers.fire(0);
	});
	assert.equal(FakeSocket.instances.length, expected.length + 1);
	assert.equal(t.statuses[t.statuses.length - 1], "offline");
	sock().onopen();
	sock().onclose();
	assert.deepEqual(t.timers.pending(), [1000]);
});

test("without a WebSocket it long-polls: GET pending?since=0&wait=1 with timeout 35000, then since=<cursor>", () => {
	const t = setup({ noWs: true });
	t.hub.connect();
	assert.equal(t.hub.transport(), "poll");
	assert.equal(xhr().method, "GET");
	assert.equal(xhr().url, "https://h:7878/api/watch/pending?since=0&wait=1");
	assert.equal(xhr().timeout, 35000);
	xhr().respond(200, '{"cursor":7,"queries":[],"showing":null,"sessions":[]}');
	assert.equal(t.pending.length, 1);
	assert.equal(t.pending[0].cursor, 7);
	assert.equal(t.statuses[t.statuses.length - 1], "online");
	assert.equal(FakeXhr.instances.length, 2);
	assert.equal(xhr().url, "https://h:7878/api/watch/pending?since=7&wait=1");
});

test("a failed poll → offline and the same back-off", () => {
	const t = setup({ noWs: true });
	t.hub.connect();
	[1000, 2000, 4000].forEach((ms, i) => {
		const kind = ["fail", "expire", "respond"][i];
		if (kind === "respond") xhr().respond(500, "boom");
		else xhr()[kind]();
		assert.equal(t.statuses[t.statuses.length - 1], "offline");
		assert.deepEqual(t.timers.pending(), [ms]);
		t.timers.fire(0);
		assert.equal(xhr().url, "https://h:7878/api/watch/pending?since=0&wait=1");
	});
	xhr().respond(200, '{"cursor":2}');
	xhr().fail();
	assert.deepEqual(t.timers.pending(), [1000]);
});

test("post sends JSON with content-type and 15 s timeout; non-2xx → err.status; parse failure → err", () => {
	const t = setup();
	const results = [];
	t.hub.post("/api/watch/x", { a: 1 }, (err, json) => results.push([err, json]));
	assert.equal(xhr().method, "POST");
	assert.equal(xhr().url, "https://h:7878/api/watch/x");
	assert.equal(xhr().body, '{"a":1}');
	assert.equal(xhr().headers["content-type"], "application/json");
	assert.equal(xhr().timeout, 15000);
	xhr().respond(200, '{"ok":true}');
	assert.deepEqual(results[0], [null, { ok: true }]);

	t.hub.post("/api/watch/x", {}, (err, json) => results.push([err, json]));
	xhr().respond(409, '{"error":"gone"}');
	assert.ok(results[1][0] instanceof Error);
	assert.equal(results[1][0].status, 409);
	assert.equal(results[1][0].hubError, "gone");

	t.hub.get("/api/watch/y", (err, json) => results.push([err, json]));
	assert.equal(xhr().method, "GET");
	xhr().respond(200, "<html>");
	assert.ok(results[2][0] instanceof Error);

	t.hub.get("/api/watch/y", (err) => results.push([err]));
	xhr().fail();
	assert.ok(results[3][0] instanceof Error);
	t.hub.get("/api/watch/y", (err) => results.push([err]));
	xhr().expire();
	assert.ok(results[4][0] instanceof Error);
});

test("close() stops reconnects and polling and closes the socket", () => {
	const t = setup();
	t.hub.connect();
	const s = sock();
	t.hub.close();
	assert.equal(s.closed, true);
	s.onclose();
	assert.deepEqual(t.timers.pending(), []);
	assert.equal(t.statuses[t.statuses.length - 1], "offline");

	const p = setup({ noWs: true });
	p.hub.connect();
	const x = xhr();
	p.hub.close();
	x.respond(200, '{"cursor":1}');
	assert.equal(p.pending.length, 0);
	assert.equal(FakeXhr.instances.length, 1);

	const q = setup({ noWs: true });
	q.hub.connect();
	xhr().fail();
	q.hub.close();
	assert.deepEqual(q.timers.pending(), []);
});

test("normalizeHubUrl accepts only http(s), lower-cases the scheme and strips trailing slashes", () => {
	assert.equal(normalizeHubUrl("https://h.ts.net/"), "https://h.ts.net");
	assert.equal(normalizeHubUrl("  Https://H.ts.net:7878///  "), "https://H.ts.net:7878");
	assert.equal(normalizeHubUrl("HTTP://127.0.0.1:5173"), "http://127.0.0.1:5173");
	assert.equal(normalizeHubUrl("h.ts.net"), null);
	assert.equal(normalizeHubUrl("ws://h"), null);
	assert.equal(normalizeHubUrl("https://"), null);
	assert.equal(normalizeHubUrl("https:///x"), null);
	assert.equal(normalizeHubUrl(""), null);
	assert.equal(normalizeHubUrl(null), null);
	assert.equal(socketUrl(normalizeHubUrl("Https://h")), "wss://h/api/watch/stream");
});

test("a WebSocket constructor that throws → offline and a scheduled retry, not a wedge at connecting", () => {
	let tries = 0;
	function Throwing() {
		tries++;
		throw new SyntaxError("bad url");
	}
	const t = setup({ WebSocket: Throwing });
	assert.doesNotThrow(() => t.hub.connect());
	assert.deepEqual(t.statuses, ["connecting", "offline"]);
	assert.deepEqual(t.timers.pending(), [1000]);
	t.timers.fire(0);
	assert.equal(tries, 2);
	assert.deepEqual(t.timers.pending(), [2000]);
	assert.ok(t.logs.some((m) => /socket failed/.test(m)));
});

test("a throwing onPending does not end the poll loop or the socket handler", () => {
	const p = setup({ noWs: true, throwPending: true });
	p.hub.connect();
	assert.doesNotThrow(() => xhr().respond(200, '{"cursor":4}'));
	assert.equal(p.pending.length, 1);
	assert.equal(FakeXhr.instances.length, 2, "the next poll went out");
	assert.equal(xhr().url, "https://h:7878/api/watch/pending?since=4&wait=1");
	assert.ok(p.logs.some((m) => /pending handler failed: boom/.test(m)));

	const w = setup({ throwPending: true });
	w.hub.connect();
	sock().onopen();
	assert.doesNotThrow(() => sock().onmessage({ data: '{"type":"pending","cursor":1}' }));
	sock().onmessage({ data: '{"type":"pending","cursor":2}' });
	assert.equal(w.pending.length, 2);
});

test("non-2xx without a usable JSON error leaves hubError unset", () => {
	const t = setup();
	const errs = [];
	t.hub.post("/api/watch/x", {}, (err) => errs.push(err));
	xhr().respond(404, "");
	t.hub.post("/api/watch/x", {}, (err) => errs.push(err));
	xhr().respond(502, "<html>bad gateway</html>");
	t.hub.post("/api/watch/x", {}, (err) => errs.push(err));
	xhr().respond(500, '{"error":42}');
	assert.deepEqual(errs.map((e) => e.status), [404, 502, 500]);
	assert.deepEqual(errs.map((e) => e.hubError), [undefined, undefined, undefined]);
});

test("network and timeout errors carry no status, so they read as unreachable", () => {
	const t = setup();
	const errs = [];
	t.hub.post("/api/watch/x", {}, (err) => errs.push(err));
	xhr().fail();
	t.hub.post("/api/watch/x", {}, (err) => errs.push(err));
	xhr().expire();
	assert.deepEqual(errs.map((e) => e.message), ["network error", "timeout"]);
	assert.deepEqual(errs.map((e) => e.status), [undefined, undefined]);
});

test("a 2xx with an unparsable body is a hub error, not unreachable", () => {
	const t = setup();
	const errs = [];
	t.hub.post("/api/watch/x", {}, (err) => errs.push(err));
	xhr().respond(200, "<html>proxy page</html>");
	assert.equal(errs[0].status, 200);
	assert.equal(errs[0].hubError, "Bad hub reply");
});
