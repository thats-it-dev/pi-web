import test from "node:test";
import assert from "node:assert/strict";
import { createModel, parseRows, homeRows } from "../src/embeddedjs/modules/model.js";

const M = (o) => new Map(Object.entries(o));

test("apply(home) → home with options split and lastText; REQ_ID '' → requestId null", () => {
	const m = createModel();
	assert.equal(m.home, null);
	const kind = m.apply(M({ MSG: "home", REQ_ID: "r1", REQ_KIND: "dialog", REQ_TOOL: "bash", REQ_TEXT: "Allow?", REQ_OPTIONS: "allow\ndeny", REQ_INDEX: 1, REQ_COUNT: 2, SESSION_ID: "s1", SESSION_TITLE: "Title", TEXT: "last" }));
	assert.equal(kind, "home");
	assert.deepEqual(m.home, { requestId: "r1", kind: "dialog", tool: "bash", text: "Allow?", options: ["allow", "deny"], index: 1, count: 2, sessionId: "s1", sessionTitle: "Title", lastText: "last" });
	m.apply(M({ MSG: "home", REQ_ID: "", REQ_KIND: "", REQ_TOOL: "", REQ_TEXT: "", REQ_OPTIONS: "", REQ_INDEX: 0, REQ_COUNT: 0, SESSION_ID: "s1", SESSION_TITLE: "T", TEXT: "" }));
	assert.equal(m.home.requestId, null);
	assert.deepEqual(m.home.options, []);
	assert.equal(m.apply(M({ MSG: "bogus" })), null);
});

test("apply(stats) maps -1 to null; apply(text), apply(net), apply(cfg)", () => {
	const m = createModel();
	assert.equal(m.net, "connecting");
	assert.equal(m.apply(M({ MSG: "stats", SESSION_ID: "s", STATE: "idle", MODEL: "qwen3", CTX_PERCENT: 41, CTX_TOKENS: -1, CTX_WINDOW: 128000, TPS: -1 })), "stats");
	assert.deepEqual(m.stats, { sessionId: "s", state: "idle", model: "qwen3", ctxPercent: 41, ctxTokens: null, ctxWindow: 128000, tps: null });
	assert.equal(m.apply(M({ MSG: "text", SESSION_ID: "s", TEXT: "hi", STREAMING: 1 })), "text");
	assert.deepEqual(m.text, { sessionId: "s", text: "hi", streaming: true });
	assert.equal(m.apply(M({ MSG: "net", NET: "online" })), "net");
	assert.equal(m.net, "online");
	assert.equal(m.apply(M({ MSG: "cfg", DARK: 1 })), "cfg");
	assert.deepEqual(m.cfg, { dark: true });
});

const hist = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => `${a + k}\tyou\ttext ${a + k}`).join("\n");

test("list chunks merge by OFFSET without duplicates; complete when MORE is 0; resetList clears", () => {
	const m = createModel();
	m.apply(M({ MSG: "list", LIST: "history", ROWS: hist(28, 33), OFFSET: 28, TOTAL: 40, MORE: 1 }));
	assert.equal(m.lists.history.complete, false);
	m.apply(M({ MSG: "list", LIST: "history", ROWS: hist(34, 39), OFFSET: 34, TOTAL: 40, MORE: 0 }));
	assert.equal(m.lists.history.rows.length, 12);
	assert.equal(m.lists.history.complete, true);
	assert.equal(m.lists.history.total, 40);
	assert.deepEqual([0, 1].map((k) => m.rowAt("history", k).i), [28, 29]);
	m.apply(M({ MSG: "list", LIST: "history", ROWS: hist(28, 33), OFFSET: 28, TOTAL: 40, MORE: 1 }));
	assert.equal(m.lists.history.rows.length, 12);
	m.resetList("history");
	assert.deepEqual(m.lists.history, { rows: [], total: 0, complete: false });
	m.apply(M({ MSG: "list", LIST: "sessions", ROWS: "", OFFSET: 0, TOTAL: 0, MORE: 0 }));
	assert.equal(m.lists.sessions.complete, true);
	assert.equal(m.lists.sessions.rows.length, 0);
});

