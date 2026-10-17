const test = require("node:test");
const assert = require("node:assert/strict");
const { createBridge, selectRequest, selectSession, packRows, packHome, packStats, clean, ageLabel, dictBytes } = require("../src/pkjs/bridge.js");
const { FakeTimers } = require("./support/fakes.js");

const HOUR = 3600 * 1000;
const NOW = 100 * HOUR;

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
	const clock = { t: NOW };
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
		now: () => clock.t,
		log: (m) => logs.push(m),
	});
	const t = {
		bridge,
		hub,
		timers,
		dicts,
		logs,
		store,
		clock,
		inFlight: () => inFlight,
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
		last(msg) {
			for (let i = dicts.length - 1; i >= 0; i--) if (dicts[i].MSG === msg) return dicts[i];
			return null;
		},
		all(msg) {
			return dicts.filter((d) => d.MSG === msg);
		},
	};
	return t;
}

function req(id, kind, sessionId, createdAt, options) {
	return {
		id: id,
		kind: kind,
		sessionId: sessionId,
		sessionTitle: "title " + sessionId,
		tool: kind === "dialog" ? "bash" : "question",
		message: "message for " + id,
		options: options || [],
		method: kind === "dialog" ? "select" : null,
		createdAt: createdAt,
	};
}
const r0 = req("r0", "dialog", "s1", 0, ["yes", "no"]);
const r1 = req("r1", "dialog", "s1", 1, ["allow", "deny"]);
const r2 = req("r2", "finished", "s2", 2);

function session(id, over) {
	return Object.assign(
		{ id: id, title: "title " + id, state: "idle", live: true, model: "qwen3", contextPercent: null, contextTokens: null, contextWindow: null, tps: null, updatedAt: NOW },
		over || {},
	);
}
const s1 = session("s1", { state: "running", contextPercent: 41, contextTokens: 41000, contextWindow: 100000, tps: 62, updatedAt: NOW - 1000 });
const s2 = session("s2", { updatedAt: NOW - 5000 });
const s3 = session("s3", { live: false, updatedAt: NOW - 2 * HOUR });
const SESSIONS = [s1, s2, s3];

function pending(requests, sessions, showing) {
	return { cursor: 1, requests: requests, showing: showing === undefined ? null : showing, sessions: sessions || SESSIONS };
}

test("hello → cfg, net, home in that order, one at a time until acked", () => {
	const t = setup();
	t.bridge.onAppMessage({ CMD: "hello", CMD_ID: 1 });
	assert.equal(t.dicts.length, 1);
	assert.equal(t.dicts[0].MSG, "cfg");
	assert.equal(t.dicts[0].DARK, 1);
	t.ack();
	assert.equal(t.dicts.length, 2);
	assert.equal(t.dicts[1].MSG, "net");
	assert.equal(t.dicts[1].NET, "connecting");
	t.ack();
	assert.equal(t.dicts.length, 3);
	assert.equal(t.dicts[2].MSG, "home");
	assert.equal(t.dicts[2].REQ_ID, "");
	t.ack();
	assert.equal(t.inFlight(), null);
});

test("a pending frame selects the oldest request, reports showing, and sends home + stats", () => {
	const t = setup();
	t.bridge.onPending(pending([r2, r1]));
	t.drain();
	const home = t.last("home");
	assert.equal(home.REQ_ID, "r1");
	assert.equal(home.REQ_KIND, "dialog");
	assert.equal(home.REQ_TOOL, "bash");
	assert.equal(home.REQ_TEXT, "message for r1");
	assert.equal(home.REQ_INDEX, 1);
	assert.equal(home.REQ_COUNT, 2);
	assert.equal(home.REQ_OPTIONS, "allow\ndeny");
	assert.equal(home.SESSION_ID, "s1");
	assert.equal(home.SESSION_TITLE, "title s1");
	assert.deepEqual(t.hub.of("showing"), [{ kind: "showing", requestId: "r1", sessionId: "s1" }]);
	const stats = t.last("stats");
	assert.equal(stats.SESSION_ID, "s1");
	assert.equal(stats.CTX_PERCENT, 41);
	assert.equal(stats.CTX_TOKENS, 41000);
	assert.equal(stats.CTX_WINDOW, 100000);
	assert.equal(stats.TPS, 62);
	assert.equal(stats.MODEL, "qwen3");
	assert.equal(stats.STATE, "running");
	assert.deepEqual(t.bridge.current(), { requestId: "r1", sessionId: "s1" });
});

