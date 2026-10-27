const test = require("node:test");
const assert = require("node:assert/strict");
const { createBridge, dictBytes, clock, elapsed } = require("../src/pkjs/bridge.js");
const { FakeTimers } = require("./support/fakes.js");

const MIN = 60 * 1000;
const NOW = new Date(2026, 9, 27, 13, 40, 0).getTime(); // local time, so the clock strings are TZ-proof
const RS = "\x1e";
const US = "\x1f";

function FakeHub() {
	this.calls = [];
}
FakeHub.prototype.showing = function (queryId, sessionId) {
	this.calls.push({ kind: "showing", queryId: queryId, sessionId: sessionId });
};
FakeHub.prototype.get = function (path, cb) {
	this.calls.push({ kind: "get", path: path, cb: cb });
};
FakeHub.prototype.post = function (path, body, cb) {
	this.calls.push({ kind: "post", path: path, body: body, cb: cb });
};
// Answers the last unanswered get/post (optionally the last whose path starts with prefix).
FakeHub.prototype.reply = function (err, json, prefix) {
	for (let i = this.calls.length - 1; i >= 0; i--) {
		const c = this.calls[i];
		if (!c.cb || c.answered) continue;
		if (prefix && c.path.indexOf(prefix) !== 0) continue;
		c.answered = true;
		c.cb(err, json);
		return c;
	}
	throw new Error("no call to reply to");
};
FakeHub.prototype.of = function (kind, prefix) {
	return this.calls.filter((c) => c.kind === kind && (!prefix || c.path.indexOf(prefix) === 0));
};

function setup(opts) {
	opts = opts || {};
	const timers = new FakeTimers();
	const hub = new FakeHub();
	const store = Object.assign({}, opts.store || {});
	const dicts = [];
	const logs = [];
	let inFlight = null;
	const clockState = { t: NOW };
	const bridge = createBridge({
		hub: hub,
		send: (dict, onAck, onFail) => {
			assert.equal(inFlight, null, "a second dict was sent while one is in flight");
			dicts.push(dict);
			inFlight = { onAck, onFail };
		},
		storage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)) },
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		now: () => clockState.t,
		log: (m) => logs.push(m),
	});
	const t = {
		bridge,
		hub,
		timers,
		dicts,
		logs,
		store,
		clock: clockState,
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
			const start = inFlight ? dicts.length - 1 : dicts.length;
			while (inFlight) t.ack();
			return dicts.slice(start);
		},
		all(msg) {
			return dicts.filter((d) => d.MSG === msg);
		},
		last(msg) {
			const l = t.all(msg);
			return l.length ? l[l.length - 1] : null;
		},
		// Pushes a pending frame and returns what it sent.
		pend(queries, sessions, showing) {
			bridge.onPending({ cursor: 1, queries: queries || [], sessions: sessions || [], showing: showing || null });
			return t.drain();
		},
	};
	return t;
}

function query(id, createdAt, over) {
	return Object.assign({ id, source: "pi", sessionId: "s1", label: "title s1", text: "Allow git push?", options: ["allow", "deny"], createdAt }, over || {});
}
function sess(id, status, over) {
	return Object.assign({ id, title: "title " + id, state: "idle", status, live: true, model: "qwen3", contextPercent: null, contextTokens: null, contextWindow: null, tps: null, updatedAt: NOW - 5 * MIN }, over || {});
}
const rowsOf = (home) => home.ROWS.split(RS).map((r) => r.split(US));

test("pending frame -> home dict under 1000 B with waiting rows first and status/sub per row", () => {
	const t = setup();
	const out = t.pend([], [sess("a", "done"), sess("b", "running"), sess("c", "waiting"), sess("d", "error")]);
	const home = out.filter((d) => d.MSG === "home").pop();
	assert.ok(dictBytes(home) <= 1000);
	const rows = rowsOf(home);
	assert.deepEqual(rows.map((r) => r[0]), ["c", "a", "b", "d"]);
	assert.deepEqual(rows.map((r) => r[2]), ["w", "d", "r", "e"]);
	assert.equal(rows[0][3], "");
	assert.equal(rows[1][3], clock(NOW - 5 * MIN)); // done: HH:MM
	assert.match(rows[1][3], /^\d\d:\d\d$/);
	assert.equal(rows[2][3], "0:00"); // running: elapsed since first seen
	assert.equal(rows[3][3], "");
});

