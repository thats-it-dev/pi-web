// Pure translations from pi's in-process extension shapes to the wire shapes
// the hub and app already know from RPC mode (pi docs/json.md).

import type { CommandInfo, ModelInfo, PiEvent, SessionStats } from "../shared/src/protocol.ts";

// Every pi event the bridge listens to. Its handlers only observe.
export const FORWARDED_EVENTS = [
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"session_tree",
	"ui_prompt_start",
	"ui_prompt_end",
	"model_select",
	"thinking_level_select",
	"session_info_changed",
] as const;

export interface ModelLike {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelInfo["cost"];
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface EntryLike {
	type: string;
	usage?: UsageLike;
	message?: { role: string; content?: unknown; usage?: UsageLike };
}

export interface RawCommand {
	name: string;
	description?: string;
	source: string;
}

export function slimModel(m: ModelLike): ModelInfo {
	return {
		id: m.id,
		name: m.name ?? m.id,
		provider: m.provider,
		reasoning: Boolean(m.reasoning),
		input: m.input ?? ["text"],
		contextWindow: m.contextWindow ?? 0,
		maxTokens: m.maxTokens ?? 0,
		cost: m.cost,
	};
}

// RPC mode sends message_update as {usage, assistantMessageEvent} with the
// accumulated `partial` removed (pi's toJsonEvent); the bridge matches it.
export function wireEvent(ev: PiEvent): PiEvent | null {
	switch (ev.type) {
		case "agent_start":
		case "agent_end":
		case "agent_settled":
			return { type: ev.type };
		case "turn_start":
			return { type: "turn_start", turnIndex: ev.turnIndex, timestamp: ev.timestamp };
		case "turn_end":
			return { type: "turn_end", turnIndex: ev.turnIndex };
		case "message_start":
		case "message_end":
			return ev.message?.role === "system" ? null : { type: ev.type, message: ev.message };
		case "message_update":
			return { type: "message_update", usage: ev.message?.usage, assistantMessageEvent: stripPartial(ev.assistantMessageEvent) };
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return { ...ev };
		case "session_before_compact":
			return { type: "compaction_start", reason: ev.reason };
		case "session_compact":
			return { type: "compaction_end", reason: ev.reason, aborted: false, willRetry: ev.willRetry };
		case "session_compact_failed":
			return { type: "compaction_end", reason: ev.reason, aborted: ev.aborted, willRetry: ev.willRetry, errorMessage: ev.errorMessage };
		default:
			return null;
	}
}

function stripPartial(d: any): any {
	if (!d || typeof d !== "object" || !("partial" in d)) return d;
	const { partial, ...delta } = d;
	if (d.type !== "toolcall_start") return delta;
	const call = partial?.content?.[d.contentIndex];
	return { ...delta, id: call?.id, toolName: call?.name };
}

// The same totals as pi's AgentSession.getSessionStats(), which extensions can't call.
export function sessionStats(entries: EntryLike[], ids: { sessionId: string; sessionFile?: string }, contextUsage: SessionStats["contextUsage"]): SessionStats {
	const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const add = (u?: UsageLike) => {
		if (!u) return;
		t.input += u.input ?? 0;
		t.output += u.output ?? 0;
		t.cacheRead += u.cacheRead ?? 0;
		t.cacheWrite += u.cacheWrite ?? 0;
		t.cost += u.cost?.total ?? 0;
	};
	const n = { user: 0, assistant: 0, toolResults: 0, total: 0, toolCalls: 0 };
	for (const e of entries) {
		if (e.type === "usage" || ((e.type === "branch_summary" || e.type === "compaction") && e.usage)) add(e.usage);
		if (e.type !== "message" || !e.message) continue;
		n.total++;
		const m = e.message;
		if (m.role === "user") n.user++;
		else if (m.role === "toolResult") {
			n.toolResults++;
			add(m.usage);
		} else if (m.role === "assistant") {
			n.assistant++;
			if (Array.isArray(m.content)) n.toolCalls += m.content.filter((c) => (c as { type?: string }).type === "toolCall").length;
			add(m.usage);
		}
	}
	return {
		sessionFile: ids.sessionFile,
		sessionId: ids.sessionId,
		userMessages: n.user,
		assistantMessages: n.assistant,
		toolCalls: n.toolCalls,
		toolResults: n.toolResults,
		totalMessages: n.total,
		tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, total: t.input + t.output + t.cacheRead + t.cacheWrite },
		cost: t.cost,
		contextUsage,
	};
}

const SOURCES = new Set(["extension", "prompt", "skill"]);

export function commandInfos(cmds: RawCommand[]): CommandInfo[] {
	return cmds.filter((c) => SOURCES.has(c.source)).map((c) => ({ name: c.name, description: c.description, source: c.source as CommandInfo["source"] }));
}

// pi.sendUserMessage never runs extension commands; it would send "/ask" to the model.
export function extensionCommandName(text: string, cmds: RawCommand[]): string | null {
	const m = text.trim().match(/^\/(\S+)/);
	return m && cmds.some((c) => c.source === "extension" && c.name === m[1]) ? m[1] : null;
}