test("the current request stays current when an older one appears; index and count follow", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2]));
	t.drain();
	t.bridge.onPending(pending([r0, r1, r2], SESSIONS, "r1"));
	t.drain();
	const home = t.last("home");
	assert.equal(home.REQ_ID, "r1");
	assert.equal(home.REQ_INDEX, 2);
	assert.equal(home.REQ_COUNT, 3);
	assert.equal(t.hub.of("showing").length, 1, "showing is not re-reported when nothing changed");
});

test("with nothing current the hub's showing wins over the oldest", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2], SESSIONS, "r2"));
	t.drain();
	assert.equal(t.last("home").REQ_ID, "r2");
	assert.equal(t.last("home").SESSION_ID, "s2");
	assert.equal(selectRequest([r1, r2], "gone", "r2").id, "r2");
	assert.equal(selectRequest([r2, r1], null, "missing").id, "r1");
	assert.equal(selectRequest([r1, r2], "r2", "r1").id, "r2");
	assert.equal(selectRequest([], null, null), null);
});

test("answer ok: POST body, result OK 1, the next request becomes home without waiting for the hub", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2]));
	t.drain();
	t.bridge.onAppMessage({ CMD: "answer", CMD_ID: 5, REQ_ID: "r1", OPTION: "allow" });
	const post = t.hub.of("post")[0];
	assert.equal(post.path, "/api/watch/answer");
	assert.deepEqual(post.body, { requestId: "r1", option: "allow" });
	const before = t.dicts.length;
	t.hub.reply(null, { ok: true }, "/api/watch/answer");
	const sent = t.drain();
	assert.equal(t.dicts.length > before, true);
	assert.equal(sent[0].MSG, "result");
	assert.equal(sent[0].CMD_ID, 5);
	assert.equal(sent[0].OK, 1);
	const home = sent.filter((d) => d.MSG === "home").pop();
	assert.equal(home.REQ_ID, "r2");
	assert.equal(home.REQ_INDEX, 1);
	assert.equal(home.REQ_COUNT, 1);
	assert.deepEqual(t.hub.of("showing").pop(), { kind: "showing", requestId: "r2", sessionId: "s2" });
});

test("answer by TEXT posts text; no_match and gone carry REASON and OPTIONS; a network error is REASON error", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2]));
	t.drain();
	t.bridge.onAppMessage({ CMD: "answer", CMD_ID: 6, REQ_ID: "r1", TEXT: "maybe" });
	assert.deepEqual(t.hub.of("post")[0].body, { requestId: "r1", text: "maybe" });
	t.hub.reply(null, { ok: false, reason: "no_match", options: ["allow", "deny"] });
	t.drain();
	let res = t.last("result");
	assert.equal(res.CMD_ID, 6);
	assert.equal(res.OK, 0);
	assert.equal(res.REASON, "no_match");
	assert.equal(res.OPTIONS, "allow\ndeny");
	assert.equal(t.bridge.current().requestId, "r1", "no_match keeps the request current");

	t.bridge.onAppMessage({ CMD: "answer", CMD_ID: 7, REQ_ID: "r1", OPTION: "allow" });
	t.hub.reply(new Error("network error"));
	t.drain();
	res = t.last("result");
	assert.equal(res.CMD_ID, 7);
	assert.equal(res.OK, 0);
	assert.equal(res.REASON, "error");
	assert.equal(t.bridge.current().requestId, "r1");

	t.bridge.onAppMessage({ CMD: "answer", CMD_ID: 8, REQ_ID: "r1", OPTION: "allow" });
	t.hub.reply(null, { ok: false, reason: "gone" });
	const sent = t.drain();
	res = t.last("result");
	assert.equal(res.CMD_ID, 8);
	assert.equal(res.REASON, "gone");
	assert.equal(res.OPTIONS, "");
	assert.equal(sent.filter((d) => d.MSG === "home").pop().REQ_ID, "r2", "gone moves on");
});