test("a running row shows elapsed time since the phone first saw it running", () => {
	const t = setup();
	t.pend([], [sess("b", "running")]);
	t.clock.t += 4 * MIN + 12 * 1000;
	const out = t.pend([], [sess("b", "running", { title: "t2" })]);
	assert.equal(rowsOf(out.filter((d) => d.MSG === "home").pop())[0][3], "4:12");
	assert.equal(elapsed(65 * MIN), "1:05");
});

test("13 sessions -> 12 rows max and the dict fits, even with long titles", () => {
	const t = setup();
	const many = [];
	for (let i = 0; i < 13; i++) many.push(sess("s" + i, "done"));
	const home = t.pend([], many).filter((d) => d.MSG === "home").pop();
	assert.equal(rowsOf(home).length, 12);
	assert.ok(dictBytes(home) <= 1000);
	const long = [];
	for (let i = 0; i < 13; i++) long.push(sess("0123456789abcdef0123456789abcdef0123-" + i, "done", { title: "\u00e9".repeat(80) }));
	const h2 = setup().pend([], long).filter((d) => d.MSG === "home").pop();
	const rows = rowsOf(h2);
	assert.ok(rows.length < 12 && rows.length > 0);
	assert.ok(dictBytes(h2) <= 1000);
	assert.equal(rows[0][1].length, 40); // title clipped to 40
});

test("titles cannot smuggle separators into a row", () => {
	const t = setup();
	const home = t.pend([], [sess("a", "done", { title: "a\x1fb\x1ec\nd" })]).filter((d) => d.MSG === "home").pop();
	assert.deepEqual(rowsOf(home)[0].slice(0, 2), ["a", "a b c d"]);
});

test("oldest visible query -> query dict; resolved -> query_gone then the next query", () => {
	const t = setup();
	const q1 = query("q1", 1, { label: "L".repeat(60), text: "T".repeat(700), source: "ring-profile", options: ["one", "two"] });
	const q2 = query("q2", 2, { text: "second" });
	let out = t.pend([q2, q1], [sess("s1", "waiting")]);
	const first = out.filter((d) => d.MSG === "query");
	assert.equal(first.length, 1);
	assert.equal(first[0].ID, "q1");
	assert.equal(first[0].SOURCE, "ring");
	assert.equal(first[0].LABEL.length, 40);
	assert.ok(first[0].TEXT.length <= 600);
	assert.equal(first[0].OPTIONS, "one" + US + "two");
	assert.equal(first[0].AT, clock(1));
	assert.ok(dictBytes(first[0]) <= 1000);
	// A frame that changes nothing about the query sends nothing for it.
	out = t.pend([q2, q1], [sess("s1", "waiting")]);
	assert.equal(out.filter((d) => d.MSG === "query" || d.MSG === "query_gone").length, 0);
	// q1 is answered in the web app: the next frame has only q2.
	out = t.pend([q2], [sess("s1", "waiting")]);
	assert.deepEqual(out.filter((d) => d.MSG === "query" || d.MSG === "query_gone").map((d) => [d.MSG, d.ID]), [["query_gone", "q1"], ["query", "q2"]]);
	assert.equal(out.filter((d) => d.MSG === "query")[0].SOURCE, "pi");
	// And when nothing is left, just query_gone.
	out = t.pend([], []);
	assert.deepEqual(out.filter((d) => d.MSG === "query" || d.MSG === "query_gone").map((d) => [d.MSG, d.ID]), [["query_gone", "q2"]]);
});

