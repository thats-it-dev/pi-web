import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentMessage, PiEvent } from "../src/protocol.ts";
import { PLAN_PATH_RE, deriveProgress, groupSubagents } from "../src/progress.ts";
import type { SubagentChild } from "../src/progress.ts";
import { applyEvent, createConversation } from "../src/reducer.ts";
import { historyFromText } from "../src/session-file.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/progress/${name}`, import.meta.url), "utf8");
const conv = (name: string) => createConversation(historyFromText(fx(name)));
const events = (): PiEvent[] =>
	fx("subagent-fg.rpc-events.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const user = (t = "hi"): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 1 });
const call = (id: string, name: string, args: Record<string, unknown>, timestamp = 1000): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	timestamp,
});
const result = (id: string, name: string, details: Record<string, unknown>, extra: object = {}): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [],
	details,
	isError: false,
	timestamp: 2000,
	...extra,
});

test("todos come from the latest todo result", () => {
	const p = deriveProgress(conv("todo.jsonl"), { live: false });
	const last = [...conv("todo.jsonl").messages].reverse().find((m) => m.toolName === "todo") as any;
	const want = last.details.tasks.filter((t: any) => t.status !== "deleted");
	assert.ok(p.todos && p.todos.length >= 3);
	assert.deepEqual(p.todos.map((t) => t.id), want.map((t: any) => t.id));
	assert.deepEqual(p.todos.map((t) => t.subject), want.map((t: any) => t.subject));
	assert.ok(p.todos.some((t) => t.activeForm) === want.some((t: any) => t.activeForm));
	assert.equal(deriveProgress(createConversation([user()]), { live: false }).todos, null);
});

test("deleted todos are left out", () => {
	const c = createConversation([
		user(),
		call("t1", "todo", {}),
		result("t1", "todo", { tasks: [{ id: 1, subject: "a", status: "pending" }, { id: 2, subject: "b", status: "deleted" }] }),
	]);
	assert.deepEqual(deriveProgress(c, { live: false }).todos, [{ id: 1, subject: "a", status: "pending" }]);
});

test("foreground child finished", () => {
	const c = conv("subagent-fg.jsonl");
	const p = deriveProgress(c, { live: false });
	assert.equal(p.subagents.length, 1);
	const k = p.subagents[0];
	const res = (c.messages.find((m) => m.toolName === "subagent") as any).details.results[0];
	assert.equal(k.state, "done");
	assert.ok(k.agent && k.task);
	assert.notEqual(k.task, "[prompt redacted]");
	assert.equal(k.background, false);
	assert.equal(k.sessionFile, res.sessionFile);
	assert.equal(k.key, `${k.toolCallId}:0`);
	assert.equal(k.turn, 1);
	assert.ok(k.startedAt && k.endedAt && k.endedAt >= k.startedAt);
});

test("running only while live", () => {
	const evs = events();
	const end = evs.findIndex((e) => e.type === "tool_execution_end");
	const c = createConversation();
	for (const e of evs.slice(0, end)) applyEvent(c, e);
	const live = deriveProgress(c, { live: true }).subagents;
	assert.equal(live.length, 1);
	assert.equal(live[0].state, "running");
	assert.ok(live[0].agent);
	assert.equal(live[0].sessionFile, null);
	assert.equal(live[0].runId, "b47e8aef-3f75-4224-8e21-10f05486f2e4"); // from partialResult.details while running
	assert.equal(live[0].endedAt, null);
	assert.equal(deriveProgress(c, { live: false }).subagents[0].state, "unknown");
	// the exitCode placeholder (0) during a run is never read as done
	for (const e of evs.slice(end)) applyEvent(c, e);
	assert.equal(deriveProgress(c, { live: true }).subagents[0].state, "done");
});

test("reload mid-run", () => {
	const c = createConversation([user(), call("s1", "subagent", { agent: "scout", task: "look", async: false })]);
	assert.equal(deriveProgress(c, { live: false }).subagents[0].state, "unknown");
	assert.equal(deriveProgress(c, { live: true }).subagents[0].state, "unknown");
	applyEvent(c, { type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: {} });
	assert.equal(deriveProgress(c, { live: true }).subagents[0].state, "running");
	assert.equal(deriveProgress(c, { live: false }).subagents[0].state, "unknown");
});

test("failed and stopped", () => {
	const mk = (r: object, extra: object = {}) =>
		deriveProgress(
			createConversation([user(), call("s1", "subagent", { agent: "a", task: "t", async: false }), result("s1", "subagent", { results: [{ index: 0, agent: "a", exitCode: 0, ...r }] }, extra)]),
			{ live: false },
		).subagents[0].state;
	assert.equal(mk({}), "done");
	assert.equal(mk({ exitCode: 1 }), "failed");
	assert.equal(mk({}, { isError: true }), "failed");
	assert.equal(mk({ stopped: true }), "stopped");
	assert.equal(mk({ interrupted: true, exitCode: 1 }), "stopped");
	assert.equal(mk({ timedOut: true }), "stopped");
});

