import { describe, expect, it } from "vitest";
import type { Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import { SessionStore } from "./session-store.ts";

const snap = (id = "s1"): Snapshot => ({
	sessionId: id, sessionFile: null, cwd: "/w", handleKind: "rpc",
	capabilities: { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true },
	conv: createConversation([{ role: "user", content: "hi", timestamp: 1 }]),
	state: { model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false, sessionId: id, messageCount: 1, pendingMessageCount: 0, autoCompactionEnabled: true },
	stats: null, models: [], thinkingLevels: ["off"], commands: [], dialogs: [], statuses: {}, widgets: {}, terminalPrompt: null,
});

describe("SessionStore", () => {
	it("shows file history until a snapshot arrives, then goes live", () => {
		const s = new SessionStore("s1");
		expect(s.status).toBe("loading");
		s.setHistory({ messages: [{ role: "user", content: "from disk" }], live: false, cwd: "/w", name: "katsu" });
		expect(s.status).toBe("history");
		expect(s.conv.messages).toHaveLength(1);
		expect(s.nameHint).toBe("katsu");
		s.apply({ type: "snapshot", snapshot: snap() });
		expect(s.status).toBe("live");
		s.setHistory({ messages: [], live: true, cwd: "/w" }); // late history must not clobber live state
		expect(s.conv.messages).toHaveLength(1);
	});
	it("applies live events, meta, and dialogs", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap() });
		s.apply({ type: "event", event: { type: "agent_start" } });
		s.apply({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" } } });
		expect(s.conv.partial?.content).toEqual([{ type: "text", text: "Hi" }]);
		const m = snap();
		s.apply({ type: "meta", state: { ...m.state, thinkingLevel: "high" }, stats: null, statuses: { lsp: "LSP Inactive" }, widgets: {}, thinkingLevels: ["off", "high"], terminalPrompt: null });
		expect(s.snapshot?.state.thinkingLevel).toBe("high");
		expect(s.snapshot?.statuses).toEqual({ lsp: "LSP Inactive" });
		s.apply({ type: "dialog", dialog: { id: "d1", method: "confirm", title: "Allow rm?" } });
		expect(s.dialogs.map((d) => d.id)).toEqual(["d1"]);
		s.apply({ type: "dialog_closed", id: "d1" });
		expect(s.dialogs).toEqual([]);
	});
	it("follows a session change to a new id", () => {
		const s = new SessionStore("s1");
		const seen: string[] = [];
		s.addEventListener("snapshot", () => seen.push(s.id));
		s.apply({ type: "snapshot", snapshot: snap("s2") });
		expect(seen).toEqual(["s2"]);
	});
	it("falls back to history when the process goes away, keeping the conversation", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap() });
		s.apply({ type: "handle_gone", reason: "exit", stderr: "boom" });
		expect(s.status).toBe("history");
		expect(s.snapshot).toBe(null);
		expect(s.lastExit).toBe("boom");
		expect(s.conv.messages).toHaveLength(1);
	});
	it("stays 'starting' through a detached message, and emits notices", () => {
		const s = new SessionStore("s1");
		const notices: StreamMessage[] = [];
		s.addEventListener("notice", (e) => notices.push((e as CustomEvent<StreamMessage>).detail));
		s.markStarting();
		s.apply({ type: "detached" });
		expect(s.status).toBe("starting");
		s.apply({ type: "notify", message: "picked blue", level: "info" });
		expect(notices).toEqual([{ type: "notify", message: "picked blue", level: "info" }]);
	});
	for (const gone of [{ type: "detached" }, { type: "handle_gone", reason: "closed" }] as StreamMessage[]) {
		it(`clears the in-flight run and asks for history when a live session gets ${gone.type}`, () => {
			const s = new SessionStore("s1");
			let offline = 0;
			s.addEventListener("offline", () => offline++);
			s.apply({ type: "snapshot", snapshot: snap() });
			s.apply({ type: "event", event: { type: "agent_start" } });
			s.apply({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hal" } } });
			s.apply({ type: "event", event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 9" } } });
			s.apply({ type: "event", event: { type: "tool_execution_start", toolCallId: "t0", toolName: "bash", args: { command: "ls" } } });
			s.apply({ type: "event", event: { type: "tool_execution_end", toolCallId: "t0", toolName: "bash", result: { content: "a" }, isError: false } });
			s.apply({ type: "event", event: { type: "compaction_start" } });
			s.apply({ type: "event", event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3 } });
			s.apply(gone);
			expect(s.status).toBe("history");
			expect(s.conv.streaming).toBe(false);
			expect(s.conv.partial).toBe(null);
			expect(s.conv.compacting).toBe(false);
			expect(s.conv.retry).toBe(null);
			expect(Object.keys(s.conv.tools)).toEqual(["t0"]);
			expect(s.conv.messages).toHaveLength(1);
			expect(offline).toBe(1);
			s.setHistory({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "Hal" }] }], live: false, cwd: "/w" });
			expect(s.conv.messages).toHaveLength(2);
			s.apply({ type: "detached" }); // not live any more: nothing to reset or refetch
			expect(offline).toBe(1);
		});
	}
});
