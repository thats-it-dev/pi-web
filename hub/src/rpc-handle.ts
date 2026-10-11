// One headless `pi --mode rpc` child bound to a session. Keeps the conversation,
// stats and extension UI state so any browser that attaches gets a complete
// snapshot, then relays live events to every subscriber.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentMessage,
	AppCommand,
	Capabilities,
	CommandInfo,
	CommandResult,
	Conversation,
	Dialog,
	LiveState,
	ModelInfo,
	PiEvent,
	SessionStateInfo,
	SessionStats,
	Snapshot,
	StreamMessage,
	ThinkingLevel,
	Widget,
} from "../../shared/src/protocol.ts";
import { applyEvent, createConversation } from "../../shared/src/reducer.ts";
import { HttpError } from "./errors.ts";
import type { HandleEvent, SessionHandle } from "./handle.ts";
import { lineSplitter } from "../../shared/src/jsonl.ts";
import { type RpcCommand, toRpc } from "./translate.ts";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

const BOOT_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30 * 60_000;

interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface RpcHandleOptions {
	piBin: string;
	cwd: string;
	sessionFile?: string;
	exportDir: string;
	env?: Record<string, string>;
	promptAckMs?: number; // how long a prompt waits for pi's ack before returning `pending`
}

export class RpcHandle implements SessionHandle {
	readonly kind = "rpc" as const;
	readonly capabilities: Capabilities = { dialogs: "here", fork: true, clone: true, newSession: true, bash: true, export: true };
	readonly cwd: string;
	lastActive = Date.now();

	private opts: RpcHandleOptions;
	private proc: ChildProcessWithoutNullStreams | null = null;
	private pending = new Map<string, (res: RpcResponse) => void>();
	private subscribers = new Set<(m: StreamMessage) => void>();
	private listeners = new Set<(e: HandleEvent) => void>();
	private conv: Conversation = createConversation();
	private state: SessionStateInfo | null = null;
	private stats: SessionStats | null = null;
	private models: ModelInfo[] = [];
	private commands: CommandInfo[] = [];
	private thinkingLevels: ThinkingLevel[] = [];
	private statuses: Record<string, string> = {};
	private widgets: Record<string, Widget> = {};
	private dialogs = new Map<string, Dialog>();
	private stderr = "";
	private closing = false;
	private exited = false;
	private resyncOnSettle = false;

	private constructor(opts: RpcHandleOptions) {
		this.opts = opts;
		this.cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir();
	}

	static async start(opts: RpcHandleOptions): Promise<RpcHandle> {
		const h = new RpcHandle(opts);
		try {
			await h.boot();
		} catch (err) {
			h.close();
			throw new HttpError(502, `Couldn't start pi (${opts.piBin}): ${h.stderrTail() || (err as Error).message}`);
		}
		return h;
	}

	get sessionId(): string {
		return this.state?.sessionId ?? "";
	}
	get sessionFile(): string | null {
		return this.state?.sessionFile ?? this.opts.sessionFile ?? null;
	}
	get pid(): number {
		return this.proc?.pid ?? -1;
	}

	subscriberCount(): number {
		return this.subscribers.size;
	}
	isBusy(): boolean {
		return this.conv.streaming || this.conv.compacting || this.dialogs.size > 0;
	}
	liveState(): LiveState {
		if (this.dialogs.size > 0) return "needs_you";
		return this.conv.streaming || this.conv.compacting ? "running" : "idle";
	}