test("parallel and chain calls map index to agent and task", () => {
	const c = createConversation([
		user(),
		call("p", "subagent", { tasks: [{ agent: "a", task: "ta" }, { agent: "b", task: "tb" }], async: false }),
		result("p", "subagent", { results: [{ index: 0, agent: "a", exitCode: 0 }, { index: 1, agent: "b", exitCode: 2 }] }),
		call("q", "subagent", { chain: [{ agent: "x", task: "tx" }, { agent: "y", task: "ty" }], async: false }, 3000),
	]);
	const k = deriveProgress(c, { live: false }).subagents;
	assert.deepEqual(k.map((x) => [x.key, x.agent, x.task, x.state]), [
		["p:0", "a", "ta", "done"],
		["p:1", "b", "tb", "failed"],
		["q:0", "x", "tx", "unknown"],
		["q:1", "y", "ty", "unknown"],
	]);
});

test("background child is unknown until status is read", () => {
	const c = conv("subagent-bg.jsonl");
	const p = deriveProgress(c, { live: false });
	assert.equal(p.subagents.length, 1);
	assert.equal(p.subagents[0].background, true);
	assert.equal(p.subagents[0].state, "unknown");
	assert.ok(p.subagents[0].asyncDir);
	assert.equal(p.subagents[0].sessionFile, null);
	assert.equal(p.subagents[0].runId, "d43cb787-c955-4641-b6b1-e3cd32980cb8");
});

test("runId comes from details.runId, else asyncId, else null", () => {
	const mk = (details: Record<string, unknown>) =>
		deriveProgress(createConversation([user(), call("s1", "subagent", { agent: "a", task: "t" }), result("s1", "subagent", details)]), { live: false }).subagents[0].runId;
	assert.equal(mk({ runId: "r1", asyncId: "r2" }), "r1");
	assert.equal(mk({ asyncId: "r2" }), "r2");
	assert.equal(mk({}), null);
	assert.equal(deriveProgress(conv("subagent-fg.jsonl"), { live: false }).subagents[0].runId, "b47e8aef-3f75-4224-8e21-10f05486f2e4");
});

test("turn counts user messages before the call", () => {
	const c = createConversation([
		user(), call("a", "subagent", { agent: "a", task: "t", async: false }), result("a", "subagent", { results: [{ index: 0, agent: "a", exitCode: 0 }] }),
		user(), user(), call("b", "subagent", { agent: "a", task: "t", async: false }),
	]);
	assert.deepEqual(deriveProgress(c, { live: false }).subagents.map((k) => k.turn), [1, 3]);
});

const child = (turn: number, index: number, over: Partial<SubagentChild> = {}): SubagentChild => ({
	key: `c${turn}:${index}`, toolCallId: `c${turn}`, index, agent: "a", task: "t", state: "done", background: false, turn,
	startedAt: null, endedAt: null, sessionFile: null, asyncDir: null, runId: null, ...over,
});

test("groupSubagents", () => {
	const g = groupSubagents([child(1, 0), child(1, 1), child(3, 0), child(1, 0, { key: "bg", background: true, state: "running" })]);
	assert.deepEqual(g.recent.map((k) => k.key), ["c3:0", "bg"]);
	assert.deepEqual(g.earlier.map((k) => k.key), ["c1:1", "c1:0"]);
	assert.deepEqual(groupSubagents([]), { recent: [], earlier: [] });
});

test("planPath: latest read/edit/write on a plan file wins", () => {
	const mk = (...paths: Array<[string, string]>) =>
		createConversation([user(), ...paths.map(([n, p], i) => call(`x${i}`, n, { path: p }))]);
	const a = "docs/superpowers/plans/a.md", b = "/w/docs/superpowers/plans/b.md";
	assert.equal(deriveProgress(mk(["read", a], ["edit", b], ["read", "docs/notes.md"]), { live: false }).planPath, b);
	assert.equal(deriveProgress(mk(["write", a], ["read", b], ["bash", "docs/superpowers/plans/c.md"]), { live: false }).planPath, b);
	assert.equal(deriveProgress(mk(["read", "docs/notes.md"]), { live: false }).planPath, null);
	assert.ok(PLAN_PATH_RE.test("docs/superpowers/plans/x.md"));
	assert.ok(!PLAN_PATH_RE.test("docs/superpowers/plans/sub/x.md.bak"));
});

test("a pending call without an async arg is a background run, never running", () => {
	const c = createConversation([user(), call("s1", "subagent", { agent: "scout", task: "look" })]);
	applyEvent(c, { type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: {} });
	const k = deriveProgress(c, { live: true }).subagents[0];
	assert.equal(k.background, true);
	assert.equal(k.state, "unknown");
});
