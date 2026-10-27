import test from "node:test";
import assert from "node:assert/strict";
import { createModel, parseRows, parseOptions, scrollClamp, drawerItems, ellipsize } from "../src/embeddedjs/modules/model.js";

const M = (o) => new Map(Object.entries(o));
const QUERY = { MSG: "query", ID: "q1", SOURCE: "pi", SESSION_ID: "s1", LABEL: "pi · notesky", TEXT: "Allow bash?", OPTIONS: "Allow\x1fAlways allow\x1fDeny", AT: "14:02" };

test("parseRows splits rows and fields", () => {
	assert.deepEqual(parseRows("s1\x1fnotesky sync\x1fw\x1f\x1es2\x1fpi-web watch\x1fr\x1f4:12"), [
		{ id: "s1", title: "notesky sync", status: "w", sub: "" },
		{ id: "s2", title: "pi-web watch", status: "r", sub: "4:12" },
	]);
	assert.deepEqual(parseRows(""), []);
	assert.deepEqual(parseRows(undefined), []);
});

test("parseOptions splits on the field separator", () => {
	assert.deepEqual(parseOptions("Allow\x1fAlways allow\x1fDeny"), ["Allow", "Always allow", "Deny"]);
	assert.deepEqual(parseOptions(""), []);
});

test("apply(home) replaces rows", () => {
	const m = createModel();
	assert.deepEqual(m.home, []);
	assert.equal(m.apply(M({ MSG: "home", ROWS: "a\x1fA\x1fd\x1f13:40\x1eb\x1fB\x1fe\x1f" })), "home");
	assert.deepEqual(m.home.map((r) => r.id), ["a", "b"]);
	m.apply(M({ MSG: "home", ROWS: "c\x1fC\x1fr\x1f0:05" }));
	assert.deepEqual(m.home, [{ id: "c", title: "C", status: "r", sub: "0:05" }]);
	m.apply(M({ MSG: "home", ROWS: "" }));
	assert.deepEqual(m.home, []);
});

test("apply(query) then apply(query_gone same id) clears query", () => {
	const m = createModel();
	assert.equal(m.query, null);
	assert.equal(m.apply(M(QUERY)), "query");
	assert.deepEqual(m.query, { id: "q1", source: "pi", sessionId: "s1", label: "pi · notesky", text: "Allow bash?", options: ["Allow", "Always allow", "Deny"], at: "14:02" });
	assert.equal(m.apply(M({ MSG: "query_gone", ID: "q1" })), "query_gone");
	assert.equal(m.query, null);
});

test("query_gone for another id leaves the current query", () => {
	const m = createModel();
	m.apply(M(QUERY));
	assert.equal(m.apply(M({ MSG: "query_gone", ID: "q0" })), null);
	assert.equal(m.query.id, "q1");
});

test("apply(cfg DARK=1) sets dark", () => {
	const m = createModel();
	assert.equal(m.dark, false);
	assert.equal(m.apply(M({ MSG: "cfg", DARK: 1 })), "cfg");
	assert.equal(m.dark, true);
	m.apply(M({ MSG: "cfg", DARK: 0 }));
	assert.equal(m.dark, false);
});

test("apply(net), apply(notice), apply(reply); unknown MSG is no change", () => {
	const m = createModel();
	assert.equal(m.net, "connecting");
	assert.equal(m.apply(M({ MSG: "net", NET: "offline" })), "net");
	assert.equal(m.net, "offline");
	assert.equal(m.apply(M({ MSG: "notice", NOTICE: "Hub unreachable" })), "notice");
	assert.equal(m.notice, "Hub unreachable");
	assert.equal(m.apply(M({ MSG: "reply", SESSION_ID: "s1", LABEL: "pi-web watch", TEXT: "Done.", AT: "14:01", STATUS: "d" })), "reply");
	assert.deepEqual(m.reply, { sessionId: "s1", label: "pi-web watch", text: "Done.", at: "14:01", status: "d" });
	assert.equal(m.apply(M({ MSG: "bogus" })), null);
	assert.equal(m.apply(M({})), null);
});

test("a ring query has no session", () => {
	const m = createModel();
	m.apply(M({ ...QUERY, SOURCE: "ring", SESSION_ID: "" }));
	assert.equal(m.query.sessionId, "");
});

test("apply(models) parses the list for its session", () => {
	const m = createModel();
	assert.equal(m.apply(M({ MSG: "models", SESSION_ID: "s2", LIST: "spark\x1fqwen3\x1fQwen3 30B\x1eanthropic\x1fsonnet\x1fClaude Sonnet" })), "models");
	assert.deepEqual(m.models, { sessionId: "s2", list: [
		{ provider: "spark", id: "qwen3", name: "Qwen3 30B" },
		{ provider: "anthropic", id: "sonnet", name: "Claude Sonnet" },
	] });
	m.apply(M({ MSG: "models", SESSION_ID: "s2", LIST: "" }));
	assert.deepEqual(m.models.list, []);
});

test("scrollClamp stops at content end", () => {
	assert.equal(scrollClamp(40, 300, 200), 40);
	assert.equal(scrollClamp(160, 300, 200), 100);
	assert.equal(scrollClamp(100, 300, 200), 100);
});

test("scrollClamp never negative", () => {
	assert.equal(scrollClamp(-40, 300, 200), 0);
	assert.equal(scrollClamp(40, 100, 200), 0);
	assert.equal(scrollClamp(0, 0, 200), 0);
});

test("drawerItems(query) appends Skip", () => {
	assert.deepEqual(drawerItems("query", ["Allow", "Always allow", "Deny"]), ["Allow", "Always allow", "Deny", "Skip"]);
	assert.deepEqual(drawerItems("query", []), ["Skip"]);
});

test("drawerItems(session) is Continue/Stop/Model/Archive", () => {
	assert.deepEqual(drawerItems("session"), ["Continue", "Stop", "Model", "Archive"]);
});

test("ellipsize keeps text that fits and cuts the rest with an ellipsis", () => {
	const w = (s) => s.length; // one unit per character
	assert.equal(ellipsize("notesky sync", 12, w), "notesky sync");
	assert.equal(ellipsize("notesky sync", 8, w), "notesky\u2026");
	assert.equal(ellipsize("notesky sync", 9, w), "notesky\u2026"); // no space before the ellipsis
	assert.equal(ellipsize("abcdef", 4, w), "abc\u2026");
	assert.equal(ellipsize("abcdef", 0, w), "\u2026");
	assert.equal(ellipsize("", 0, w), "");
});
