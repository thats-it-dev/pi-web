import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionIndex, historyFromText, knownCwds, sessionsDir, summarize } from "../src/sessions.ts";

const line = (o: object) => `${JSON.stringify(o)}\n`;
const header = (id: string, cwd: string, ts = "2026-10-07T01:23:32.125Z") => line({ type: "session", version: 3, id, timestamp: ts, cwd });
const msg = (id: string, parentId: string | null, message: object) => line({ type: "message", id, parentId, timestamp: "2026-10-07T01:23:33.000Z", message });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	provider: "spark",
	model: "qwen3.8-27b",
	usage: { input: 1000, output: 50, cacheRead: 200, cacheWrite: 0, totalTokens: 1250 },
	stopReason,
	timestamp: 2,
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-web-sessions-"));
	const home = join(root, "--home-michael--");
	const site = join(root, "--home-michael-workspace-website--");
	mkdirSync(home);
	mkdirSync(site);
	writeFileSync(
		join(home, "2026-10-07T01-23-32-125Z_aaa.jsonl"),
		header("aaa", "/nonexistent/home") +
			line({ type: "model_change", id: "m1", parentId: null, timestamp: "x", provider: "spark", modelId: "qwen3.6-35b-a3b-sglang" }) +
			msg("s1", "m1", { role: "system", content: "", timestamp: 0 }) +
			msg("u1", "s1", user("How do I reheat a katsu sandwich?")) +
			msg("a1", "u1", assistant("Air fryer, 180C.")) +
			msg("a2", "a1", assistant("partial", "aborted")) +
			line({ type: "session_info", id: "i1", parentId: "a2", timestamp: "x", name: "katsu" }) +
			'{"type":"message","id":"half', // half-written last line
	);
	writeFileSync(join(site, "2026-10-08T00-00-00-000Z_bbb.jsonl"), header("bbb", "/nonexistent/website", "2026-10-08T00:00:00.000Z") + msg("u1", null, user("portfolio?")));
	writeFileSync(join(site, "not-a-session.jsonl"), line({ type: "message", id: "x", parentId: null, message: user("no header") }));
	writeFileSync(join(site, "notes.txt"), "ignore me");
	writeFileSync(join(root, "stray.jsonl"), header("ccc", "/tmp")); // not inside a session subdirectory
	return { root, home, site };
}

test("sessionsDir follows pi's precedence", () => {
	assert.equal(sessionsDir({ PI_CODING_AGENT_SESSION_DIR: "/x/sessions" }, "/home/m"), "/x/sessions");
	assert.equal(sessionsDir({}, "/home/m"), "/home/m/.pi/agent/sessions");
	assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/m"), "/tmp/agent/sessions");
	const agent = mkdtempSync(join(tmpdir(), "pi-web-agent-"));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ sessionDir: "~/pi-sessions" }));
	assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: agent }, "/home/m"), "/home/m/pi-sessions");
});

test("lists valid sessions newest first and skips files without a header", async () => {
	const { root } = fixture();
	const list = await new SessionIndex(root).list();
	assert.deepEqual(list.map((s) => s.id).sort(), ["aaa", "bbb"]);
	const aaa = list.find((s) => s.id === "aaa");
	assert.ok(aaa);
	assert.equal(aaa.cwd, "/nonexistent/home");
	assert.equal(aaa.name, "katsu");
	assert.equal(aaa.firstPrompt, "How do I reheat a katsu sandwich?");
	assert.equal(aaa.userMessages, 1);
	assert.equal(aaa.model, "spark/qwen3.8-27b");
	assert.equal(aaa.contextTokens, 1250); // last non-aborted assistant usage
	assert.equal(aaa.createdAt, Date.parse("2026-10-07T01:23:32.125Z"));
	assert.ok(list[0].updatedAt >= list[1].updatedAt);
});

test("re-parses a session after it changes on disk", async () => {
	const { root, site } = fixture();
	const index = new SessionIndex(root);
	assert.equal((await index.find("bbb"))?.name, null);
	appendFileSync(join(site, "2026-10-08T00-00-00-000Z_bbb.jsonl"), line({ type: "session_info", id: "i9", parentId: "u1", timestamp: "x", name: "portfolio" }));
	assert.equal((await index.find("bbb"))?.name, "portfolio");
	assert.equal(await index.find("nope"), null);
});

