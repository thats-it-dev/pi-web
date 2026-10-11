// Folds pi RPC session events into a conversation view: completed messages,
// the in-flight assistant message, and live tool runs. The hub keeps one per
// session so late joiners get a snapshot; the app applies the same events live.

import type { AgentMessage, Conversation, PiEvent } from "./protocol.ts";

export type ConversationChange = "status" | "partial" | "messages" | "tools" | "queue" | null;

export function createConversation(messages: AgentMessage[] = []): Conversation {
	return {
		messages: messages.filter((m) => m.role !== "system"),
		partial: null,
		tools: {},
		streaming: false,
		compacting: false,
		queue: { steering: [], followUp: [] },
		retry: null,
	};
}

export function applyEvent(conv: Conversation, ev: PiEvent): ConversationChange {
	switch (ev.type) {
		case "agent_start":
			conv.streaming = true;
			return "status";
		case "agent_settled":
			conv.streaming = false;
			conv.partial = null;
			conv.retry = null;
			return "status";
		case "message_start":
			// Deltas rebuild every block, so start from empty even if pi prefilled content.
			if (ev.message?.role === "assistant") {
				conv.partial = { ...ev.message, content: [] };
				return "partial";
			}
			return null;
		case "message_update":
			conv.partial ??= { role: "assistant", content: [] };
			applyDelta(conv.partial, ev.assistantMessageEvent);
			if (ev.usage) conv.partial.usage = ev.usage;
			return "partial";
		case "message_end": {
			const m = ev.message as AgentMessage | undefined;
			if (!m || m.role === "system") return null;
			if (m.role === "assistant") conv.partial = null;
			conv.messages.push(m);
			return "messages";
		}
		case "tool_execution_start":
			conv.tools[ev.toolCallId] = { name: ev.toolName, args: ev.args, running: true };
			return "tools";
		case "tool_execution_update":
			conv.tools[ev.toolCallId] = { ...conv.tools[ev.toolCallId], name: ev.toolName, args: ev.args, running: true, partialResult: ev.partialResult };
			return "tools";
		case "tool_execution_end":
			conv.tools[ev.toolCallId] = { ...conv.tools[ev.toolCallId], name: ev.toolName, running: false, result: ev.result, isError: ev.isError };
			return "tools";
		case "queue_update":
			conv.queue = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
			return "queue";
		case "compaction_start":
			conv.compacting = true;
			return "status";
		case "compaction_end":
			conv.compacting = false;
			return "status";
		case "auto_retry_start":
			conv.retry = { attempt: ev.attempt, max: ev.maxAttempts, error: ev.errorMessage };
			return "status";
		case "auto_retry_end":
			conv.retry = null;
			return "status";
		default:
			return null;
	}
}

function applyDelta(msg: AgentMessage, d: any): void {
	if (!d) return;
	if (!Array.isArray(msg.content)) msg.content = [];
	const c = msg.content as any[];
	const i = d.contentIndex;
	switch (d.type) {
		case "text_start":
			c[i] = { type: "text", text: "" };
			break;
		case "text_delta":
			c[i] ??= { type: "text", text: "" };
			c[i].text += d.delta;
			break;
		case "text_end":
			c[i] = { type: "text", text: d.content ?? c[i]?.text ?? "" };
			break;
		case "thinking_start":
			c[i] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			c[i] ??= { type: "thinking", thinking: "" };
			c[i].thinking += d.delta;
			break;
		case "thinking_end":
			c[i] = { type: "thinking", thinking: d.content ?? c[i]?.thinking ?? "" };
			break;
		case "toolcall_start":
			c[i] = { type: "toolCall", id: d.id, name: d.toolName, arguments: {}, argsRaw: "" };
			break;
		case "toolcall_delta":
			c[i] ??= { type: "toolCall", id: "", name: "", arguments: {}, argsRaw: "" };
			c[i].argsRaw = (c[i].argsRaw ?? "") + d.delta;
			break;
		case "toolcall_end":
			if (d.toolCall) c[i] = d.toolCall;
			break;
	}
}

export function contentText(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("\n");
}
