// A terminal `pi` with the bridge extension (spec §2.2). The bridge streams
// pi's events and state here and runs app commands over the socket. The hub
// never closes it: the person at the terminal owns that process.

import type { BridgeCommand, BridgeHello, BridgeSync, BridgeToHub, FullSync, HubToBridge } from "../../shared/src/bridge.ts";
import type {
	AppCommand,
	Capabilities,
	CommandInfo,
	CommandResult,
	Conversation,
	LiveState,
	ModelInfo,
	SessionStateInfo,
	SessionStats,
	Snapshot,
	StreamMessage,
	TerminalPrompt,
	ThinkingLevel,
} from "../../shared/src/protocol.ts";
import { applyEvent, createConversation } from "../../shared/src/reducer.ts";
import type { HandleEvent, SessionHandle } from "./handle.ts";

export const UNAVAILABLE_IN_TERMINAL = "Not available while open in the terminal.";
const COMMAND_TIMEOUT_MS = 30 * 60_000;

export interface BridgeConn {
	send(msg: HubToBridge): void;
	close(): void;
}

export class BridgeHandle implements SessionHandle {
	readonly kind = "bridge" as const;
	readonly capabilities: Capabilities = { dialogs: "terminal", fork: false, clone: false, newSession: false, bash: false, export: false };
	lastActive = Date.now();

	private conn: BridgeConn | null;
	private hello!: BridgeHello;
	private conv!: Conversation;
	private state!: SessionStateInfo;
	private stats: SessionStats | null = null;
	private models: ModelInfo[] = [];
	private commands: CommandInfo[] = [];
	private thinkingLevels: ThinkingLevel[] = [];
	private prompt: TerminalPrompt | null = null;
	private pending = new Map<string, (r: CommandResult) => void>();
	private subscribers = new Set<(m: StreamMessage) => void>();
	private listeners = new Set<(e: HandleEvent) => void>();
	private left = false;
	private seq = 0;

	constructor(conn: BridgeConn, hello: BridgeHello) {
		this.conn = conn;
		this.load(hello);
	}

	get sessionId(): string {
		return this.hello.sessionId;
	}
	get sessionFile(): string | null {
		return this.state.sessionFile ?? this.hello.sessionFile;
	}
	get cwd(): string {
		return this.hello.cwd;
	}
	get pid(): number {
		return this.hello.pid;
	}

	subscriberCount(): number {
		return this.subscribers.size;
	}
	isBusy(): boolean {
		return this.conv.streaming || this.conv.compacting || this.prompt !== null;
	}
	liveState(): LiveState {
		if (this.prompt) return "needs_you";
		return this.conv.streaming || this.conv.compacting ? "running" : "idle";
	}