test("dismiss and prompt post their bodies and answer with a result", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2]));
	t.drain();
	t.bridge.onAppMessage({ CMD: "dismiss", CMD_ID: 9, REQ_ID: "r1" });
	assert.equal(t.hub.of("post")[0].path, "/api/watch/dismiss");
	assert.deepEqual(t.hub.of("post")[0].body, { requestId: "r1" });
	t.hub.reply(null, { ok: true });
	t.drain();
	assert.equal(t.last("result").CMD_ID, 9);
	assert.equal(t.last("home").REQ_ID, "r2");

	t.bridge.onAppMessage({ CMD: "prompt", CMD_ID: 10, SESSION_ID: "s2", TEXT: "go on" });
	assert.equal(t.hub.of("post")[1].path, "/api/watch/prompt");
	assert.deepEqual(t.hub.of("post")[1].body, { sessionId: "s2", text: "go on" });
	t.hub.reply(null, { ok: true });
	t.drain();
	assert.equal(t.last("result").CMD_ID, 10);
	assert.equal(t.last("result").OK, 1);
});

test("model posts provider and id; a 409 is REASON error", () => {
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	t.bridge.onAppMessage({ CMD: "model", CMD_ID: 11, SESSION_ID: "s1", PROVIDER: "local", MODEL_ID: "qwen3-30b" });
	const post = t.hub.of("post")[0];
	assert.equal(post.path, "/api/watch/model");
	assert.deepEqual(post.body, { sessionId: "s1", provider: "local", modelId: "qwen3-30b" });
	const e = new Error("hub answered 409");
	e.status = 409;
	t.hub.reply(e);
	t.drain();
	assert.equal(t.last("result").OK, 0);
	assert.equal(t.last("result").REASON, "error");
});

test("a request answered elsewhere disappears from the next frame: home moves on (Review Focus 1)", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2]));
	t.drain();
	assert.equal(t.last("home").REQ_ID, "r1");
	t.bridge.onPending(pending([r2], SESSIONS, null));
	t.drain();
	assert.equal(t.last("home").REQ_ID, "r2");
	assert.equal(t.last("home").REQ_COUNT, 1);
	t.bridge.onPending(pending([], SESSIONS, null));
	t.drain();
	assert.equal(t.last("home").REQ_ID, "");
	assert.equal(t.last("home").REQ_COUNT, 0);
});

test("nothing pending: home carries the current session by the lastSession rule and TEXT from history", () => {
	const t = setup({ store: { "pi-web.lastSession": "s2" } });
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	let home = t.last("home");
	assert.equal(home.REQ_ID, "");
	assert.equal(home.SESSION_ID, "s2");
	assert.equal(home.STATE, "idle");
	assert.equal(home.TEXT, "");
	assert.deepEqual(t.hub.of("showing").pop(), { kind: "showing", requestId: null, sessionId: "s2" });
	const get = t.hub.of("get")[0];
	assert.equal(get.path, "/api/watch/history?session=s2&limit=4");
	t.hub.reply(null, {
		turns: [
			{ i: 6, role: "agent", text: "an older reply" },
			{ i: 7, role: "you", text: "and then?" },
			{ i: 8, role: "agent", text: "the last reply" },
			{ i: 9, role: "tool", text: "bash ls" },
		],
		total: 10,
	});
	t.drain();
	home = t.last("home");
	assert.equal(home.SESSION_ID, "s2");
	assert.equal(home.TEXT, "the last reply");
	// The next frame does not fetch again.
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	assert.equal(t.hub.of("get").length, 1);
});

test("home STATE is closed for a closed session and TEXT is clipped to 240", () => {
	const t = setup({ store: { "pi-web.lastSession": "s3" } });
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	assert.equal(t.last("home").STATE, "closed");
	t.hub.reply(null, { turns: [{ i: 0, role: "agent", text: "x".repeat(300) }], total: 1 });
	t.drain();
	assert.equal(t.last("home").TEXT.length, 240);
});

