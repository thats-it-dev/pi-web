// One bridged pi session: introduces it to the hub, streams its events, keeps
// the hub's state current, and runs the app's commands through the extension
// API. A new BridgeSession starts on every session_start, because a TUI /new,
// /resume or /fork replaces pi's extension runtime and invalidates the old ctx.

import { BRIDGE_PROTOCOL, type BridgeCommand, type BridgeResult, type BridgeSync, type ByeReason, type FullSync, type HubToBridge } from "../shared/src/bridge.ts";
import type { AgentMessage, PiEvent, SessionStats, TerminalPrompt, ThinkingLevel } from "../shared/src/protocol.ts";
import { BridgeClient } from "./client.ts";
import { type EntryLike, type ModelLike, type RawCommand, commandInfos, extensionCommandName, sessionStats, slimModel, wireEvent } from "./wire.ts";

export type UserContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// The parts of pi's ExtensionAPI the bridge uses.
export interface PiLike {
	sendUserMessage(content: string | UserContent[], options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
	setModel(model: ModelLike): Promise<boolean>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
	getCommands(): RawCommand[];
}

// The parts of pi's ExtensionContext the bridge uses.
export interface CtxLike {
	cwd: string;
	hasUI: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	model: ModelLike | undefined;
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null; getEntries(): EntryLike[] };
	modelRegistry: { getAvailable(): ModelLike[]; find(provider: string, modelId: string): ModelLike | undefined };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	abort(): void;
	getContextUsage(): SessionStats["contextUsage"] | undefined;
	compact(options: { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void }): void;
}

export interface BridgeEnv {
	socketPath: string;
	piVersion: string;
	buildMessages(entries: EntryLike[], leafId: string | null): AgentMessage[];
	thinkingLevels(model: ModelLike | undefined): ThinkingLevel[];
	pid?: number;
	minDelayMs?: number;
	maxDelayMs?: number;
}

// Events after which the hub needs fresh state (model, thinking, name, stats).
const SYNC_AFTER = new Set(["turn_end", "agent_settled", "session_compact_failed", "model_select", "thinking_level_select", "session_info_changed"]);

export class BridgeSession {
	private pi: PiLike;
	private ctx: CtxLike;
	private env: BridgeEnv;
	private client: BridgeClient;
	private compacting: { reason: string } | null = null;
	private prompts: TerminalPrompt[] = [];

	constructor(pi: PiLike, ctx: CtxLike, env: BridgeEnv) {
		this.pi = pi;
		this.ctx = ctx;
		this.env = env;
		this.client = new BridgeClient({
			path: env.socketPath,
			minDelayMs: env.minDelayMs,
			maxDelayMs: env.maxDelayMs,
			onOpen: () => this.hello(),
			onMessage: (m) => void this.onHubMessage(m),
		});
	}

	start(): void {
		this.client.start();
	}

	stop(reason: ByeReason): void {
		this.client.send({ type: "bye", reason });
		this.client.stop();
	}

	onPiEvent(ev: PiEvent, ctx: CtxLike): void {
		this.ctx = ctx;
		if (ev.type === "session_before_compact") this.compacting = { reason: ev.reason };
		if (ev.type === "session_compact" || ev.type === "session_compact_failed") this.compacting = null;
		const wire = wireEvent(ev);
		if (wire) this.client.send({ type: "event", event: wire });
		switch (ev.type) {
			case "ui_prompt_start":
				this.prompts.push({ kind: String(ev.kind), title: String(ev.title ?? "") });
				this.client.send({ type: "prompt_state", prompt: this.prompts.at(-1) ?? null });
				return;
			case "ui_prompt_end":
				this.prompts.pop();
				this.client.send({ type: "prompt_state", prompt: this.prompts.at(-1) ?? null });
				return;
			case "session_compact":
				this.client.send({ type: "sync", sync: this.fullSync() });
				return;
			case "agent_settled":
				// Nothing more runs after a settle, so a compaction that never reported back was cancelled.
				if (this.compacting) {
					this.client.send({ type: "event", event: { type: "compaction_end", reason: this.compacting.reason, aborted: true, willRetry: false } });
					this.compacting = null;
				}
				break;
		}
		if (SYNC_AFTER.has(ev.type)) this.client.send({ type: "sync", sync: this.baseSync() });
	}

