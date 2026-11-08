import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "../../../shared/src/goal.ts";
import type { SubagentChild } from "../../../shared/src/progress.ts";
import type { Snapshot } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import { HubError } from "./api.ts";
import { ProgressStore } from "./progress-store.ts";
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
const child = (over: Partial<SubagentChild> = {}): SubagentChild => ({ key: "t1:0", toolCallId: "t1", index: 0, agent: "scout", task: "look", state: "unknown", background: true, turn: 1, startedAt: null, endedAt: null, sessionFile: null, asyncDir: "/a", ...over });
const readCall = { role: "assistant" as const, timestamp: 1, content: [{ type: "toolCall" as const, id: "r1", name: "read", arguments: { path: PLAN } }] };
const subCall = (id: string, background: boolean) => ({
	role: "assistant" as const, timestamp: 1,
	content: [{ type: "toolCall" as const, id, name: "subagent", arguments: { agent: "scout", task: "look", async: background } }],
});

function setup(api: Partial<Record<"goal" | "plan" | "subagents", unknown>> = {}) {
	const session = new SessionStore("s1");
	const fake = {
		goal: vi.fn(async () => ({ goal })),
		plan: vi.fn(async (_id: string, path: string) => ({ path, text: "# P\n### Task 1: A\n- [ ] x\n", mtimeMs: 1 })),
		subagents: vi.fn(async () => ({ children: [] as SubagentChild[] })),
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
		const seq: Array<SubagentChild["state"] | "err"> = ["done", "err", "running"];
		const subagents = vi.fn(async () => {
			const n = seq.shift() ?? "done";
			if (n === "err") throw new HubError(0, "down");
			return { children: [child({ state: n })] };
		});
		const { session, store } = setup({ subagents });
		session.apply({ type: "snapshot", snapshot: snap(createConversation([subCall("t1", true)])) });
		store.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(store.view.subagents.recent[0].state).toBe("done");
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
});
