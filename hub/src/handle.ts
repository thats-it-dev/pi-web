// The seam between the hub and "something running a pi session". RpcHandle
// (headless child) and BridgeHandle (terminal pi) implement it.

import type { AppCommand, Capabilities, CommandResult, HandleKind, LiveState, Snapshot, StreamMessage } from "../../shared/src/protocol.ts";

export type HandleEvent =
	| { type: "state_changed" }
	| { type: "renamed" }
	| { type: "session_changed"; from: string; to: string }
	| { type: "exit"; code: number | null; stderr: string; closedByHub: boolean };

export interface SessionHandle {
	readonly kind: HandleKind;
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
	readonly pid: number;
	readonly capabilities: Capabilities;
	lastActive: number;
	subscriberCount(): number;
	isBusy(): boolean; // running, compacting, or waiting on a dialog
	liveState(): LiveState;
	snapshot(): Snapshot;
	command(cmd: AppCommand): Promise<CommandResult>;
	subscribe(fn: (msg: StreamMessage) => void): () => void;
	onEvent(fn: (e: HandleEvent) => void): () => void;
	notice?(text: string): void; // bridge only: shown in the terminal TUI
	close(): void;
}