test("text frames for the current session → text dicts; for another session → dropped (Review Focus 5)", () => {
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	assert.equal(t.bridge.current().sessionId, "s1");
	t.bridge.onText({ sessionId: "s2", text: "not for us", streaming: true });
	assert.equal(t.drain().length, 0);
	t.bridge.onText({ sessionId: "s1", text: "half a rep", streaming: true });
	let sent = t.drain();
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0], { MSG: "text", SESSION_ID: "s1", TEXT: "half a rep", STREAMING: 1 });
	t.bridge.onText({ sessionId: "s1", text: "half a reply.", streaming: false });
	sent = t.drain();
	assert.deepEqual(sent[0], { MSG: "text", SESSION_ID: "s1", TEXT: "half a reply.", STREAMING: 0 });
	// The finished reply is the cached last reply: home carries it and no history fetch is needed for s1 later.
	t.bridge.onAppMessage({ CMD: "hello", CMD_ID: 1 });
	t.drain();
	assert.equal(t.last("home").TEXT, "half a reply.");
});

test("coalescing: three text frames before an ack leave one queued text dict, the latest", () => {
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	t.bridge.onText({ sessionId: "s1", text: "a", streaming: true });
	t.bridge.onText({ sessionId: "s1", text: "ab", streaming: true });
	t.bridge.onText({ sessionId: "s1", text: "abc", streaming: true });
	const sent = t.drain();
	assert.deepEqual(
		sent.map((d) => d.TEXT),
		["a", "abc"],
	);
});

test("results and lists are FIFO, never coalesced", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2]));
	t.drain();
	t.bridge.onAppMessage({ CMD: "prompt", CMD_ID: 20, SESSION_ID: "s1", TEXT: "a" });
	t.bridge.onAppMessage({ CMD: "prompt", CMD_ID: 21, SESSION_ID: "s1", TEXT: "b" });
	t.bridge.onText({ sessionId: "s1", text: "x", streaming: true }); // goes in flight first
	t.hub.reply(null, { ok: true }, "/api/watch/prompt");
	t.hub.reply(null, { ok: true }, "/api/watch/prompt");
	const sent = t.drain();
	assert.deepEqual(
		sent.filter((d) => d.MSG === "result").map((d) => d.CMD_ID).sort(),
		[20, 21],
	);
});

test("a failed send is retried once after 500 ms, then dropped and logged", () => {
	const t = setup();
	t.bridge.onAppMessage({ CMD: "hello", CMD_ID: 1 });
	assert.equal(t.dicts.length, 1);
	t.fail();
	assert.deepEqual(t.timers.pending(), [500]);
	assert.equal(t.dicts.length, 1, "nothing sent while waiting to retry");
	t.timers.fire();
	assert.equal(t.dicts.length, 2);
	assert.equal(t.dicts[1].MSG, "cfg");
	t.fail();
	assert.equal(t.dicts.length, 3);
	assert.equal(t.dicts[2].MSG, "net", "dropped after the retry; the next dict goes");
	assert.ok(t.logs.some((l) => /drop/.test(l) && /cfg/.test(l)));
	t.ack();
	assert.equal(t.dicts[3].MSG, "home");
});

test("stats go at most once a second", () => {
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	assert.equal(t.all("stats").length, 1);
	assert.equal(t.last("stats").TPS, 62);
	t.clock.t += 300;
	t.bridge.onPending(pending([], [session("s1", Object.assign({}, s1, { tps: 70 })), s2, s3]));
	t.clock.t += 300;
	t.bridge.onPending(pending([], [session("s1", Object.assign({}, s1, { tps: 75 })), s2, s3]));
	t.drain();
	assert.equal(t.all("stats").length, 1, "held back inside the second");
	assert.deepEqual(t.timers.pending(), [700], "one trailing send, due a second after the last");
	t.clock.t += 400;
	t.timers.fire();
	t.drain();
	assert.equal(t.all("stats").length, 2);
	assert.equal(t.last("stats").TPS, 75);
	// Unchanged stats are not resent.
	t.clock.t += 2000;
	t.bridge.onPending(pending([], [session("s1", Object.assign({}, s1, { tps: 75 })), s2, s3]));
	t.drain();
	assert.equal(t.all("stats").length, 2);
});

