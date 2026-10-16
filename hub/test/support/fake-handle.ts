import type { AppCommand, Capabilities, CommandResult, HandleKind, LiveState, Snapshot, StreamMessage } from "../../../shared/src/protocol.ts";
import { createConversation } from "../../../shared/src/reducer.ts";
import type { PendingTool } from "../../src/auto-approve.ts";
import type { HandleEvent, SessionHandle } from "../../src/handle.ts";

export class FakeHandle implements SessionHandle {
	readonly kind: HandleKind;
	readonly capabilities: Capabilities;
	readonly pid: number;
	readonly cwd: string;
	readonly sessionFile: string | null;
	sessionId: string;
	lastActive = 0;
	busy = false;
	state: LiveState = "idle";
	closed = false;
	/** When true, close() does not fire the exit event (simulates a child that has not exited yet). */
	deferExit = false;
	/** When true, close() does not push handle_gone either; call goneNow() (an RpcHandle's handle_gone waits for the child to exit). */
	deferGone = false;
	received: AppCommand[] = [];
	notices: string[] = [];
	conv = createConversation();
	private subs = new Set<(m: StreamMessage) => void>();
	private observers = new Set<(m: StreamMessage) => void>();
	/** What pendingTool() returns. */
	pendingToolValue: PendingTool | null = null;
	private listeners = new Set<(e: HandleEvent) => void>();

	constructor(sessionId: string, cwd = "/tmp", sessionFile: string | null = null, opts: { kind?: HandleKind; pid?: number } = {}) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.sessionFile = sessionFile;
		this.kind = opts.kind ?? "rpc";
		this.pid = opts.pid ?? 4242;
		this.capabilities =
			this.kind === "rpc"
				? { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true }
				: { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false };
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
			handleKind: this.kind,
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
			approvalMode: "manual",
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
	observe(fn: (m: StreamMessage) => void): () => void {
		this.observers.add(fn);
		return () => {
			this.observers.delete(fn);
		};
	}

	pendingTool(): PendingTool | null {
		return this.pendingToolValue;
	}
	onEvent(fn: (e: HandleEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	notice(text: string): void {
		this.notices.push(text);
	}
	push(m: StreamMessage): void {
		for (const fn of [...this.subs, ...this.observers]) fn(m);
	}
	fire(e: HandleEvent): void {
		for (const fn of [...this.listeners]) fn(e);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.deferGone) this.push({ type: "handle_gone", reason: "closed" });
		if (!this.deferExit && !this.deferGone) this.fireExit();
	}
	goneNow(): void {
		this.push({ type: "handle_gone", reason: "closed" });
		this.fireExit();
	}
	fireExit(): void {
		this.fire({ type: "exit", code: 0, stderr: "", closedByHub: true });
	}
	/** A terminal pi quitting. */
	leave(): void {
		this.push({ type: "handle_gone", reason: "closed" });
		this.fire({ type: "exit", code: 0, stderr: "", closedByHub: false });
	}
}