	async run(cmd: BridgeCommand): Promise<BridgeResult> {
		try {
			switch (cmd.type) {
				case "prompt": {
					const ext = extensionCommandName(cmd.text, this.pi.getCommands());
					if (ext) return { ok: false, error: `/${ext} is an extension command. Run it in the terminal.` };
					const content: string | UserContent[] = cmd.images?.length
						? [{ type: "text", text: cmd.text }, ...cmd.images.map((i): UserContent => ({ type: "image", data: i.data, mimeType: i.mimeType }))]
						: cmd.text;
					const deliverAs = cmd.mode !== "send" ? cmd.mode : this.ctx.isIdle() ? undefined : "followUp";
					this.pi.sendUserMessage(content, { expandPromptTemplates: true, ...(deliverAs ? { deliverAs } : {}) });
					return { ok: true };
				}
				case "abort":
					this.ctx.abort();
					return { ok: true };
				case "set_model": {
					const model = this.ctx.modelRegistry.find(cmd.provider, cmd.modelId);
					if (!model) return { ok: false, error: `Model not found: ${cmd.provider}/${cmd.modelId}` };
					return (await this.pi.setModel(model)) ? { ok: true } : { ok: false, error: `No API key for ${cmd.provider}/${cmd.modelId}` };
				}
				case "set_thinking":
					this.pi.setThinkingLevel(cmd.level);
					return { ok: true };
				case "rename": {
					const name = cmd.name.trim();
					if (!name) return { ok: false, error: "Session name cannot be empty" };
					this.pi.setSessionName(name);
					return { ok: true };
				}
				case "compact":
					return await new Promise<BridgeResult>((resolve) => {
						this.ctx.compact({
							customInstructions: cmd.instructions,
							onComplete: () => resolve({ ok: true }),
							onError: (err) => resolve({ ok: false, error: err.message }),
						});
					});
			}
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	private async onHubMessage(msg: HubToBridge): Promise<void> {
		if (msg.type === "notice") {
			if (this.ctx.hasUI) this.ctx.ui.notify(msg.text, "info");
			return;
		}
		if (msg.type !== "cmd") return;
		const result = await this.run(msg.command);
		this.client.send({ type: "result", id: msg.id, ...result });
	}

	private hello(): void {
		const sm = this.ctx.sessionManager;
		this.client.send({
			type: "hello",
			protocol: BRIDGE_PROTOCOL,
			sessionId: sm.getSessionId(),
			sessionFile: sm.getSessionFile() ?? null,
			cwd: this.ctx.cwd,
			pid: this.env.pid ?? process.pid,
			piVersion: this.env.piVersion,
			sync: this.fullSync(),
			prompt: this.prompts.at(-1) ?? null,
		});
	}

	private baseSync(): BridgeSync {
		const sm = this.ctx.sessionManager;
		const sessionId = sm.getSessionId();
		const sessionFile = sm.getSessionFile();
		const stats = sessionStats(sm.getEntries(), { sessionId, sessionFile }, this.ctx.getContextUsage());
		const model = this.ctx.model;
		return {
			state: {
				model: model ? slimModel(model) : null,
				thinkingLevel: this.pi.getThinkingLevel(),
				isStreaming: !this.ctx.isIdle(),
				isCompacting: this.compacting !== null,
				sessionName: this.pi.getSessionName(),
				sessionId,
				sessionFile,
				messageCount: stats.totalMessages,
				pendingMessageCount: this.ctx.hasPendingMessages() ? 1 : 0,
				autoCompactionEnabled: true,
			},
			stats,
			thinkingLevels: this.env.thinkingLevels(model),
		};
	}

	private fullSync(): FullSync {
		const sm = this.ctx.sessionManager;
		return {
			...this.baseSync(),
			models: this.ctx.modelRegistry.getAvailable().map(slimModel),
			commands: commandInfos(this.pi.getCommands()),
			messages: this.env.buildMessages(sm.getEntries(), sm.getLeafId()),
		};
	}
}