test("the query dict names its session; a ring query has none; long ids still fit", () => {
	const t = setup();
	t.pend([query("q1", 1)], []);
	assert.equal(t.last("query").SESSION_ID, "s1");
	t.pend([query("q2", 0, { source: "ring-profile", sessionId: null })], []);
	assert.equal(t.last("query").SESSION_ID, "");
	t.pend([query("q3", -1, { sessionId: "s".repeat(64), text: "T".repeat(600), options: ["x".repeat(60), "y".repeat(60)] })], []);
	const q = t.last("query");
	assert.equal(q.SESSION_ID, "s".repeat(64));
	assert.ok(dictBytes(q) <= 1000);
});

test("a late-arriving older query becomes the one shown", () => {
	const t = setup();
	t.pend([query("q2", 2)], []);
	const out = t.pend([query("q2", 2), query("q1", 1)], []);
	assert.deepEqual(out.filter((d) => d.MSG === "query" || d.MSG === "query_gone").map((d) => [d.MSG, d.ID]), [["query_gone", "q2"], ["query", "q1"]]);
});

test("long option is clipped for display but answer sends the full option", () => {
	const t = setup();
	const longOpt = "Allow this command to run in the sandbox for the rest of the session";
	t.pend([query("q1", 1, { options: [longOpt, "deny"] })], []);
	const q = t.last("query");
	const shown = q.OPTIONS.split(US);
	assert.ok(shown[0].length <= 24);
	assert.ok(shown[0].length < longOpt.length);
	assert.equal(shown[1], "deny");
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 0 });
	const p = t.hub.of("post")[0];
	assert.equal(p.path, "/api/watch/answer");
	assert.deepEqual(p.body, { queryId: "q1", option: longOpt });
});

test("a query with many long options and long text still fits one dict and keeps option order", () => {
	const t = setup();
	const opts = [];
	for (let i = 0; i < 12; i++) opts.push("option number " + i + " " + "x".repeat(60));
	t.pend([query("q1", 1, { text: "T".repeat(600), options: opts })], []);
	const q = t.last("query");
	assert.ok(dictBytes(q) <= 1000);
	const shown = q.OPTIONS.split(US);
	assert.ok(shown.length >= 1);
	shown.forEach((s, i) => assert.ok(s.indexOf("option number " + i) === 0 || s === "" || s.charAt(0) === "o"));
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 1 });
	assert.equal(t.hub.of("post")[0].body.option, opts[1]);
});

test("answer sends {queryId, option}; success removes the query and shows the next", () => {
	const t = setup();
	t.pend([query("q1", 1), query("q2", 2)], []);
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 1 });
	assert.deepEqual(t.hub.of("post")[0].body, { queryId: "q1", option: "deny" });
	t.hub.reply(null, { ok: true });
	const out = t.drain();
	assert.deepEqual(out.filter((d) => d.MSG === "query" || d.MSG === "query_gone").map((d) => [d.MSG, d.ID]), [["query_gone", "q1"], ["query", "q2"]]);
});

test("an answer for an index the query does not have is ignored", () => {
	const t = setup();
	t.pend([query("q1", 1)], []);
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 5 });
	t.bridge.onAppMessage({ CMD: "answer", ID: "nope", OK: 0 });
	assert.equal(t.hub.of("post").length, 0);
});

test("a failed answer posts a notice and may be retried; gone removes the query", () => {
	const t = setup();
	t.pend([query("q1", 1)], []);
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 0 });
	t.hub.reply(new Error("network error"));
	assert.equal(t.drain().filter((d) => d.MSG === "notice").length, 1);
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 0 });
	assert.equal(t.hub.of("post").length, 2);
	t.hub.reply(null, { ok: false, reason: "gone" });
	assert.ok(t.drain().some((d) => d.MSG === "query_gone" && d.ID === "q1"));
});

test("skip sends {queryId} and moves to the next query", () => {
	const t = setup();
	t.pend([query("q1", 1), query("q2", 2)], []);
	t.bridge.onAppMessage({ CMD: "skip", ID: "q1" });
	const p = t.hub.of("post")[0];
	assert.equal(p.path, "/api/watch/skip");
	assert.deepEqual(p.body, { queryId: "q1" });
	t.hub.reply(null, { ok: true });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "query" || d.MSG === "query_gone").map((d) => [d.MSG, d.ID]), [["query_gone", "q1"], ["query", "q2"]]);
});