test("history follows the active branch and renders compaction and branch summaries", () => {
	const text =
		header("h", "/x") +
		msg("u1", null, user("first")) +
		msg("a1", "u1", assistant("old answer")) +
		msg("a1b", "u1", assistant("branched answer")) + // sibling of a1
		line({ type: "compaction", id: "c1", parentId: "a1b", timestamp: "2026-10-07T02:00:00.000Z", summary: "talked about X", firstKeptEntryId: "a1b", tokensBefore: 50000 }) +
		line({ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-10-07T02:01:00.000Z", fromId: "a1", summary: "tried Y" }) +
		line({ type: "custom_message", id: "x1", parentId: "b1", timestamp: "2026-10-07T02:02:00.000Z", customType: "goal", content: "ship it", display: true }) +
		line({ type: "custom", id: "x2", parentId: "x1", timestamp: "x", customType: "state", data: {} }) +
		msg("u2", "x2", user("second"));
	const roles = historyFromText(text).map((m) => m.role);
	assert.deepEqual(roles, ["user", "assistant", "compactionSummary", "branchSummary", "custom", "user"]);
	const h = historyFromText(text);
	assert.equal((h[1].content as Array<{ text: string }>)[0].text, "branched answer");
	assert.equal(h[2].tokensBefore, 50000);
});

test("a header without a string cwd summarizes with an empty cwd", () => {
	for (const cwd of [undefined, null, 42, { path: "/x" }]) {
		const s = summarize("/f.jsonl", line({ type: "session", version: 3, id: "x", timestamp: "2026-10-07T00:00:00.000Z", cwd }), 5);
		assert.equal(s?.cwd, "", `cwd ${JSON.stringify(cwd)}`);
	}
});

test("knownCwds ranks folders by session count and always includes home", async () => {
	const { root } = fixture();
	const list = await new SessionIndex(root).list();
	const home = mkdtempSync(join(tmpdir(), "pi-web-home-"));
	// Fixture cwds don't exist on this machine, so only the real home survives the existence filter.
	assert.deepEqual(knownCwds(list, home), [home]);
	assert.deepEqual(knownCwds([{ ...list[0], cwd: tmpdir() }, { ...list[1], cwd: tmpdir() }], home), [tmpdir(), home]);
});

test("non-object JSON lines are ignored in listing and history", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-web-junk-"));
	const dir = join(root, "--junk--");
	mkdirSync(dir);
	writeFileSync(
		join(dir, "2026-10-09T00-00-00-000Z_jjj.jsonl"),
		header("jjj", "/nonexistent/junk", "2026-10-09T00:00:00.000Z") +
			"null\n42\n[1,2]\n" +
			msg("u1", null, user("still here")) +
			"null\n" +
			msg("a1", "u1", assistant("yes")),
	);
	const list = await new SessionIndex(root).list();
	assert.deepEqual(list.map((s) => s.id), ["jjj"]);
	assert.equal(list[0].firstPrompt, "still here");
	assert.equal(list[0].userMessages, 1);
	const h = historyFromText(readFileSync(join(dir, "2026-10-09T00-00-00-000Z_jjj.jsonl"), "utf8"));
	assert.deepEqual(h.map((m) => m.role), ["user", "assistant"]);
});

test("message entries without a message object are skipped in history", () => {
	const text =
		header("m", "/x") +
		line({ type: "message", id: "n1", parentId: null, timestamp: "x" }) +
		line({ type: "message", id: "n2", parentId: "n1", timestamp: "x", message: "oops" }) +
		line({ type: "message", id: "n3", parentId: "n2", timestamp: "x", message: null }) +
		msg("u1", "n3", user("ok"));
	const h = historyFromText(text);
	assert.deepEqual(h.map((m) => m.role), ["user"]);
	assert.ok(h.every((m) => typeof m === "object" && m !== null));
});

test("a parentId cycle terminates history", () => {
	const text =
		header("c", "/x") +
		msg("u1", "a1", user("loop")) + // u1 -> a1 -> u1 forms a cycle; a1 is the last entry
		msg("a1", "u1", assistant("loop back"));
	assert.deepEqual(historyFromText(text).map((m) => m.role), ["user", "assistant"]);
});
