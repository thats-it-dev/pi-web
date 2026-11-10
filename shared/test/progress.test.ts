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

// --- latest PR ---
const text = (t: string) => [{ type: "text", text: t }];
const bash = (id: string, command: string, out: string, name = "bash"): AgentMessage[] => [
	call(id, name, { command }),
	result(id, name, {}, { content: text(out) }),
];
const prCmd = `node /x/thatsit-app.ts pr /w --title "Add thing" --body "b"`;
const prOut = (n: number) => `log\nRESULT ${JSON.stringify({ ok: true, pr: `https://github.com/o/r/pull/${n}`, number: n })}`;
const startJob = (callId: string, jobId: string, cmd = "node /x/thatsit-app.ts pr-wait /w"): AgentMessage[] => [
	call(callId, "bg_bash", { command: cmd }),
	result(callId, "bg_bash", { id: jobId }, { content: text(`started job ${jobId}. You will get a bg-bash-done message when it exits; end your turn and wait.`) }),
];
const done = (first: string, rest: string): AgentMessage => ({ role: "custom", customType: "bg-bash-done", content: `${first}\n${rest}`, display: true, timestamp: 3000 } as AgentMessage);
const prOf = (msgs: AgentMessage[], opts: { live: boolean } = { live: false }) => deriveProgress(createConversation([user(), ...msgs]), opts).pr;

test("pr: none in the session", () => {
	assert.equal(prOf([]), null);
});

test("pr: a pr result alone", () => {
	assert.deepEqual(prOf(bash("b1", prCmd, prOut(7))), {
		url: "https://github.com/o/r/pull/7", number: 7, title: "Add thing", ci: "none", preview: null, gatewayPreview: null, reason: null,
	});
});

test("pr: a running pr-wait", () => {
	const p = prOf([...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1")], { live: true });
	assert.equal(p?.ci, "running");
});

test("pr: done exit 0 gives the previews", () => {
	const p = prOf([
		...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1"),
		done("bg_bash job bg-1 exited 0", `RESULT ${JSON.stringify({ ok: true, pr: "u", preview: "https://p.example", gatewayPreview: "https://g.example" })}\ntail`),
	]);
	assert.equal(p?.ci, "passed");
	assert.equal(p?.preview, "https://p.example");
	assert.equal(p?.gatewayPreview, "https://g.example");
	const q = prOf([
		...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1"),
		done("bg_bash job bg-1 exited 0", `RESULT ${JSON.stringify({ ok: true, preview: "https://p.example" })}`),
	]);
	assert.equal(q?.gatewayPreview, null);
});

test("pr: done exit 1 gives the reason's first line, or the first output line", () => {
	const p = prOf([
		...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1"),
		done("bg_bash job bg-1 exited 1", `RESULT ${JSON.stringify({ ok: false, reason: "checks failed\nmore" })}\ntail`),
	]);
	assert.equal(p?.ci, "failed");
	assert.equal(p?.reason, "checks failed");
	const q = prOf([...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1"), done("bg_bash job bg-1 exited 2", "boom happened\nsecond")]);
	assert.equal(q?.ci, "failed");
	assert.equal(q?.reason, "boom happened");
});

test("pr: cancelled and signal-killed jobs fail", () => {
	const a = prOf([...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1"), done("bg_bash job bg-1 was cancelled", "")]);
	assert.equal(a?.ci, "failed");
	assert.equal(a?.reason, "cancelled");
	const b = prOf([...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1"), done("bg_bash job bg-1 was killed (SIGKILL) after 0m 3s: x", "partial output")]);
	assert.equal(b?.ci, "failed");
	assert.equal(b?.reason, "killed");
});

test("pr: the job id falls back to details.id", () => {
	const msgs = [
		...bash("b1", prCmd, prOut(7)),
		call("j1", "bg_bash", { command: "thatsit-app.ts pr-wait /w" }),
		result("j1", "bg_bash", { id: "bg-4" }, { content: text("started") }),
		done("bg_bash job bg-4 exited 0", `RESULT ${JSON.stringify({ ok: true, preview: "https://p.example" })}`),
	];
	assert.equal(prOf(msgs)?.ci, "passed");
});

test("pr: no done message is running while live (it may sit in the follow-up queue), lost once not live", () => {
	const msgs = [...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1")];
	assert.equal(prOf(msgs, { live: false })?.ci, "lost");
	assert.equal(prOf(msgs, { live: true })?.ci, "running");
});

test("pr: a second pr resets the previous preview", () => {
	const first = [
		...bash("b1", prCmd, prOut(7)), ...startJob("j1", "bg-1"),
		done("bg_bash job bg-1 exited 0", `RESULT ${JSON.stringify({ ok: true, preview: "https://p.example" })}`),
	];
	const p = prOf([...first, ...bash("b2", prCmd.replace("Add thing", "Again"), prOut(8))]);
	assert.equal(p?.number, 8);
	assert.equal(p?.title, "Again");
	assert.equal(p?.ci, "none");
	assert.equal(p?.preview, null);
	assert.equal(prOf([...first, ...bash("b2", prCmd, prOut(8)), ...startJob("j2", "bg-2")], { live: true })?.ci, "running");
});

test("pr: gateway-pr counts, ship and failed results do not", () => {
	const g = prOf(bash("b1", `node thatsit-app.ts gateway-pr /w --title 'G t'`, prOut(3)));
	assert.equal(g?.number, 3);
	assert.equal(g?.title, "G t");
	assert.equal(prOf(bash("b1", `node thatsit-app.ts ship /w`, prOut(3))), null);
	assert.equal(prOf(bash("b1", prCmd, `RESULT {"ok":false,"reason":"x"}`)), null);
	assert.equal(prOf(bash("b1", `node thatsit-app.ts pr-wait /w`, prOut(3))), null);
});