test("packRows: chunks under 1000 bytes, rows never split, oversize row alone, MORE on all but the last", () => {
	const rows = [];
	for (let i = 0; i < 12; i++) rows.push(i + "\tagent\t" + "é".repeat(120)); // 240 bytes of text each
	const chunks = packRows(rows, 1000);
	assert.ok(chunks.length > 1);
	for (const c of chunks) assert.ok(Buffer.byteLength(c, "utf8") <= 1000);
	assert.deepEqual(chunks.join("\n").split("\n"), rows, "no row split or lost");
	const big = "x".repeat(1500);
	const mixed = packRows(["a", big, "b"], 1000);
	assert.deepEqual(mixed, ["a", big, "b"]);
	assert.deepEqual(packRows([], 1000), []);
	assert.deepEqual(packRows(["a", "b"], 1000), ["a\nb"]);

	// Through the bridge: a history page of 12 turns of 240 chars is chunked with MORE and OFFSET.
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 2, LIST: "history", SESSION_ID: "s1", OFFSET: -1 });
	const turns = [];
	for (let i = 28; i < 40; i++) turns.push({ i: i, role: i % 2 ? "agent" : "you", text: "y".repeat(240) });
	t.hub.reply(null, { turns: turns, total: 40 }, "/api/watch/history?session=s1&limit=12");
	const lists = t.drain().filter((d) => d.MSG === "list");
	assert.ok(lists.length > 1);
	lists.forEach((d, n) => {
		assert.equal(d.MORE, n === lists.length - 1 ? 0 : 1);
		assert.ok(Buffer.byteLength(d.ROWS, "utf8") < 1000);
		assert.equal(d.OFFSET, Number(d.ROWS.split("\n")[0].split("\t")[0]));
	});
});

test("page history → GET history?session=&before=&limit=12, list dicts with OFFSET = first row's i", () => {
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 2, LIST: "history", SESSION_ID: "s1", OFFSET: -1 });
	assert.equal(t.hub.of("get").pop().path, "/api/watch/history?session=s1&limit=12");
	t.hub.reply(null, { turns: [{ i: 30, role: "you", text: "line\none\tx" }, { i: 31, role: "agent", text: "ok" }], total: 32 });
	let list = t.drain().filter((d) => d.MSG === "list");
	assert.deepEqual(list, [{ MSG: "list", LIST: "history", SESSION_ID: "s1", ROWS: "30\tyou\tline one x\n31\tagent\tok", OFFSET: 30, TOTAL: 32, MORE: 0 }]);

	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 3, LIST: "history", SESSION_ID: "s1", OFFSET: 30 });
	assert.equal(t.hub.of("get").pop().path, "/api/watch/history?session=s1&before=30&limit=12");
	t.hub.reply(null, { turns: [], total: 32 });
	list = t.drain().filter((d) => d.MSG === "list");
	assert.deepEqual(list, [{ MSG: "list", LIST: "history", SESSION_ID: "s1", ROWS: "", OFFSET: 0, TOTAL: 32, MORE: 0 }]);
});

test("page models → GET models?session=, rows provider\\tid\\tname\\tcurrent", () => {
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 4, LIST: "models", SESSION_ID: "s1" });
	assert.equal(t.hub.of("get").pop().path, "/api/watch/models?session=s1");
	t.hub.reply(null, {
		current: { provider: "local", id: "b", name: "B" },
		models: [
			{ provider: "local", id: "a", name: "A" },
			{ provider: "local", id: "b", name: "B" },
		],
	});
	const list = t.drain().filter((d) => d.MSG === "list");
	assert.equal(list.length, 1);
	assert.equal(list[0].LIST, "models");
	assert.equal(list[0].ROWS, "local\ta\tA\t0\nlocal\tb\tB\t1");
	assert.equal(list[0].TOTAL, 2);
	assert.equal(list[0].OFFSET, 0);
});

test("a failed page fetch sends an empty list with TOTAL -1", () => {
	const t = setup();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 4, LIST: "models", SESSION_ID: "s3" });
	const e = new Error("hub answered 404");
	e.status = 404;
	t.hub.reply(e);
	const list = t.drain().filter((d) => d.MSG === "list");
	assert.deepEqual(list, [{ MSG: "list", LIST: "models", SESSION_ID: "s3", ROWS: "", OFFSET: 0, TOTAL: -1, MORE: 0 }]);
});