test("reconnect after WebSocket drop re-sends home and the current query, and a queued answer is not sent twice", () => {
	const t = setup();
	t.bridge.onStatus("online");
	t.pend([query("q1", 1)], [sess("s1", "waiting")]);
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 0 });
	assert.equal(t.hub.of("post").length, 1);
	// The socket drops with the answer still in flight; the watch taps again meanwhile.
	t.bridge.onStatus("offline");
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 0 });
	t.bridge.onStatus("online");
	const out = t.pend([query("q1", 1)], [sess("s1", "waiting")]);
	assert.equal(out.filter((d) => d.MSG === "home").length, 1);
	assert.equal(out.filter((d) => d.MSG === "query").length, 1);
	assert.equal(out.filter((d) => d.MSG === "query_gone").length, 0);
	t.bridge.onAppMessage({ CMD: "answer", ID: "q1", OK: 0 });
	assert.equal(t.hub.of("post").length, 1, "the answer was posted once");
	// Once the hub applied it, the next frame drops the query.
	t.hub.reply(null, { ok: true });
	assert.ok(t.drain().some((d) => d.MSG === "query_gone" && d.ID === "q1"));
});

test("reconnect re-announces what the watch is showing", () => {
	const t = setup();
	t.bridge.onAppMessage({ CMD: "showing", ID: "q1", SESSION_ID: "s1" });
	assert.deepEqual(t.hub.of("showing")[0], { kind: "showing", queryId: "q1", sessionId: "s1" });
	t.bridge.onAppMessage({ CMD: "showing" });
	assert.deepEqual(t.hub.of("showing")[1], { kind: "showing", queryId: null, sessionId: null });
	t.bridge.onAppMessage({ CMD: "showing", SESSION_ID: "s2" });
	t.bridge.onStatus("online");
	assert.deepEqual(t.hub.of("showing")[3], { kind: "showing", queryId: null, sessionId: "s2" });
});

test("notice frame -> notice dict", () => {
	const t = setup();
	t.bridge.onNotice({ text: "Session closed" });
	assert.deepEqual(t.drain().filter((d) => d.MSG === "notice"), [{ MSG: "notice", NOTICE: "Session closed" }]);
});

test("open fetches the last turn and sends a reply; live text for that session is relayed", () => {
	const t = setup();
	t.pend([], [sess("s1", "done", { title: "Fix tests", updatedAt: new Date(2026, 9, 27, 9, 5).getTime() })]);
	t.bridge.onAppMessage({ CMD: "open", SESSION_ID: "s1" });
	const g = t.hub.of("get")[0];
	assert.equal(g.path, "/api/watch/history?session=s1&limit=6");
	t.hub.reply(null, { turns: [{ i: 3, role: "agent", text: "All green." }], total: 4 });
	t.drain();
	assert.deepEqual(t.last("reply"), { MSG: "reply", SESSION_ID: "s1", LABEL: "Fix tests", TEXT: "All green.", AT: "09:05", STATUS: "d" });
	t.bridge.onText({ sessionId: "s1", text: "typing", streaming: true });
	t.bridge.onText({ sessionId: "other", text: "ignored", streaming: true });
	t.drain();
	assert.equal(t.all("reply").length, 2);
	assert.equal(t.last("reply").TEXT, "typing");
	// Leaving the reply screen stops the relay.
	t.bridge.onAppMessage({ CMD: "showing" });
	t.bridge.onText({ sessionId: "s1", text: "more", streaming: true });
	assert.equal(t.drain().filter((d) => d.MSG === "reply").length, 0);
});

