// The progress panel's "run" section: where the time went in each run (everything after one of Michael's
// messages), and what went wrong on the way. Pure counting over message timestamps; the hub and app share it.

import type { AgentMessage } from "./protocol.ts";

export type RejectKind = "edit retries" | "guard blocks" | "failed commands" | "other";

export interface RunReport {
	label: string; // the user message that started the run, first line, shortened
	startedAt: number;
	elapsedMs: number;
	modelMs: number; // waiting on the model: gaps that end in an assistant message
	toolMs: number; // tools running: gaps that end in a tool result
	toolCalls: number;
	rejected: number;
	rejectedBy: Partial<Record<RejectKind, number>>;
	nudges: Record<string, number>; // guard nudges by kind
	compactions: number[]; // tokens before each compaction
	reviewedAt: number | null; // when a foreground reviewer subagent last returned without error
}

const NUDGE_KINDS: Record<string, string> = { "pi-guard-nudge": "stall", "pi-guard-todos": "to-dos", "pi-guard-pr": "pr" };
const LABEL_MAX = 40;

const textOf = (m: AgentMessage): string =>
	typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");

/** Which kind of rejection a failed tool result is, from its text. */
export function rejectKind(text: string): RejectKind {
	if (/RETRYABLE|PARTIAL APPLY|Edit without read/.test(text)) return "edit retries";
	if (/^Blocked:/.test(text.trimStart())) return "guard blocks";
	if (/(?:Command )?exited with code \d+/.test(text)) return "failed commands";
	return "other";
}

type Call = { type: string; id?: string; name?: string; arguments?: Record<string, unknown> };
const toolCalls = (m: AgentMessage): Call[] => (Array.isArray(m.content) ? (m.content as Call[]).filter((c) => c.type === "toolCall") : []);

function label(m: AgentMessage): string {
	const line = textOf(m).trim().split("\n")[0] ?? "";
	return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
}

function report(user: AgentMessage, rest: AgentMessage[], open: { now: number } | null): RunReport {
	const startedAt = user.timestamp ?? 0;
	const r: RunReport = { label: label(user), startedAt, elapsedMs: 0, modelMs: 0, toolMs: 0, toolCalls: 0, rejected: 0, rejectedBy: {}, nudges: {}, compactions: [], reviewedAt: null };
	const reviewers = new Set<string>();
	let prev: number | null = user.timestamp ?? null;
	let last = user;
	for (const m of rest) {
		const ts = m.timestamp ?? null;
		const gap = prev !== null && ts !== null ? Math.max(0, ts - prev) : 0;
		if (m.role === "assistant") {
			r.modelMs += gap;
			for (const c of toolCalls(m)) {
				r.toolCalls += 1;
				if (c.name === "subagent" && c.arguments?.agent === "reviewer" && c.arguments?.async === false && c.id) reviewers.add(c.id);
			}
		} else if (m.role === "toolResult") {
			r.toolMs += gap;
			if (m.isError) {
				const kind = rejectKind(textOf(m));
				r.rejected += 1;
				r.rejectedBy[kind] = (r.rejectedBy[kind] ?? 0) + 1;
			} else if (typeof m.toolCallId === "string" && reviewers.has(m.toolCallId)) r.reviewedAt = ts;
		} else if (m.role === "custom" && typeof m.customType === "string" && NUDGE_KINDS[m.customType]) {
			const kind = NUDGE_KINDS[m.customType];
			r.nudges[kind] = (r.nudges[kind] ?? 0) + 1;
		} else if (m.role === "compactionSummary" && typeof m.tokensBefore === "number") r.compactions.push(m.tokensBefore);
		if (ts !== null) prev = ts;
		last = m;
	}
	const end = open ? open.now : (prev ?? startedAt);
	// A live run is still waiting on something: tools after a tool call, the model after anything else.
	if (open && prev !== null) {
		const wait = Math.max(0, open.now - prev);
		if (last.role === "assistant" && toolCalls(last).length > 0) r.toolMs += wait;
		else r.modelMs += wait;
	}
	r.elapsedMs = Math.max(0, end - startedAt);
	return r;
}

/** One report per run, oldest first. The last run is live while `streaming`. */
export function runReports(messages: AgentMessage[], opts: { now: number; streaming: boolean }): RunReport[] {
	const out: RunReport[] = [];
	let start = -1;
	for (let i = 0; i <= messages.length; i += 1) {
		if (i < messages.length && messages[i].role !== "user") continue;
		if (start >= 0) {
			const live = i === messages.length && opts.streaming ? { now: opts.now } : null;
			out.push(report(messages[start], messages.slice(start + 1, i), live));
		}
		start = i;
	}
	return out;
}

/** Runs from a session file's branch entries. Each entry is stamped when it was written, which for an
 *  assistant message is when generation ended (its own `timestamp` is when it began); that end time is
 *  what splits waiting on the model from tools running. */
export function runReportsFromEntries(entries: Array<Record<string, any>>, opts: { now: number; streaming: boolean }): RunReport[] {
	const msgs: AgentMessage[] = [];
	for (const e of entries) {
		const timestamp = Date.parse(e.timestamp);
		const at = Number.isNaN(timestamp) ? undefined : timestamp;
		if (e.type === "message" && e.message && e.message.role !== "system") msgs.push({ ...e.message, timestamp: e.message.role === "user" ? (e.message.timestamp ?? at) : at });
		else if (e.type === "custom_message") msgs.push({ role: "custom", customType: e.customType, content: e.content, timestamp: at });
		else if (e.type === "compaction") msgs.push({ role: "compactionSummary", tokensBefore: e.tokensBefore, timestamp: at });
	}
	return runReports(msgs, opts);
}