test("page sessions comes from the stored frame with no fetch; rows are id\\ttitle\\tstate\\tlive\\tmodel\\tctx\\tage", () => {
	const t = setup();
	t.bridge.onPending(pending([], [s1, s2, session("s3", { live: false, updatedAt: NOW - 2 * HOUR, title: "two\nlines" })]));
	t.drain();
	const gets = t.hub.of("get").length;
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 3, LIST: "sessions" });
	assert.equal(t.hub.of("get").length, gets);
	const list = t.drain().filter((d) => d.MSG === "list");
	assert.equal(list.length, 1);
	assert.equal(list[0].LIST, "sessions");
	assert.equal(list[0].TOTAL, 3);
	assert.equal(list[0].OFFSET, 0);
	assert.equal(list[0].MORE, 0);
	assert.deepEqual(list[0].ROWS.split("\n"), ["s1\ttitle s1\trunning\t1\tqwen3\t41\t-", "s2\ttitle s2\tidle\t1\tqwen3\t-\t-", "s3\ttwo lines\tclosed\t0\tqwen3\t-\t2h"]);
});

test("show by SESSION_ID switches current, reports showing(null, s), sends home + stats; show by REQ_ID selects that request", () => {
	const t = setup();
	t.bridge.onPending(pending([r1, r2]));
	t.drain();
	t.bridge.onAppMessage({ CMD: "show", CMD_ID: 3, SESSION_ID: "s3" });
	const sent = t.drain();
	assert.deepEqual(t.hub.of("showing").pop(), { kind: "showing", requestId: null, sessionId: "s3" });
	const home = sent.filter((d) => d.MSG === "home").pop();
	assert.equal(home.REQ_ID, "");
	assert.equal(home.SESSION_ID, "s3");
	assert.equal(home.STATE, "closed");
	assert.equal(sent.filter((d) => d.MSG === "stats").pop().SESSION_ID, "s3");
	assert.equal(t.store["pi-web.lastSession"], "s3");
	// The next frame with the same requests keeps the chosen session.
	t.bridge.onPending(pending([r1, r2], SESSIONS, null));
	t.drain();
	assert.equal(t.last("home").SESSION_ID, "s3");
	assert.equal(t.last("home").REQ_ID, "");
	// A new request takes over again.
	const r3 = req("r3", "error", "s2", 3);
	t.bridge.onPending(pending([r1, r2, r3], SESSIONS, null));
	t.drain();
	assert.equal(t.last("home").REQ_ID, "r1");

	t.bridge.onAppMessage({ CMD: "show", CMD_ID: 4, REQ_ID: "r2" });
	t.drain();
	assert.equal(t.last("home").REQ_ID, "r2");
	assert.equal(t.last("home").REQ_INDEX, 2);
	assert.deepEqual(t.hub.of("showing").pop(), { kind: "showing", requestId: "r2", sessionId: "s2" });
});

test("status → net dict; going online after offline re-reports showing (Review Focus 2)", () => {
	const t = setup();
	t.bridge.onStatus("connecting");
	t.drain();
	assert.equal(t.last("net").NET, "connecting");
	t.bridge.onStatus("online");
	t.bridge.onPending(pending([r1]));
	t.drain();
	assert.equal(t.last("net").NET, "online");
	const n = t.hub.of("showing").length;
	t.bridge.onStatus("offline");
	t.drain();
	assert.equal(t.last("net").NET, "offline");
	t.bridge.onStatus("online");
	t.drain();
	assert.equal(t.last("net").NET, "online");
	assert.equal(t.hub.of("showing").length, n + 1);
	assert.deepEqual(t.hub.of("showing").pop(), { kind: "showing", requestId: "r1", sessionId: "s1" });
	t.bridge.onStatus("unconfigured");
	t.drain();
	assert.equal(t.last("net").NET, "unconfigured");
});

test("settings → cfg dict with DARK; setHub replaces the hub", () => {
	const t = setup();
	t.bridge.onSettings({ HUB_URL: "https://h:7878", DARK: false });
	t.drain();
	assert.deepEqual(t.last("cfg"), { MSG: "cfg", DARK: 0 });
	t.bridge.onSettings({ DARK: 1 });
	t.drain();
	assert.deepEqual(t.last("cfg"), { MSG: "cfg", DARK: 1 });
	const other = new FakeHub();
	t.bridge.setHub(other);
	t.bridge.onPending(pending([r1]));
	t.drain();
	assert.equal(other.of("showing").length, 1);
});

test("start sends cfg, net and home so a watch that is already open gets state", () => {
	const t = setup({ store: { "pi-web.dark": "0" } });
	t.bridge.start();
	const sent = t.drain();
	assert.deepEqual(
		sent.map((d) => d.MSG),
		["cfg", "net", "home"],
	);
	assert.equal(sent[0].DARK, 0);
});

