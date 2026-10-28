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

// Who answers a permission extension's dialogs during a turn: the hub for every
// tool call (auto), the hub for obviously benign calls only (semi), or the
// person in the app (manual). See hub/src/auto-approve.ts.
export type ApprovalMode = "auto" | "semi" | "manual";
export const APPROVAL_MODES: readonly ApprovalMode[] = ["auto", "semi", "manual"];

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

// A blocking extension dialog open in a terminal pi (bridge sessions only).
// The app can't answer it; it says "waiting for you in the terminal".
export interface TerminalPrompt {
	kind: string; // select | confirm | input | editor | custom
	title: string;
}

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; argsRaw?: string }
	| { type: "image"; mimeType: string; data?: string; ref?: string; width?: number; height?: number };

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
	terminalPrompt: TerminalPrompt | null;
	approvalMode: ApprovalMode;
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
			terminalPrompt: TerminalPrompt | null;
			approvalMode: ApprovalMode;
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
	| { type: "clear_queue" }
	| { type: "set_approval"; mode: ApprovalMode };

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
	"set_approval",
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

// GET /api/defaults: what an unsent chat starts with. `model` is the last pick
// made in pi-web while pi still offers it, else pi's own default;
// `thinkingLevels` are that model's levels (empty when it doesn't reason) and
// `levels` every model's, keyed `provider/id`.
export interface DefaultsInfo {
	models: ModelInfo[];
	model: { provider: string; modelId: string; thinking: ThinkingLevel | null } | null;
	thinkingLevels: ThinkingLevel[];
	levels: Record<string, ThinkingLevel[]>;
	approvalMode: ApprovalMode;
	home: string;
}

// GET /api/update: where the hub's checkout stands against origin/master.
export interface UpdateStatus {
	version: string; // hub/package.json
	commit: string; // short HEAD
	behind: number; // commits on origin/master not in HEAD
	latest: string | null; // "<short> <subject>" of origin/master
	dirty: boolean; // local changes that would stop a fast-forward pull
	fetchError: string | null; // git fetch failed (offline?); behind/latest are then stale
}

// POST /api/update: the hub pulled and installed, and exits right after answering.
export interface UpdateResult {
	ok: true;
	commit: string;
	output: string;
	restarting: boolean;
}

// Web Push (spec §5.5). The payload names the session, why, and optionally a line of detail.
export type PushKind = "finished" | "needs_you" | "error" | "query";

export interface PushPayload {
	sessionId: string;
	title: string;
	kind: PushKind;
	tag?: string; // notifications with the same tag replace each other; absent means one per session
	body?: string; // a short line of detail, clipped to 160 characters; absent means the kind's stock text
}

// A browser PushSubscription as JSON (PushSubscription.toJSON()).
export interface PushSubscriptionInfo {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

// The Pebble watch (spec §4–§6). A query is anything the watch asks the wearer:
// a pi dialog (id dialog:<sessionId>:<dialogId>) or an external service's question (id rp:<n>).
export type QuerySource = "pi" | "ring-profile";

export interface WatchQuery {
	id: string;
	source: QuerySource;
	sessionId: string | null;
	label: string;
	text: string;
	options: string[];
	createdAt: number;
}

export type SessionStatus = "waiting" | "running" | "done" | "error";

export interface WatchSession {
	id: string;
	title: string;
	state: LiveState;
	status: SessionStatus;
	live: boolean;
	model: string | null;
	contextPercent: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
	tps: number | null;
	updatedAt: number;
}

// What the watch reports it has on screen.
export interface Showing {
	queryId: string | null;
	sessionId: string | null;
}

export interface WatchPending {
	cursor: number;
	queries: WatchQuery[];
	showing: Showing | null;
	sessions: WatchSession[];
}

// How an external query ended, as its raiser hears it.
export type QueryOutcome =
	| { kind: "option"; option: string }
	| { kind: "skip" }
	| { kind: "ring-answer"; text: string }
	| { kind: "cleared-by-ring"; text: string }
	| { kind: "expired-delivered" }
	| { kind: "expired-undelivered" };

export type WatchAnswerResult = { ok: true } | { ok: false; reason: "gone" | "no_match"; options?: string[] };

export interface WatchTurn {
	i: number;
	role: "you" | "agent" | "tool";
	text: string;
}

export type WatchStreamFrame = ({ type: "pending" } & WatchPending) | { type: "text"; sessionId: string; text: string; streaming: boolean } | { type: "notice"; text: string };
export type WatchClientFrame = { type: "showing"; queryId: string | null; sessionId: string | null };
