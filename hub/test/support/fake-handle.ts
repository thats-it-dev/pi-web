import type { AppCommand, Capabilities, CommandResult, LiveState, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import type { HandleEvent, SessionHandle } from "../../src/handle.ts";

export class FakeHandle implements SessionHandle {
	readonly kind = "rpc" as const;
	readonly capabilities: Capabilities = { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true };
	readonly pid = 4242;
	readonly cwd: string;
	readonly sessionFile: string | null;
	sessionId: string;
	lastActive = 0;
	busy = false;
	state: LiveState = "idle";
	closed = false;
	/** When true, close() does not fire the exit event (simulates a child that has not exited yet). */
	deferExit = false;
	received: AppCommand[] = [];
	conv = createConversation();
	private subs = new Set<(m: StreamMessage) => void>();
	private listeners = new Set<(e: HandleEvent) => void>();

	constructor(sessionId: string, cwd = "/tmp", sessionFile: string | null = null) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.sessionFile = sessionFile;
	}

	subscriberCount(): number {
		return this.subs.size;
	}
	isBusy(): boolean {
		return this.busy;
	}
	liveState(): LiveState {
		return this.state;
	}
	snapshot(): Snapshot {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			cwd: this.cwd,
			handleKind: "rpc",
			capabilities: this.capabilities,
			conv: this.conv,
			state: { model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, sessionId: this.sessionId, messageCount: 0, pendingMessageCount: 0, autoCompactionEnabled: true },
			stats: null,
			models: [],
			thinkingLevels: ["off"],
			commands: [],
			dialogs: [],
			statuses: {},
			widgets: {},
			terminalPrompt: null,
		};
	}
	async command(cmd: AppCommand): Promise<CommandResult> {
		this.received.push(cmd);
		return { ok: true };
	}
	subscribe(fn: (m: StreamMessage) => void): () => void {
		this.subs.add(fn);
		return () => {
			this.subs.delete(fn);
		};
	}
	onEvent(fn: (e: HandleEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	push(m: StreamMessage): void {
		for (const fn of this.subs) fn(m);
	}
	fire(e: HandleEvent): void {
		for (const fn of this.listeners) fn(e);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.push({ type: "handle_gone", reason: "closed" });
		if (!this.deferExit) this.fireExit();
	}
	fireExit(): void {
		this.fire({ type: "exit", code: 0, stderr: "", closedByHub: true });
	}
}