test("continue, stop, model post to the hub; archive drops the row", () => {
	const t = setup();
	t.pend([], [sess("s1", "done"), sess("s2", "done")]);
	t.bridge.onAppMessage({ CMD: "continue", SESSION_ID: "s1" });
	t.bridge.onAppMessage({ CMD: "stop", SESSION_ID: "s1" });
	t.bridge.onAppMessage({ CMD: "model", SESSION_ID: "s1", PROVIDER: "ollama", MODEL_ID: "qwen3" });
	assert.deepEqual(t.hub.of("post").map((c) => [c.path, c.body]), [
		["/api/watch/prompt", { sessionId: "s1", text: "continue" }],
		["/api/watch/abort", { sessionId: "s1" }],
		["/api/watch/model", { sessionId: "s1", provider: "ollama", modelId: "qwen3" }],
	]);
	t.bridge.onAppMessage({ CMD: "archive", SESSION_ID: "s1" });
	assert.deepEqual(t.hub.of("post")[3].body, { sessionId: "s1" });
	assert.equal(t.hub.of("post")[3].path, "/api/watch/archive");
	t.hub.reply(null, { ok: true }, "/api/watch/archive");
	const home = t.drain().filter((d) => d.MSG === "home").pop();
	assert.deepEqual(rowsOf(home).map((r) => r[0]), ["s2"]);
});

test("models fetches the catalogue and sends provider/id/name rows", () => {
	const t = setup();
	t.bridge.onAppMessage({ CMD: "models", SESSION_ID: "s1" });
	assert.equal(t.hub.of("get")[0].path, "/api/watch/models?session=s1");
	t.hub.reply(null, { current: null, models: [{ provider: "ollama", id: "qwen3", name: "Qwen 3" }, { provider: "anthropic", id: "m1", name: "M" }] });
	t.drain();
	assert.deepEqual(t.last("models"), { MSG: "models", SESSION_ID: "s1", LIST: ["ollama", "qwen3", "Qwen 3"].join(US) + RS + ["anthropic", "m1", "M"].join(US) });
});

test("launched with a query code fetches launch-target and sends that query", () => {
	const t = setup();
	t.pend([query("q1", 1), query("q2", 2)], []);
	t.bridge.onAppMessage({ CMD: "launched", CODE: 7 });
	assert.equal(t.hub.of("get")[0].path, "/api/watch/launch-target?code=7");
	t.hub.reply(null, { queryId: "q2" });
	const out = t.drain();
	assert.deepEqual(out.filter((d) => d.MSG === "query" || d.MSG === "query_gone").map((d) => [d.MSG, d.ID]), [["query_gone", "q1"], ["query", "q2"]]);
});

test("launched with a session code (signed 32-bit) fetches launch-target and sends the reply", () => {
	const t = setup();
	t.pend([], [sess("s9", "done", { title: "Nine" })]);
	t.bridge.onAppMessage({ CMD: "launched", CODE: 0x80000003 | 0 });
	assert.equal(t.hub.of("get")[0].path, "/api/watch/launch-target?code=" + 0x80000003);
	t.hub.reply(null, { sessionId: "s9" });
	assert.equal(t.hub.of("get")[1].path, "/api/watch/history?session=s9&limit=6");
	t.hub.reply(null, { turns: [{ i: 0, role: "agent", text: "done it" }], total: 1 });
	t.drain();
	assert.equal(t.last("reply").SESSION_ID, "s9");
	assert.equal(t.last("reply").TEXT, "done it");
});

test("launched with an unknown code (404) sends nothing", () => {
	const t = setup();
	t.bridge.onAppMessage({ CMD: "launched", CODE: 8 });
	const e = new Error("hub answered 404");
	e.status = 404;
	t.hub.reply(e);
	assert.equal(t.drain().length, 0);
});

test("start sends cfg, net and an empty home; settings update cfg; net statuses are filtered", () => {
	const t = setup({ store: { "pi-web.dark": "0" } });
	t.bridge.start();
	const out = t.drain();
	assert.deepEqual(out.map((d) => d.MSG), ["cfg", "net", "home"]);
	assert.equal(out[0].DARK, 0);
	assert.equal(out[1].NET, "connecting");
	assert.equal(out[2].ROWS, "");
	t.bridge.onSettings({ DARK: true });
	t.bridge.onStatus("bogus");
	t.bridge.onStatus("unconfigured");
	const o2 = t.drain();
	assert.deepEqual(o2.map((d) => [d.MSG, d.DARK === undefined ? d.NET : d.DARK]), [["cfg", 1], ["net", "unconfigured"]]);
});

