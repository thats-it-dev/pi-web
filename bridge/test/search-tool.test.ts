import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchHit } from "../../shared/src/protocol.ts";
import { formatHits, registerSearchTool } from "../search-tool.ts";

const hit = (o: Partial<SearchHit> = {}): SearchHit => ({
	sessionId: "abc", type: "code", name: null, firstPrompt: "fix the thing", cwd: "/home/m/proj",
	updatedAt: Date.UTC(2026, 10, 20), ordinal: 4, role: "assistant", snippet: "we chose sqlite", terms: ["sqlite"], semanticOnly: false, ...o,
});

test("formatHits renders block and link", () => {
	const out = formatHits([hit(), hit({ sessionId: "z", type: "chat", name: "Named", role: "user", ordinal: 1 })], "https://app.example");
	assert.match(out, /^1\. fix the thing · code · 2026-11-20 · \/home\/m\/proj\n {3}pi: we chose sqlite\n {3}https:\/\/app\.example\/#\/s\/abc\/at\/4/);
	assert.match(out, /2\. Named · chat · .*\n {3}you: /);
	assert.match(out, /https:\/\/app\.example\/#\/s\/z\/at\/1/);
});

test("formatHits without origin and when empty", () => {
	assert.match(formatHits([hit()], null), /\n {3}#\/s\/abc\/at\/4$/);
	assert.equal(formatHits([], null), "No past conversation matches.");
});

function setup(fetchFn: any, env: any = {}) {
	let tool: any;
	registerSearchTool({ registerTool: (t) => (tool = t) }, { fetchFn, env, currentSessionId: () => "cur" });
	return tool;
}

test("tool calls the internal url with exclude and limit", async () => {
	let url = "";
	const tool = setup(async (u: string) => { url = u; return new Response(JSON.stringify({ hits: [hit()], semantic: true })); }, { PI_WEB_INTERNAL_PORT: "9999", PI_WEB_APP_ORIGIN: "https://a" });
	assert.equal(tool.name, "search_sessions");
	const r = await tool.execute("id", { query: "sql lite", limit: 3 }, undefined, undefined, { sessionManager: { getSessionId: () => "cur" } });
	assert.equal(url, "http://127.0.0.1:9999/search?q=sql%20lite&limit=3&exclude=cur");
	assert.match(r.content[0].text, /https:\/\/a\/#\/s\/abc\/at\/4/);
});

test("defaults port/limit and clamps limit", async () => {
	const urls: string[] = [];
	const tool = setup(async (u: string) => { urls.push(u); return new Response(JSON.stringify({ hits: [], semantic: false })); });
	await tool.execute("id", { query: "x" }, undefined, undefined, {});
	await tool.execute("id", { query: "x", limit: 50 }, undefined, undefined, {});
	assert.equal(urls[0], "http://127.0.0.1:7879/search?q=x&limit=5&exclude=cur");
	assert.match(urls[1], /limit=8/);
});

test("hub down gives the friendly line", async () => {
	const tool = setup(async () => { throw new Error("ECONNREFUSED"); });
	const r = await tool.execute("id", { query: "x" }, undefined, undefined, {});
	assert.equal(r.content[0].text, "Session search isn't available right now (the hub didn't answer).");
});

test("non-ok response gives the friendly line", async () => {
	const tool = setup(async () => new Response("no", { status: 500 }));
	const r = await tool.execute("id", { query: "x" }, undefined, undefined, {});
	assert.match(r.content[0].text, /isn't available/);
});
