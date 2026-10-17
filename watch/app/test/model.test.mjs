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
	assert.deepEqual(m.lists.history.rows.map((r) => r.i).slice(0, 2), [28, 29]);
	m.apply(M({ MSG: "list", LIST: "history", ROWS: hist(28, 33), OFFSET: 28, TOTAL: 40, MORE: 1 }));
	assert.equal(m.lists.history.rows.length, 12);
	m.resetList("history");
	assert.deepEqual(m.lists.history, { rows: [], total: 0, complete: false });
	m.apply(M({ MSG: "list", LIST: "sessions", ROWS: "", OFFSET: 0, TOTAL: 0, MORE: 0 }));
	assert.equal(m.lists.sessions.complete, true);
	assert.equal(m.lists.sessions.rows.length, 0);
});

test("takeResult returns a result once", () => {
	const m = createModel();
	m.apply(M({ MSG: "result", CMD_ID: "c1", OK: 0, REASON: "no_match", OPTIONS: "a\nb" }));
	assert.deepEqual(m.takeResult("c1"), { ok: false, reason: "no_match", options: ["a", "b"] });
	assert.equal(m.takeResult("c1"), null);
	assert.equal(m.takeResult("zz"), null);
});

test("sayIt via setSayIt", () => {
	const m = createModel();
	assert.deepEqual(m.sayIt, { text: "", status: "idle" });
	m.setSayIt({ status: "listening" });
	m.setSayIt({ text: "hello" });
	assert.deepEqual(m.sayIt, { text: "hello", status: "listening" });
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
