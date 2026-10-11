// Wire types shared by the hub and the app. Pi's own event and message shapes
// pass through untouched (PiEvent, AgentMessage); everything else is ours.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface SessionStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
	sessionFile?: string;
	sessionId?: string;
}

export interface SessionStateInfo {
	model: ModelInfo | null;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionName?: string;
	sessionId: string;
	sessionFile?: string;
	messageCount: number;
	pendingMessageCount: number;
	autoCompactionEnabled: boolean;
}

export interface CommandInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export type DialogMethod = "select" | "confirm" | "input" | "editor";

export interface Dialog {
	id: string;
	method: DialogMethod;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
}

export type HandleKind = "rpc" | "bridge";

export interface Capabilities {
	dialogs: "here" | "terminal";
	fork: boolean;
	clone: boolean;
	newSession: boolean;
	bash: boolean;
	export: boolean;
}

export interface Widget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; argsRaw?: string }
	| { type: "image"; data: string; mimeType: string };

// Pi AgentMessage: user | assistant | toolResult | bashExecution | custom |
// compactionSummary | branchSummary (system messages are filtered out).
export interface AgentMessage {
	role: string;
	content?: string | ContentBlock[];
	timestamp?: number;
	[key: string]: unknown;
}

// Any pi session event as emitted in RPC mode (see pi docs/json.md).
export interface PiEvent {
	type: string;
	[key: string]: any;
}

export interface ToolResultPayload {
	content?: ContentBlock[];
	details?: unknown;
}

export interface ToolRun {
	name: string;
	args?: unknown;
	running: boolean;
	partialResult?: ToolResultPayload;
	result?: ToolResultPayload;
	isError?: boolean;
}

export interface Conversation {
	messages: AgentMessage[];
	partial: AgentMessage | null;
	tools: Record<string, ToolRun>;
	streaming: boolean;
	compacting: boolean;
	queue: { steering: string[]; followUp: string[] };
	retry: { attempt: number; max: number; error?: string } | null;
}

export interface Snapshot {
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	handleKind: HandleKind;
	capabilities: Capabilities;
	conv: Conversation;
	state: SessionStateInfo;
	stats: SessionStats | null;
	models: ModelInfo[];
	thinkingLevels: ThinkingLevel[];
	commands: CommandInfo[];
	dialogs: Dialog[];
	statuses: Record<string, string>;
	widgets: Record<string, Widget>;
}

export type StreamMessage =
	| { type: "snapshot"; snapshot: Snapshot }
	| { type: "detached" }
	| { type: "event"; event: PiEvent }
	| {
			type: "meta";
			state: SessionStateInfo;
			stats: SessionStats | null;
			statuses: Record<string, string>;
			widgets: Record<string, Widget>;
			thinkingLevels: ThinkingLevel[];
	  }
	| { type: "dialog"; dialog: Dialog }
	| { type: "dialog_closed"; id: string }
	| { type: "notify"; message: string; level: "info" | "warning" | "error" }
	| { type: "editor_text"; text: string }
	| { type: "command_error"; command: string; error: string }
	| { type: "handle_gone"; reason: "exit" | "closed"; stderr?: string }
	| { type: "error"; message: string };

export type PromptMode = "send" | "steer" | "followUp";

export interface ImageInput {
	data: string; // base64, no data: prefix
	mimeType: string;
}

export type AppCommand =
	| { type: "attach" } // start pi for this session if needed; otherwise a no-op
	| { type: "prompt"; text: string; images?: ImageInput[]; mode: PromptMode }
	| { type: "abort" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking"; level: ThinkingLevel }
	| { type: "compact"; instructions?: string }
	| { type: "rename"; name: string }
	| { type: "get_fork_points" }
	| { type: "fork"; entryId: string }
	| { type: "clone" }
	| { type: "new_session" }
	| { type: "bash"; command: string; excludeFromContext: boolean }
	| { type: "export" }
	| { type: "dialog_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean }
	| { type: "clear_queue" };

export const APP_COMMAND_TYPES: readonly AppCommand["type"][] = [
	"attach",
	"prompt",
	"abort",
	"set_model",
	"set_thinking",
	"compact",
	"rename",
	"get_fork_points",
	"fork",
	"clone",
	"new_session",
	"bash",
	"export",
	"dialog_response",
	"clear_queue",
];

export interface CommandResult {
	ok: boolean;
	data?: unknown;
	error?: string;
	pending?: boolean; // prompt accepted but pi has not acknowledged yet (e.g. a dialog is open)
}

export interface ForkPoint {
	entryId: string;
	text: string;
}

export type LiveState = "idle" | "running" | "needs_you" | "error";

export interface SessionSummary {
	id: string;
	cwd: string;
	name: string | null;
	firstPrompt: string | null;
	userMessages: number;
	model: string | null;
	contextTokens: number | null;
	createdAt: number;
	updatedAt: number;
	parentSession: string | null;
	live: boolean;
	handleKind: HandleKind | null;
	state: LiveState;
}

export type ListMessage =
	| { type: "session_state"; sessionId: string; live: boolean; handleKind: HandleKind | null; state: LiveState }
	| { type: "session_list_changed" };

export interface HealthInfo {
	ok: true;
	login: string;
	hubVersion: string;
	vapidPublicKey: string | null;
}
