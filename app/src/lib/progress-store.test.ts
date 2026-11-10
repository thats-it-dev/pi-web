import type { RunReport } from "../../../shared/src/run-report.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "../../../shared/src/goal.ts";
import type { SubagentChild } from "../../../shared/src/progress.ts";
import type { Snapshot } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import { HubError } from "./api.ts";
import { ProgressStore, relPlanPath } from "./progress-store.ts";
import { SessionStore } from "./session-store.ts";

const PLAN = "docs/superpowers/plans/p.md";
const snap = (conv = createConversation([]), over: Partial<Snapshot> = {}): Snapshot => ({
	sessionId: "s1", sessionFile: null, cwd: "/w", handleKind: "rpc",
	capabilities: { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true },
	conv,
	state: { model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false, sessionId: "s1", messageCount: 0, pendingMessageCount: 0, autoCompactionEnabled: true },
	stats: null, models: [], thinkingLevels: ["off"], commands: [], dialogs: [], statuses: {}, widgets: {}, terminalPrompt: null, approvalMode: "auto", ...over,
});
const goal: Goal = { text: "ship", status: "active", waiting: false, updatedAt: 1 };
const child = (over: Partial<SubagentChild> = {}): SubagentChild => ({ key: "t1:0", toolCallId: "t1", index: 0, agent: "scout", task: "look", state: "unknown", background: true, turn: 1, startedAt: null, endedAt: null, sessionFile: null, asyncDir: "/a", runId: "r1", ...over });
const readCall = { role: "assistant" as const, timestamp: 1, content: [{ type: "toolCall" as const, id: "r1", name: "read", arguments: { path: PLAN } }] };
const subCall = (id: string, background: boolean) => ({
	role: "assistant" as const, timestamp: 1,
	content: [{ type: "toolCall" as const, id, name: "subagent", arguments: { agent: "scout", task: "look", async: background } }],
});