	snapshot(): Snapshot {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			cwd: this.cwd,
			handleKind: "rpc",
			capabilities: this.capabilities,
			conv: this.conv,
			state: this.state as SessionStateInfo,
			stats: this.stats,
			models: this.models,
			thinkingLevels: this.thinkingLevels,
			commands: this.commands,
			dialogs: [...this.dialogs.values()],
			statuses: this.statuses,
			widgets: this.widgets,
			terminalPrompt: null,
		};
	}

	subscribe(fn: (m: StreamMessage) => void): () => void {
		this.subscribers.add(fn);
		this.lastActive = Date.now();
		return () => {
			this.subscribers.delete(fn);
			this.lastActive = Date.now();
		};
	}

	onEvent(fn: (e: HandleEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	close(): void {
		if (this.exited || this.closing) return;
		this.closing = true;
		if (!this.proc) return;
		this.proc.stdin.end();
		setTimeout(() => {
			if (!this.exited) this.proc?.kill("SIGTERM");
		}, 5000).unref();
	}

	async command(cmd: AppCommand): Promise<CommandResult> {
		this.lastActive = Date.now();
		switch (cmd.type) {
			case "attach":
				return { ok: true };
			case "dialog_response": {
				if (!this.dialogs.delete(cmd.id)) return { ok: false, error: "That dialog is no longer open." };
				this.write(toRpc(cmd));
				this.broadcast({ type: "dialog_closed", id: cmd.id });
				this.emit({ type: "state_changed" });
				return { ok: true };
			}
			case "prompt":
				return this.prompt(cmd);
			case "export": {
				mkdirSync(this.opts.exportDir, { recursive: true });
				const name = `${this.sessionId}-${Date.now()}.html`;
				const r = await this.call({ type: "export_html", outputPath: join(this.opts.exportDir, name) });
				return r.success ? { ok: true, data: { name } } : { ok: false, error: r.error ?? "Export failed" };
			}
		}
		const r = await this.call(toRpc(cmd));
		if (!r.success) return { ok: false, error: r.error ?? `${cmd.type} failed` };
		await this.afterCommand(cmd, r.data).catch(() => {});
		return { ok: true, data: r.data };
	}

	stderrTail(lines = 20): string {
		return stripAnsi(this.stderr).trim().split("\n").slice(-lines).join("\n");
	}

	// ---- internals ----------------------------------------------------------

	private async boot(): Promise<void> {
		const args = ["--mode", "rpc"];
		if (this.opts.sessionFile) args.push("--session", this.opts.sessionFile);
		const proc = spawn(this.opts.piBin, args, { cwd: this.cwd, env: { ...process.env, ...this.opts.env, PI_WEB: "1" } });
		this.proc = proc;
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", lineSplitter((line) => this.onRecord(line)));
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (d: string) => {
			this.stderr = (this.stderr + d).slice(-8000);
		});
		proc.stdin.on("error", () => {}); // EPIPE after exit is reported via "close"
		proc.on("error", (err) => {
			this.stderr += `\n${err.message}`;
			this.onExit(null);
		});
		// "close" (not "exit") fires after stdio has drained, so stderr and final stdout lines are complete.
		proc.on("close", (code) => this.onExit(code));
		await this.refresh({ messages: true, catalog: true }, BOOT_TIMEOUT_MS);
	}

	private write(cmd: RpcCommand): void {
		this.proc?.stdin.write(`${JSON.stringify(cmd)}\n`);
	}

	private call(cmd: RpcCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<RpcResponse> {
		if (this.exited || !this.proc) return Promise.resolve({ type: "response", command: cmd.type, success: false, error: "pi is not running" });
		const id = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ type: "response", command: cmd.type, success: false, error: `${cmd.type} timed out` });
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, (res) => {
				clearTimeout(timer);
				resolve(res);
			});
			this.write({ ...cmd, id });
		});
	}

	private async data<T>(cmd: RpcCommand, timeoutMs?: number): Promise<T> {
		const r = await this.call(cmd, timeoutMs);
		if (!r.success) throw new Error(r.error ?? `${cmd.type} failed`);
		return r.data as T;
	}

	private async refresh(opts: { messages?: boolean; catalog?: boolean } = {}, timeoutMs?: number): Promise<void> {
		const [state, stats, msgs] = await Promise.all([
			this.data<SessionStateInfo>({ type: "get_state" }, timeoutMs),
			this.data<SessionStats>({ type: "get_session_stats" }, timeoutMs).catch(() => null),
			opts.messages ? this.data<{ messages: AgentMessage[] }>({ type: "get_messages" }, timeoutMs) : Promise.resolve(null),
		]);
		const sessionChanged = this.state !== null && this.state.sessionId !== state.sessionId;
		this.state = { ...state, model: state.model ? slimModel(state.model) : null };
		this.stats = stats;
		if (msgs) {
			const prev = this.conv;
			this.conv = createConversation(msgs.messages);
			this.conv.streaming = prev.streaming || state.isStreaming;
			if (!sessionChanged) {
				// Same session: keep in-flight state the message list doesn't carry.
				this.conv.partial = prev.partial;
				this.conv.tools = prev.tools;
				this.conv.queue = prev.queue;
			}
		}
		if (opts.catalog) {
			const [commands, models, levels] = await Promise.all([
				this.data<{ commands: CommandInfo[] }>({ type: "get_commands" }, timeoutMs).catch(() => ({ commands: [] })),
				this.data<{ models: ModelInfo[] }>({ type: "get_available_models" }, timeoutMs).catch(() => ({ models: [] })),
				this.data<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" }, timeoutMs).catch(() => ({ levels: [] })),
			]);
			this.commands = commands.commands.map(({ name, description, source }) => ({ name, description, source }));
			this.models = models.models.map(slimModel);
			this.thinkingLevels = levels.levels;
		}
	}

	private async prompt(cmd: Extract<AppCommand, { type: "prompt" }>): Promise<CommandResult> {
		const response = this.call(toRpc(cmd));
		let timer: NodeJS.Timeout | undefined;
		const ackWindow = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), this.opts.promptAckMs ?? 3000);
		});
		const first = await Promise.race([response, ackWindow]);
		clearTimeout(timer);
		if (first === null) {
			// pi holds the response while an extension command waits on a dialog.
			response.then((r) => {
				if (!r.success) this.broadcast({ type: "command_error", command: "prompt", error: r.error ?? "Prompt failed" });
			});
			return { ok: true, pending: true };
		}
		return first.success ? { ok: true, data: first.data } : { ok: false, error: first.error ?? "Prompt failed" };
	}

	private async afterCommand(cmd: AppCommand, data: unknown): Promise<void> {
		switch (cmd.type) {
			case "new_session":
			case "fork":
			case "clone": {
				if ((data as { cancelled?: boolean } | undefined)?.cancelled) return;
				const before = this.sessionId;
				await this.refresh({ messages: true, catalog: true });
				this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
				if (this.sessionId !== before) this.emit({ type: "session_changed", from: before, to: this.sessionId });
				return;
			}
			case "compact":
			case "bash":
				await this.refresh({ messages: true });
				this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
				return;
			case "set_model":
			case "set_thinking":
				await this.refresh({ catalog: true });
				this.broadcast(this.meta());
				return;
			case "rename":
				await this.refresh();
				this.broadcast(this.meta());
				this.emit({ type: "renamed" });
				return;
		}
	}

	private onRecord(line: string): void {
		let rec: PiEvent;
		try {
			rec = JSON.parse(line);
		} catch {
			return;
		}
		if (rec.type === "response") {
			const done = rec.id ? this.pending.get(rec.id) : undefined;
			if (done) {
				this.pending.delete(rec.id);
				done(rec as RpcResponse);
			}
			return;
		}
		this.lastActive = Date.now();
		if (rec.type === "extension_ui_request") return this.onUiRequest(rec);

		const before = this.liveState();
		applyEvent(this.conv, rec);
		this.broadcast({ type: "event", event: rec });
		switch (rec.type) {
			case "turn_end":
				this.refresh()
					.then(() => this.broadcast(this.meta()))
					.catch(() => {});
				break;
			case "agent_settled": {
				const resync = this.resyncOnSettle;
				this.resyncOnSettle = false;
				this.refresh({ messages: resync })
					.then(() => this.broadcast(resync ? { type: "snapshot", snapshot: this.snapshot() } : this.meta()))
					.catch(() => {});
				break;
			}
			case "compaction_end":
				if (this.conv.streaming) this.resyncOnSettle = true;
				else
					this.refresh({ messages: true })
						.then(() => this.broadcast({ type: "snapshot", snapshot: this.snapshot() }))
						.catch(() => {});
				break;
			case "session_info_changed":
				this.refresh()
					.then(() => {
						this.broadcast(this.meta());
						this.emit({ type: "renamed" });
					})
					.catch(() => {});
				break;
			case "thinking_level_changed":
				this.refresh()
					.then(() => this.broadcast(this.meta()))
					.catch(() => {});
				break;
		}
		if (this.liveState() !== before) this.emit({ type: "state_changed" });
	}

	private onUiRequest(req: PiEvent): void {
		switch (req.method) {
			case "setStatus":
				if (req.statusText) this.statuses[req.statusKey] = stripAnsi(String(req.statusText));
				else delete this.statuses[req.statusKey];
				this.broadcast(this.meta());
				return;
			case "setWidget":
				if (Array.isArray(req.widgetLines) && req.widgetLines.length > 0)
					this.widgets[req.widgetKey] = { lines: req.widgetLines.map((l: string) => stripAnsi(String(l))), placement: req.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor" };
				else delete this.widgets[req.widgetKey];
				this.broadcast(this.meta());
				return;
			case "notify":
				this.broadcast({ type: "notify", message: stripAnsi(String(req.message ?? "")), level: req.notifyType === "warning" || req.notifyType === "error" ? req.notifyType : "info" });
				return;
			case "set_editor_text":
				this.broadcast({ type: "editor_text", text: String(req.text ?? "") });
				return;
			case "select":
			case "confirm":
			case "input":
			case "editor": {
				const dialog: Dialog = {
					id: req.id,
					method: req.method,
					title: stripAnsi(String(req.title ?? "")),
					message: req.message ? stripAnsi(String(req.message)) : undefined,
					options: req.options,
					placeholder: req.placeholder,
					prefill: req.prefill,
					timeout: req.timeout,
				};
				this.dialogs.set(dialog.id, dialog);
				if (dialog.timeout) {
					setTimeout(() => {
						if (!this.dialogs.delete(dialog.id)) return;
						this.broadcast({ type: "dialog_closed", id: dialog.id });
						this.emit({ type: "state_changed" });
					}, dialog.timeout).unref();
				}
				this.broadcast({ type: "dialog", dialog });
				this.emit({ type: "state_changed" });
				return;
			}
			default:
				return; // setTitle and anything newer: nothing to show
		}
	}

	private meta(): StreamMessage {
		return { type: "meta", state: this.state as SessionStateInfo, stats: this.stats, statuses: this.statuses, widgets: this.widgets, thinkingLevels: this.thinkingLevels, terminalPrompt: null };
	}

	private onExit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		for (const resolve of this.pending.values()) resolve({ type: "response", command: "", success: false, error: "pi exited" });
		this.pending.clear();
		const stderr = this.stderrTail();
		this.broadcast(this.closing ? { type: "handle_gone", reason: "closed" } : { type: "handle_gone", reason: "exit", stderr });
		this.emit({ type: "exit", code, stderr, closedByHub: this.closing });
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

	private emit(e: HandleEvent): void {
		for (const fn of [...this.listeners]) fn(e);
	}
}

function slimModel(m: ModelInfo): ModelInfo {
	return { id: m.id, name: m.name, provider: m.provider, reasoning: m.reasoning, input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost };
}
