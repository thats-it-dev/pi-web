import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import { SessionStore } from "./session-store.ts";
import { headerStatus } from "./status.ts";

const snap = (extra: Partial<Snapshot> = {}): Snapshot => ({
	sessionId: "s1", sessionFile: null, cwd: "/w", handleKind: "bridge",
	capabilities: { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false },
	conv: createConversation(),
	state: { model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, sessionId: "s1", messageCount: 0, pendingMessageCount: 0, autoCompactionEnabled: true },
	stats: null, models: [], thinkingLevels: ["off"], commands: [], dialogs: [], statuses: {}, widgets: {}, terminalPrompt: null, approvalMode: "auto",
	...extra,
});

describe("headerStatus", () => {
	it("says the session is open in the terminal", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap() });
		expect(headerStatus(s)).toBe("open in terminal");
	});
	it("says a terminal dialog is waiting, with its title, and clears when meta says so", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap({ terminalPrompt: { kind: "select", title: "Pick one" } }) });
		expect(headerStatus(s)).toBe("waiting for you in the terminal: Pick one");
		const m = snap();
		s.apply({ type: "meta", state: m.state, stats: null, statuses: {}, widgets: {}, thinkingLevels: ["off"], terminalPrompt: null, approvalMode: "auto" });
		expect(headerStatus(s)).toBe("open in terminal");
		s.apply({ type: "meta", state: m.state, stats: null, statuses: {}, widgets: {}, thinkingLevels: ["off"], terminalPrompt: { kind: "custom", title: "" }, approvalMode: "auto" });
		expect(headerStatus(s)).toBe("waiting for you in the terminal");
	});
	it("says nothing extra for a headless session", () => {
		const s = new SessionStore("s1");
		s.apply({ type: "snapshot", snapshot: snap({ handleKind: "rpc" }) });
		expect(headerStatus(s)).toBeNull();
	});
});