function setup(api: Partial<Record<"goal" | "plan" | "subagents" | "runs", unknown>> = {}) {
	const session = new SessionStore("s1");
	const fake = {
		goal: vi.fn(async () => ({ goal })),
		plan: vi.fn(async (_id: string, path: string) => ({ path, text: "# P\n### Task 1: A\n- [ ] x\n", mtimeMs: 1 })),
		subagents: vi.fn(async () => ({ children: [] as SubagentChild[] })),
		runs: vi.fn(async () => ({ runs: [] as RunReport[] })),
		...api,
	};
	const store = new ProgressStore(fake as never, session);
	return { session, fake, store };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const ev = (session: SessionStore, event: object) => session.apply({ type: "event", event: event as never });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ProgressStore", () => {
	it("activity follows the snapshot", async () => {
		const { session, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap() });
		store.start();
		expect(store.view.activity).toBe("idle");
		ev(session, { type: "agent_start" });
		expect(store.view.activity).toBe("working");
		session.apply({ type: "dialog", dialog: { id: "d1", method: "confirm", title: "ok?" } });
		expect(store.view.activity).toBe("waiting");
		session.apply({ type: "dialog_closed", id: "d1" });
		expect(store.view.activity).toBe("working");
		store.stop();
	});

	it("runs: fetched with the goal; the latest is current, the rest newest first; no tool calls means no section", async () => {
		const r = (label: string, toolCalls: number) => ({ label, toolCalls }) as RunReport;
		const runs = vi.fn(async () => ({ runs: [r("one", 3), r("two", 5), r("three", 7)] }));
		const { session, store } = setup({ runs });
		session.apply({ type: "snapshot", snapshot: snap() });
		store.start();
		await flush();
		expect(runs).toHaveBeenCalledTimes(1);
		expect(store.view.runs?.current.label).toBe("three");
		expect(store.view.runs?.earlier.map((e) => e.label)).toEqual(["two", "one"]);
		expect(store.view.empty).toBe(false);
		ev(session, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(5000);
		expect(runs).toHaveBeenCalledTimes(2);
		runs.mockResolvedValueOnce({ runs: [r("fresh", 0)] });
		ev(session, { type: "agent_settled" });
		await flush();
		expect(store.view.runs).toBeNull();
		store.stop();
	});

	it("goal refetches on settle", async () => {
		const { session, fake, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap() });
		store.start();
		await flush();
		expect(fake.goal).toHaveBeenCalledTimes(1);
		expect(store.view.goal).toEqual(goal);
		ev(session, { type: "agent_start" });
		ev(session, { type: "agent_settled" });
		await flush();
		expect(fake.goal).toHaveBeenCalledTimes(2);
		store.stop();
	});

	it("goal polls every 5 s while streaming and stops on stop()", async () => {
		const { session, fake, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap() });
		store.start();
		await flush();
		ev(session, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fake.goal).toHaveBeenCalledTimes(3);
		store.stop();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(fake.goal).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("goal refetches when a goal_* tool run ends", async () => {
		const { session, fake, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap() });
		store.start();
		await flush();
		ev(session, { type: "tool_execution_start", toolCallId: "g1", toolName: "goal_complete", args: {} });
		ev(session, { type: "tool_execution_end", toolCallId: "g1", toolName: "goal_complete", result: {}, isError: false });
		await flush();
		expect(fake.goal).toHaveBeenCalledTimes(2);
		store.stop();
	});

	it("plan refetches after an edit to it", async () => {
		const { session, fake, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap(createConversation([readCall])) });
		store.start();
		await flush();
		expect(fake.plan).toHaveBeenCalledTimes(1);
		expect(store.view.plan?.path).toBe(PLAN);
		expect(store.view.plan?.tasks).toHaveLength(1);
		expect(store.planText).toBe("# P\n### Task 1: A\n- [ ] x\n");
		ev(session, { type: "tool_execution_start", toolCallId: "e0", toolName: "edit", args: { path: "src/other.ts" } });
		ev(session, { type: "tool_execution_end", toolCallId: "e0", toolName: "edit", result: {}, isError: false });
		await flush();
		expect(fake.plan).toHaveBeenCalledTimes(1);
		ev(session, { type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: PLAN } });
		ev(session, { type: "tool_execution_end", toolCallId: "e1", toolName: "edit", result: {}, isError: false });
		await flush();
		expect(fake.plan).toHaveBeenCalledTimes(2);
		store.stop();
	});

	it("a 404 on the plan clears it but other errors keep the last one", async () => {
		let mode: "ok" | "404" | "500" = "ok";
		const plan = vi.fn(async (_id: string, path: string) => {
			if (mode === "404") throw new HubError(404, "Plan not found");
			if (mode === "500") throw new HubError(500, "boom");
			return { path, text: "# P\n### Task 1: A\n- [ ] x\n", mtimeMs: 1 };
		});
		const { session, store } = setup({ plan });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([readCall])) });
		store.start();
		await flush();
		const edit = async (id: string) => {
			ev(session, { type: "tool_execution_start", toolCallId: id, toolName: "edit", args: { path: PLAN } });
			ev(session, { type: "tool_execution_end", toolCallId: id, toolName: "edit", result: {}, isError: false });
			await flush();
		};
		expect(store.view.plan).not.toBeNull();
		mode = "500";
		await edit("b");
		expect(store.view.plan).not.toBeNull();
		mode = "404";
		await edit("c");
		expect(store.view.plan).toBeNull();
		store.stop();
	});

	it("background polling stops when terminal", async () => {
		const answers: SubagentChild["state"][] = ["running", "done"];
		const subagents = vi.fn(async () => ({ children: [child({ state: answers.shift() ?? "done", startedAt: 5, endedAt: null })] }));
		const { session, fake, store } = setup({ subagents });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([subCall("t1", true)])) });
		store.start();
		await flush();
		expect(store.view.subagents.recent[0].state).toBe("running");
		await vi.advanceTimersByTimeAsync(3000);
		expect(store.view.subagents.recent[0].state).toBe("done");
		const calls = subagents.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(subagents).toHaveBeenCalledTimes(calls);
		expect(fake.goal).toHaveBeenCalled();
		store.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("an error or a late unknown never reverts a terminal state", async () => {
		const first: Array<SubagentChild["state"] | "err"> = ["done", "err", "running", "unknown"];
		const subagents = vi.fn(async () => {
			const n = first.shift() ?? "done";
			if (n === "err") throw new HubError(0, "down");
			return { children: [child({ state: n }), child({ key: "t2:0", toolCallId: "t2", state: "running" })] };
		});
		const { session, store } = setup({ subagents });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([subCall("t1", true), subCall("t2", true)])) });
		store.start();
		const states = () => Object.fromEntries([...store.view.subagents.recent, ...store.view.subagents.earlier].map((c) => [c.key, c.state]));
		await flush();
		expect(states()["t1:0"]).toBe("done");
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(3000);
			expect(states()["t1:0"]).toBe("done");
		}
		expect(subagents.mock.calls.length).toBeGreaterThanOrEqual(4); // polling kept going, responses consumed
		store.stop();
	});

	it("a finished child still gets its times filled in", async () => {
		const seq = [child({ state: "done", startedAt: null, endedAt: null }), child({ state: "done", startedAt: 5, endedAt: 9 })];
		const subagents = vi.fn(async () => ({ children: [seq.shift() ?? seq[0] ?? child({ state: "done", startedAt: 5, endedAt: 9 }), child({ key: "t2:0", toolCallId: "t2", state: "running" })] }));
		const { session, store } = setup({ subagents });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([subCall("t1", true), subCall("t2", true)])) });
		store.start();
		await vi.advanceTimersByTimeAsync(3000);
		const c = [...store.view.subagents.recent, ...store.view.subagents.earlier].find((x) => x.key === "t1:0")!;
		expect([c.state, c.startedAt, c.endedAt]).toEqual(["done", 5, 9]);
		store.stop();
	});

	it("goal: a slow older response does not overwrite a newer one", async () => {
		const resolvers: Array<(v: { goal: Goal | null }) => void> = [];
		const goalFn = vi.fn(() => new Promise<{ goal: Goal | null }>((r) => resolvers.push(r)));
		const { session, store } = setup({ goal: goalFn });
		session.apply({ type: "snapshot", snapshot: snap() });
		store.start(); // fetch #1
		ev(session, { type: "agent_start" });
		ev(session, { type: "agent_settled" }); // fetch #2
		expect(resolvers).toHaveLength(2);
		resolvers[1]({ goal: { ...goal, text: "new" } });
		await flush();
		resolvers[0]({ goal: { ...goal, text: "old" } });
		await flush();
		expect(store.view.goal?.text).toBe("new");
		store.stop();
	});

	it("does not start a subagents poll while one is in flight", async () => {
		const subagents = vi.fn(() => new Promise<{ children: SubagentChild[] }>(() => {}));
		const { session, store } = setup({ subagents });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([subCall("t1", true)])) });
		store.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(subagents).toHaveBeenCalledTimes(1);
		store.stop();
	});

	it("a running background child that can't be confirmed shows as unknown", async () => {
		let fail = false;
		const subagents = vi.fn(async () => {
			if (fail) throw new HubError(0, "down");
			return { children: [child({ state: "running" })] };
		});
		const { session, store } = setup({ subagents });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([subCall("t1", true)])) });
		store.start();
		await flush();
		const state = () => store.view.subagents.recent[0].state;
		expect(state()).toBe("running");
		fail = true;
		await vi.advanceTimersByTimeAsync(3000); // 1 failure, still live
		expect(state()).toBe("running");
		await vi.advanceTimersByTimeAsync(6000); // 3 failures
		expect(state()).toBe("unknown");
		fail = false;
		await vi.advanceTimersByTimeAsync(3000);
		expect(state()).toBe("running");
		// not live and the latest fetch failed: unknown at once
		fail = true;
		session.apply({ type: "handle_gone", reason: "exit", stderr: "" } as never);
		await vi.advanceTimersByTimeAsync(3000);
		expect(state()).toBe("unknown");
		store.stop();
	});

	it("stream drops mid-run: a running foreground child becomes unknown", async () => {
		const { session, store } = setup();
		session.setHistory({ messages: [{ role: "user", content: "go", timestamp: 0 }, subCall("t1", false)], live: true, cwd: "/w" });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([{ role: "user", content: "go", timestamp: 0 }, subCall("t1", false)])) });
		store.start();
		ev(session, { type: "tool_execution_start", toolCallId: "t1", toolName: "subagent", args: { agent: "scout", task: "look" } });
		expect(store.view.subagents.recent[0].state).toBe("running");
		session.apply({ type: "handle_gone", reason: "exit", stderr: "" } as never);
		expect(session.status).not.toBe("live");
		expect(store.view.subagents.recent[0].state).toBe("unknown");
		store.stop();
	});

	it("empty is true when nothing is present", async () => {
		const { session, store } = setup({ goal: async () => ({ goal: null }) });
		session.apply({ type: "snapshot", snapshot: snap() });
		store.start();
		await flush();
		expect(store.view.empty).toBe(true);
		store.stop();
	});

	it("an absolute plan path under the cwd is fetched and compared cwd-relative", async () => {
		const abs = { ...readCall, content: [{ ...readCall.content[0], arguments: { path: `/w/${PLAN}` } }] };
		const { session, fake, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap(createConversation([abs])) });
		store.start();
		await flush();
		expect(fake.plan).toHaveBeenLastCalledWith("s1", PLAN);
		expect(store.view.plan?.path).toBe(PLAN);
		// an edit by its absolute spelling counts as an edit to the same plan
		ev(session, { type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: `/w/${PLAN}` } });
		ev(session, { type: "tool_execution_end", toolCallId: "e1", toolName: "edit", result: {}, isError: false });
		await flush();
		expect(fake.plan).toHaveBeenCalledTimes(2);
		store.stop();
		expect(relPlanPath(`./${PLAN}`, "/w")).toBe(PLAN);
		expect(relPlanPath(`/w/${PLAN}`, "/w/")).toBe(PLAN);
		expect(relPlanPath(`/elsewhere/${PLAN}`, "/w")).toBe(`/elsewhere/${PLAN}`);
		expect(relPlanPath(`/wx/${PLAN}`, "/w")).toBe(`/wx/${PLAN}`);
	});

	it("plan refetches when a subagent run ends and when a turn settles", async () => {
		const { session, fake, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap(createConversation([readCall])) });
		store.start();
		await flush();
		expect(fake.plan).toHaveBeenCalledTimes(1);
		ev(session, { type: "tool_execution_start", toolCallId: "s9", toolName: "subagent", args: { agent: "w", task: "t" } });
		ev(session, { type: "tool_execution_end", toolCallId: "s9", toolName: "subagent", result: {}, isError: false });
		await flush();
		expect(fake.plan).toHaveBeenCalledTimes(2);
		ev(session, { type: "agent_start" });
		ev(session, { type: "agent_settled" });
		await flush();
		expect(fake.plan).toHaveBeenCalledTimes(3);
		store.stop();
	});

	it("plan polls every 5 s while streaming and skips the re-parse when mtime is unchanged", async () => {
		let mtimeMs = 1;
		let text = "# P\n### Task 1: A\n- [ ] x\n";
		const plan = vi.fn(async (_id: string, path: string) => ({ path, text, mtimeMs }));
		const { session, store } = setup({ plan });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([readCall])) });
		store.start();
		await flush();
		ev(session, { type: "agent_start" });
		let changes = 0;
		store.addEventListener("change", () => changes++);
		const before = store.view.plan;
		await vi.advanceTimersByTimeAsync(5000);
		expect(plan).toHaveBeenCalledTimes(2);
		expect(store.view.plan).toBe(before); // same mtime: not re-parsed
		const goalOnly = changes;
		text = "# P\n### Task 1: A\n- [x] x\n";
		mtimeMs = 2;
		await vi.advanceTimersByTimeAsync(5000);
		expect(plan).toHaveBeenCalledTimes(3);
		expect(store.view.plan?.tasks[0].done).toBe(1);
		expect(changes).toBeGreaterThan(goalOnly);
		ev(session, { type: "agent_settled" });
		await flush();
		const n = plan.mock.calls.length;
		await vi.advanceTimersByTimeAsync(20_000);
		expect(plan).toHaveBeenCalledTimes(n); // not streaming: no polling
		store.stop();
	});

	it("a dead session stops polling a child the hub reports as unknown; a live one keeps going", async () => {
		const subagents = vi.fn(async () => ({ children: [child({ state: "unknown" })] }));
		const { session, store } = setup({ subagents });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([subCall("t1", true)])) });
		store.start();
		await vi.advanceTimersByTimeAsync(9000);
		expect(subagents.mock.calls.length).toBeGreaterThanOrEqual(3); // live: still polling
		session.apply({ type: "handle_gone", reason: "exit", stderr: "" } as never);
		expect(session.status).not.toBe("live");
		const n = subagents.mock.calls.length;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(subagents).toHaveBeenCalledTimes(n);
		expect(vi.getTimerCount()).toBe(0);
		store.stop();
	});

	it("a dead session's child stays polled until the hub has answered for it", async () => {
		const subagents = vi.fn(async () => ({ children: [child({ state: "unknown" })] }));
		const { session, store } = setup({ subagents });
		session.setHistory({ messages: [subCall("t1", true)], live: false, cwd: "/w" });
		store.start();
		await flush();
		expect(subagents).toHaveBeenCalledTimes(1); // asked once
		await vi.advanceTimersByTimeAsync(15_000);
		expect(subagents).toHaveBeenCalledTimes(1); // answered unknown: no more
		store.stop();
	});

	it("progress pr stays running while live without a done message, and is lost once the session is not live", () => {
		const text = (t: string) => [{ type: "text" as const, text: t }];
		const conv = createConversation([
			{ role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: 'node thatsit-app.ts pr /w --title "T"' } }] },
			{ role: "toolResult", toolCallId: "b1", toolName: "bash", content: text('RESULT {"ok":true,"pr":"https://gh/pull/1","number":1}'), isError: false, timestamp: 2 },
			{ role: "assistant", timestamp: 3, content: [{ type: "toolCall", id: "j1", name: "bg_bash", arguments: { command: "node thatsit-app.ts pr-wait /w" } }] },
			{ role: "toolResult", toolCallId: "j1", toolName: "bg_bash", content: text("started job bg-1. You will get a bg-bash-done message when it exits; end your turn and wait."), details: { id: "bg-1" }, isError: false, timestamp: 4 },
		]);
		const { session, store } = setup();
		session.apply({ type: "snapshot", snapshot: snap(conv, { statuses: { "bg-jobs": "1 job" } }) });
		store.start();
		expect(store.view.pr?.ci).toBe("running");
		session.apply({ type: "meta", state: session.snapshot!.state, stats: null, statuses: {}, widgets: {}, thinkingLevels: ["off"], terminalPrompt: null, approvalMode: "auto" });
		expect(store.view.pr?.ci).toBe("running"); // bg-jobs cleared, the done message still queued
		session.apply({ type: "handle_gone", reason: "closed" });
		expect(store.view.pr?.ci).toBe("lost");
		store.stop();
	});
});