test("selectSession: last if listed, else newest live, else newest closed; clean() strips tabs and newlines", () => {
	assert.equal(selectSession(SESSIONS, "s3").id, "s3");
	assert.equal(selectSession(SESSIONS, "nope").id, "s1");
	assert.equal(selectSession([s2, s1], null).id, "s1");
	const c1 = session("c1", { live: false, updatedAt: 5 });
	const c2 = session("c2", { live: false, updatedAt: 9 });
	assert.equal(selectSession([c1, c2], null).id, "c2");
	assert.equal(selectSession([], "s1"), null);
	assert.equal(clean("  a\tb\nc\r\nd  "), "a b c  d");
	assert.equal(clean(null), "");
	assert.equal(ageLabel(5 * 60 * 1000), "5m");
	assert.equal(ageLabel(2 * HOUR + 1000), "2h");
	assert.equal(ageLabel(3 * 24 * HOUR), "3d");
	assert.equal(ageLabel(-5), "0m");
});

test("packHome and packStats with nothing known use empty strings and -1", () => {
	const home = packHome(null, 0, 0, null, "");
	assert.equal(home.MSG, "home");
	assert.equal(home.REQ_ID, "");
	assert.equal(home.SESSION_ID, "");
	assert.equal(home.REQ_COUNT, 0);
	const stats = packStats(session("x", { model: null }));
	assert.deepEqual(stats, { MSG: "stats", SESSION_ID: "x", STATE: "idle", MODEL: "", CTX_PERCENT: -1, CTX_TOKENS: -1, CTX_WINDOW: -1, TPS: -1 });
	const h2 = packHome(Object.assign({}, r1, { message: "a\nb" + "z".repeat(300), options: ["x\ty", "z"] }), 1, 1, s1, "t");
	assert.equal(h2.REQ_TEXT.length, 240);
	assert.equal(h2.REQ_TEXT.slice(0, 3), "a\nb", "request text keeps its newlines");
	assert.equal(h2.REQ_OPTIONS, "x y\nz");
	assert.equal(h2.TEXT, "t");
});

test("the last reply is refetched when the session becomes current again; a failed fetch is not cached", () => {
	const t = setup();
	const historyGets = () => t.hub.of("get").filter((c) => c.path.indexOf("/api/watch/history?session=s1&limit=4") === 0);
	const show = (sid) => t.bridge.onAppMessage({ CMD: "show", CMD_ID: 1, SESSION_ID: sid });
	t.bridge.onPending(pending([], SESSIONS)); // s1 current
	t.hub.reply(null, { turns: [{ i: 0, role: "agent", text: "reply A" }], total: 1 });
	t.drain();
	assert.equal(t.last("home").TEXT, "reply A");
	show("s2");
	t.hub.reply(null, { turns: [], total: 0 }, "/api/watch/history?session=s2");
	t.drain();
	assert.equal(t.bridge.current().sessionId, "s2");
	show("s1");
	assert.equal(historyGets().length, 2, "switching back fetches again");
	t.drain();
	assert.equal(t.last("home").TEXT, "", "the stale reply A is not shown");
	t.hub.reply(null, { turns: [{ i: 1, role: "agent", text: "reply B" }], total: 2 });
	t.drain();
	assert.equal(t.last("home").TEXT, "reply B");

	// A failed fetch, then a re-switch: fetch again.
	show("s2");
	t.hub.reply(null, { turns: [], total: 0 }, "/api/watch/history?session=s2");
	show("s1");
	assert.equal(historyGets().length, 3);
	t.hub.reply(new Error("network error"));
	t.drain();
	t.bridge.onPending(pending([], SESSIONS));
	t.drain();
	assert.equal(historyGets().length, 3, "no retry on every frame while current");
	show("s2");
	t.hub.reply(null, { turns: [], total: 0 }, "/api/watch/history?session=s2");
	show("s1");
	assert.equal(historyGets().length, 4, "a failed fetch is retried on the next switch");
});

