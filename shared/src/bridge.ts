// Bridge ↔ hub wire protocol (spec §2.3): newline-delimited JSON over the
// hub's Unix socket. The bridge is a pi extension inside a terminal `pi`.
// Events use pi's RPC shapes, so the shared reducer serves both handle kinds.

import type { AgentMessage, AppCommand, CommandInfo, ModelInfo, PiEvent, SessionStateInfo, SessionStats, TerminalPrompt, ThinkingLevel } from "./protocol.ts";

export const BRIDGE_PROTOCOL = 1;

// State the bridge pushes after turns, model, thinking and name changes.
export interface BridgeSync {
	state: SessionStateInfo;
	stats: SessionStats | null;
	thinkingLevels: ThinkingLevel[];
}

// Everything a snapshot needs; sent with hello and after compaction.
export interface FullSync extends BridgeSync {
	models: ModelInfo[];
	commands: CommandInfo[];
	messages: AgentMessage[];
}

// The app commands a terminal pi can run (spec §2.2 capability table).
export type BridgeCommand = Extract<AppCommand, { type: "prompt" | "abort" | "set_model" | "set_thinking" | "compact" | "rename" }>;

export type ByeReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface BridgeHello {
	type: "hello";
	protocol: number;
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	pid: number;
	piVersion: string;
	sync: FullSync;
	prompt: TerminalPrompt | null;
}

export interface BridgeResult {
	ok: boolean;
	data?: unknown;
	error?: string;
}

export type BridgeToHub =
	| BridgeHello
	| { type: "event"; event: PiEvent }
	| { type: "sync"; sync: BridgeSync | FullSync }
	| { type: "prompt_state"; prompt: TerminalPrompt | null }
	| ({ type: "result"; id: string } & BridgeResult)
	| { type: "bye"; reason: ByeReason };

export type HubToBridge = { type: "cmd"; id: string; command: BridgeCommand } | { type: "notice"; text: string };