test("history keeps at most 24 turns: prepending an older page drops the newest beyond 24", () => {
	const m = createModel();
	const page = (a, b) => m.apply(M({ MSG: "list", LIST: "history", ROWS: hist(a, b), OFFSET: a, TOTAL: 40, MORE: 0 }));
	const is = () => m.lists.history.rows.map((_, k) => m.rowAt("history", k).i);
	page(28, 39);
	assert.equal(m.lists.history.earliest, 28);
	page(16, 27);
	assert.equal(m.lists.history.rows.length, 24);
	assert.deepEqual(is(), Array.from({ length: 24 }, (_, k) => 16 + k));
	page(4, 15);
	assert.deepEqual(is(), Array.from({ length: 24 }, (_, k) => 4 + k));
	assert.equal(m.lists.history.earliest, 4);
	assert.deepEqual(m.rowAt("history", 0), { i: 4, role: "you", text: "text 4" });
});

test("takeResult returns a result once", () => {
	const m = createModel();
	m.apply(M({ MSG: "result", CMD_ID: "c1", OK: 0, REASON: "no_match", OPTIONS: "a\nb" }));
	assert.deepEqual(m.takeResult("c1"), { ok: false, reason: "no_match", options: ["a", "b"] });
	assert.equal(m.takeResult("c1"), null);
	assert.equal(m.takeResult("zz"), null);
});

test("results keep only the newest 4", () => {
	const m = createModel();
	for (let c = 1; c <= 6; c++) m.apply(M({ MSG: "result", CMD_ID: c, OK: 1 }));
	assert.deepEqual([1, 2, 3, 4, 5, 6].map((c) => m.takeResult(c) !== null), [false, false, true, true, true, true]);
});

test("sayIt via setSayIt", () => {
	const m = createModel();
	assert.deepEqual(m.sayIt, { text: "", status: "idle" });
	m.setSayIt({ status: "listening" });
	m.setSayIt({ text: "hello" });
	assert.deepEqual(m.sayIt, { text: "hello", status: "listening" });
});

test("say-it state: idle → listening → sending(text) → sent; no_match keeps text and options; failed returns to idle rows", () => {
	const m = createModel();
	const home = { requestId: "r1", kind: "dialog", options: ["allow", "deny"] };
	assert.equal(m.sayIt.status, "idle");
	m.setSayIt({ status: "listening" });
	assert.equal(m.sayIt.status, "listening");
	m.setSayIt({ status: "sending", text: "yes please", cmdId: 7 });
	assert.deepEqual(homeRows(home, m.sayIt), ["sending…", "say it again"]);
	assert.deepEqual(homeRows(null, m.sayIt), ["sending…", "say it again"]);
	// A result for another command leaves the say-it state alone (and stays for takeResult).
	m.apply(M({ MSG: "result", CMD_ID: 6, OK: 1 }));
	assert.equal(m.sayIt.status, "sending");
	assert.deepEqual(m.takeResult(6), { ok: true, reason: "", options: [] });
	assert.equal(m.apply(M({ MSG: "result", CMD_ID: 7, OK: 1 })), "result");
	assert.equal(m.sayIt.status, "sent");
	assert.equal(m.sayIt.text, "yes please");
	// A late duplicate for the same command does not move a settled state.
	m.setSayIt({ status: "idle", text: "" });
	m.apply(M({ MSG: "result", CMD_ID: 7, OK: 0, REASON: "error" }));
	assert.equal(m.sayIt.status, "idle");

	m.setSayIt({ status: "sending", text: "maybe", cmdId: 8 });
	m.apply(M({ MSG: "result", CMD_ID: 8, OK: 0, REASON: "no_match", OPTIONS: "allow\ndeny" }));
	assert.equal(m.sayIt.status, "no_match");
	assert.equal(m.sayIt.text, "maybe");
	assert.deepEqual(m.sayIt.options, ["allow", "deny"]);
	assert.deepEqual(homeRows(home, m.sayIt), ["allow", "deny", "say it"]);

	m.setSayIt({ status: "sending", text: "x", cmdId: 9 });
	m.apply(M({ MSG: "result", CMD_ID: 9, OK: 0, REASON: "gone" }));
	assert.equal(m.sayIt.status, "gone");

	m.setSayIt({ status: "sending", text: "x", cmdId: 10 });
	m.apply(M({ MSG: "result", CMD_ID: 10, OK: 0, REASON: "error" }));
	assert.equal(m.sayIt.status, "failed");
	assert.deepEqual(homeRows(home, m.sayIt), ["allow", "deny", "say it"]);
	assert.deepEqual(homeRows(null, m.sayIt), ["say it", "menu"]);
	assert.deepEqual(homeRows(home, { status: "idle", text: "" }), ["allow", "deny", "say it"]);
});