test("a final text frame for a non-current session is cached (no dict) and saves the fetch on switching", () => {
	const t = setup();
	t.bridge.onPending(pending([r2], SESSIONS)); // s2 current
	t.drain();
	const before = t.dicts.length;
	t.bridge.onText({ sessionId: "s1", text: "finished elsewhere", streaming: false });
	t.bridge.onText({ sessionId: "s1", text: "streaming elsewhere", streaming: true });
	assert.equal(t.dicts.length, before, "no text dict for a non-current session");
	const gets = t.hub.of("get").length;
	t.bridge.onAppMessage({ CMD: "show", CMD_ID: 1, SESSION_ID: "s1" });
	t.drain();
	assert.equal(t.hub.of("get").length, gets, "no fetch: a final frame arrived while away");
	assert.equal(t.last("home").SESSION_ID, "s1");
	assert.equal(t.last("home").TEXT, "finished elsewhere");
});

test("dictBytes follows the Pebble cost model; every list dict fits 1000 bytes, even with a 36-char session id", () => {
	assert.equal(dictBytes({ A: 1 }), 1 + 7 + 4);
	assert.equal(dictBytes({ A: "ab" }), 1 + 7 + 3);
	assert.equal(dictBytes({ A: "é" }), 1 + 7 + 3);
	const longId = "0123456789abcdef0123456789abcdef0123"; // 36
	const t = setup();
	const longSessions = [session(longId, { title: "t".repeat(200), model: "m".repeat(100) })];
	for (let i = 0; i < 26; i++) longSessions.push(session("c" + i + "-" + longId.slice(0, 30), { live: false, updatedAt: NOW - i * HOUR, title: "é".repeat(80) }));
	t.bridge.onPending(pending([], longSessions));
	t.drain();
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 2, LIST: "history", SESSION_ID: longId, OFFSET: -1 });
	const turns = [];
	for (let i = 28; i < 40; i++) turns.push({ i: i, role: "agent", text: "é".repeat(240) });
	t.hub.reply(null, { turns: turns, total: 40 }, "/api/watch/history?session=" + longId + "&limit=12");
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 3, LIST: "sessions" });
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 4, LIST: "models", SESSION_ID: longId });
	const models = [];
	for (let i = 0; i < 30; i++) models.push({ provider: "provider" + i, id: "model-id-" + i + "-" + "x".repeat(40), name: "N".repeat(90) });
	t.hub.reply(null, { current: null, models: models }, "/api/watch/models");
	const lists = t.drain().filter((d) => d.MSG === "list");
	assert.ok(lists.filter((d) => d.LIST === "history").length > 1);
	assert.ok(lists.filter((d) => d.LIST === "sessions").length > 1);
	assert.ok(lists.filter((d) => d.LIST === "models").length > 1);
	for (const d of lists) assert.ok(dictBytes(d) <= 1000, d.LIST + " dict is " + dictBytes(d) + " bytes");
	// Rows survive whole across chunks.
	const hist = lists.filter((d) => d.LIST === "history");
	assert.equal(hist.map((d) => d.ROWS).join("\n").split("\n").length, 12);
});

test("titles clip to 60 and model names to 40 in rows, home and stats", () => {
	const t = setup();
	const longS = session("s1", { title: "T".repeat(100), model: "M".repeat(100) });
	t.bridge.onPending(pending([], [longS]));
	t.drain();
	assert.equal(t.last("home").SESSION_TITLE.length, 60);
	assert.equal(t.last("stats").MODEL.length, 40);
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 3, LIST: "sessions" });
	const row = t.drain().filter((d) => d.MSG === "list")[0].ROWS.split("\t");
	assert.equal(row[1].length, 60);
	assert.equal(row[4].length, 40);
	t.bridge.onAppMessage({ CMD: "page", CMD_ID: 4, LIST: "models", SESSION_ID: "s1" });
	t.hub.reply(null, { current: null, models: [{ provider: "p", id: "i", name: "N".repeat(100) }] }, "/api/watch/models");
	const mrow = t.drain().filter((d) => d.MSG === "list")[0].ROWS.split("\t");
	assert.equal(mrow[2].length, 40);
	const h = packHome(Object.assign({}, r1, { sessionTitle: "x".repeat(100), tool: "y".repeat(100) }), 1, 1, null, "");
	assert.equal(h.SESSION_TITLE.length, 60);
	assert.equal(h.REQ_TOOL.length, 40);
});