test("a dropped dict is retried once after 500 ms, then given up on", () => {
	const t = setup();
	t.bridge.onNotice({ text: "x" });
	t.fail();
	assert.deepEqual(t.timers.pending(), [500]);
	t.timers.fire(0);
	t.fail();
	assert.equal(t.timers.pending().length, 0);
	assert.ok(t.logs.some((m) => /drop notice/.test(m)));
});

test("open shows the last agent turn, not a trailing tool or you line", () => {
	const t = setup();
	t.pend([], [sess("s1", "done")]);
	t.bridge.onAppMessage({ CMD: "open", SESSION_ID: "s1" });
	t.hub.reply(null, { turns: [{ i: 0, role: "agent", text: "earlier" }, { i: 1, role: "agent", text: "the answer" }, { i: 2, role: "tool", text: "bash · ls" }, { i: 3, role: "you", text: "thanks" }], total: 4 });
	t.drain();
	assert.equal(t.last("reply").TEXT, "the answer");
	t.bridge.onAppMessage({ CMD: "open", SESSION_ID: "s1" });
	t.hub.reply(null, { turns: [{ i: 0, role: "you", text: "hi" }], total: 1 });
	t.drain();
	assert.equal(t.last("reply").TEXT, "");
});

test("an open reply follows its session's status and time", () => {
	const t = setup();
	t.pend([], [sess("s1", "running")]);
	t.bridge.onAppMessage({ CMD: "open", SESSION_ID: "s1" });
	t.hub.reply(null, { turns: [{ i: 0, role: "agent", text: "working" }], total: 1 });
	t.drain();
	assert.equal(t.last("reply").STATUS, "r");
	const at = new Date(2026, 9, 27, 14, 2).getTime();
	const out = t.pend([], [sess("s1", "done", { updatedAt: at })]);
	const r = out.filter((d) => d.MSG === "reply");
	assert.equal(r.length, 1);
	assert.equal(r[0].STATUS, "d");
	assert.equal(r[0].AT, "14:02");
	assert.equal(r[0].TEXT, "working");
	// Unchanged frames send nothing more.
	assert.equal(t.pend([], [sess("s1", "done", { updatedAt: at })]).filter((d) => d.MSG === "reply").length, 0);
});

test("a reply of 600 multibyte characters still fits one dict", () => {
	const t = setup();
	t.pend([], [sess("s1", "done")]);
	t.bridge.onAppMessage({ CMD: "open", SESSION_ID: "s1" });
	t.hub.reply(null, { turns: [{ i: 0, role: "agent", text: "中".repeat(700) }], total: 1 });
	t.drain();
	assert.ok(dictBytes(t.last("reply")) <= 1000);
	t.bridge.onText({ sessionId: "s1", text: "😀".repeat(300), streaming: true });
	t.drain();
	assert.ok(dictBytes(t.last("reply")) <= 1000);
	assert.ok(t.last("reply").TEXT.length > 0);
});

test("launched before the first pending frame still makes that query current", () => {
	const t = setup();
	t.bridge.start();
	t.drain();
	t.bridge.onAppMessage({ CMD: "launched", CODE: 7 });
	t.hub.reply(null, { queryId: "q2" });
	assert.equal(t.drain().filter((d) => d.MSG === "query").length, 0);
	const out = t.pend([query("q1", 1), query("q2", 2)], []);
	assert.deepEqual(out.filter((d) => d.MSG === "query").map((d) => d.ID), ["q2"]);
	// Once a real frame lacks it, the oldest is current again.
	const o2 = t.pend([query("q1", 1)], []);
	assert.deepEqual(o2.filter((d) => d.MSG === "query" || d.MSG === "query_gone").map((d) => [d.MSG, d.ID]), [["query_gone", "q2"], ["query", "q1"]]);
});