test("parseRows per kind; homeRows per kind", () => {
	assert.deepEqual(parseRows("sessions", ["a\tTitle\trunning\t1\tqwen3\t42\t2h", "b\tT2\tclosed\t0\t\t-\t-"]), [
		{ id: "a", title: "Title", state: "running", live: true, model: "qwen3", ctx: 42, age: "2h" },
		{ id: "b", title: "T2", state: "closed", live: false, model: "", ctx: null, age: "-" },
	]);
	assert.deepEqual(parseRows("history", ["3\tagent\thello\tworld"]), [{ i: 3, role: "agent", text: "hello\tworld" }]);
	assert.deepEqual(parseRows("models", ["p\tid1\tName\t1"]), [{ provider: "p", id: "id1", name: "Name", current: true }]);
	assert.deepEqual(homeRows({ kind: "dialog", options: ["allow", "deny"] }), ["allow", "deny", "say it"]);
	assert.deepEqual(homeRows({ kind: "finished", options: [] }), ["say it", "dismiss"]);
	assert.deepEqual(homeRows({ kind: "error", options: [] }), ["say it", "dismiss"]);
	assert.deepEqual(homeRows({ requestId: null, kind: "", options: [] }), ["say it", "menu"]);
	assert.deepEqual(homeRows(null), ["say it", "menu"]);
});

test("sessions and models keep raw lines (parsed by rowAt), chunks land by OFFSET", () => {
	const m = createModel();
	const s = (n) => `s${n}\tT${n}\tidle\t1\tqwen3\t${n}\t1m`;
	m.apply(M({ MSG: "list", LIST: "sessions", ROWS: [s(0), s(1)].join("\n"), OFFSET: 0, TOTAL: 3, MORE: 1 }));
	m.apply(M({ MSG: "list", LIST: "sessions", ROWS: s(2), OFFSET: 2, TOTAL: 3, MORE: 0 }));
	assert.deepEqual(m.lists.sessions.rows, [s(0), s(1), s(2)]);
	assert.deepEqual(m.rowAt("sessions", 2), { id: "s2", title: "T2", state: "idle", live: true, model: "qwen3", ctx: 2, age: "1m" });
	m.apply(M({ MSG: "list", LIST: "sessions", ROWS: s(9), OFFSET: 1, TOTAL: 3, MORE: 0 }));
	assert.deepEqual(m.lists.sessions.rows, [s(0), s(9), s(2)]);
	m.apply(M({ MSG: "list", LIST: "models", ROWS: "p\tid1\tName\t1", OFFSET: 0, TOTAL: 1, MORE: 0 }));
	assert.deepEqual(m.rowAt("models", 0), { provider: "p", id: "id1", name: "Name", current: true });
	assert.equal(m.rowAt("models", 5), undefined);
});

test("a final page shorter than the list truncates it to TOTAL", () => {
	const m = createModel();
	m.apply(M({ MSG: "list", LIST: "models", ROWS: "p\ta\tA\t1\np\tb\tB\t0\np\tc\tC\t0", OFFSET: 0, TOTAL: 3, MORE: 0 }));
	m.apply(M({ MSG: "list", LIST: "models", ROWS: "p\ta\tA\t1", OFFSET: 0, TOTAL: 1, MORE: 0 }));
	assert.equal(m.lists.models.rows.length, 1);
	m.apply(M({ MSG: "list", LIST: "models", ROWS: "", OFFSET: 0, TOTAL: -1, MORE: 0 }));
	assert.equal(m.lists.models.rows.length, 1);
});