	snapshot(): Snapshot {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			cwd: this.cwd,
			handleKind: "bridge",
			capabilities: this.capabilities,
			conv: this.conv,
			state: this.state,
			stats: this.stats,
			models: this.models,
			thinkingLevels: this.thinkingLevels,
			commands: this.commands,
			dialogs: [],
			statuses: {},
			widgets: {},
			terminalPrompt: this.prompt,
		};
	}

	subscribe(fn: (m: StreamMessage) => void): () => void {
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	onEvent(fn: (e: HandleEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	close(): void {} // spec §3.2: the hub only detaches from a terminal pi

	notice(text: string): void {
		this.conn?.send({ type: "notice", text });
	}

	async command(cmd: AppCommand): Promise<CommandResult> {
		this.lastActive = Date.now();
		switch (cmd.type) {
			case "attach":
				return { ok: true };
			case "prompt":
			case "abort":
			case "set_model":
			case "set_thinking":
			case "compact":
			case "rename":
				return this.forward(cmd);
			case "dialog_response":
				return { ok: false, error: "That dialog is open in the terminal." };
			default:
				return { ok: false, error: UNAVAILABLE_IN_TERMINAL };
		}
	}

	receive(msg: BridgeToHub): void {
		this.lastActive = Date.now();
		switch (msg.type) {
			case "event": {
				const before = this.liveState();
				applyEvent(this.conv, msg.event);
				this.broadcast({ type: "event", event: msg.event });
				if (this.liveState() !== before) this.emit({ type: "state_changed" });
				return;
			}
			case "sync":
				return this.applySync(msg.sync);
			case "prompt_state": {
				const before = this.liveState();
				this.prompt = msg.prompt;
				this.broadcast(this.meta());
				if (this.liveState() !== before) this.emit({ type: "state_changed" });
				return;
			}
			case "result": {
				const done = this.pending.get(msg.id);
				if (!done) return;
				this.pending.delete(msg.id);
				done(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error ?? "Command failed" });
				return;
			}
		}
	}

	// The terminal pi is replacing its extension runtime (TUI /new, /resume, /fork, reload).
	detach(): void {
		this.conn = null;
		this.failPending("pi is switching sessions in the terminal. Try again in a moment.");
	}

	rebind(conn: BridgeConn, hello: BridgeHello): void {
		const from = this.sessionId;
		this.conn = conn;
		this.load(hello);
		this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
		if (hello.sessionId !== from) this.emit({ type: "session_changed", from, to: hello.sessionId });
		this.emit({ type: "state_changed" });
	}

	gone(): void {
		if (this.left) return;
		this.left = true;
		this.conn = null;
		this.failPending("pi is no longer open in the terminal.");
		this.broadcast({ type: "handle_gone", reason: "closed" });
		this.emit({ type: "exit", code: 0, stderr: "", closedByHub: false });
	}

	// ---- internals ----------------------------------------------------------

	private load(hello: BridgeHello): void {
		this.hello = hello;
		this.conv = createConversation(hello.sync.messages);
		this.conv.streaming = hello.sync.state.isStreaming;
		this.conv.compacting = hello.sync.state.isCompacting;
		this.prompt = hello.prompt;
		this.state = hello.sync.state;
		this.stats = hello.sync.stats;
		this.thinkingLevels = hello.sync.thinkingLevels;
		this.models = hello.sync.models;
		this.commands = hello.sync.commands;
	}

	private applySync(sync: BridgeSync | FullSync): void {
		const before = this.liveState();
		const prevName = this.state.sessionName;
		this.state = sync.state;
		this.stats = sync.stats;
		this.thinkingLevels = sync.thinkingLevels;
		if ("messages" in sync) {
			this.models = sync.models;
			this.commands = sync.commands;
			const streaming = this.conv.streaming;
			this.conv = createConversation(sync.messages);
			this.conv.streaming = streaming || sync.state.isStreaming;
			this.conv.compacting = sync.state.isCompacting;
			this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
		} else {
			this.broadcast(this.meta());
		}
		if (sync.state.sessionName !== prevName) this.emit({ type: "renamed" });
		if (this.liveState() !== before) this.emit({ type: "state_changed" });
	}

	private forward(command: BridgeCommand): Promise<CommandResult> {
		const conn = this.conn;
		if (!conn) return Promise.resolve({ ok: false, error: this.left ? "pi is no longer open in the terminal." : "pi is switching sessions in the terminal. Try again in a moment." });
		const id = String(++this.seq);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: `${command.type} timed out` });
			}, COMMAND_TIMEOUT_MS);
			timer.unref();
			this.pending.set(id, (r) => {
				clearTimeout(timer);
				resolve(r);
			});
			conn.send({ type: "cmd", id, command });
		});
	}

	private failPending(error: string): void {
		const waiting = [...this.pending.values()];
		this.pending.clear();
		for (const done of waiting) done({ ok: false, error });
	}

	private meta(): StreamMessage {
		return { type: "meta", state: this.state, stats: this.stats, statuses: {}, widgets: {}, thinkingLevels: this.thinkingLevels, terminalPrompt: this.prompt };
	}

	private broadcast(m: StreamMessage): void {
		for (const fn of [...this.subscribers]) {
			try {
				fn(m);
			} catch (err) {
				console.error("pi-web: stream subscriber threw", err);
			}
		}
	}

	// Over a copy: registry listeners may (un)subscribe on this handle while handling an event.
	private emit(e: HandleEvent): void {
		for (const fn of [...this.listeners]) fn(e);
	}
}
