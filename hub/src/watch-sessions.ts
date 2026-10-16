// Pure mappings behind the watch's sessions list and history screen (spec §5,
// §7.7, §7.8): short model names, closed-session rows from the file index, and
// a conversation flattened into one-line-ish turns.

import { basename } from "node:path";
import type { LiveStats } from "../../shared/src/live-stats.ts";
import type { AgentMessage, ToolRun, WatchSession, WatchTurn } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";
import type { SessionHandle } from "./handle.ts";
import { sessionTitle } from "./push-watch.ts";
import type { FileSummary } from "./sessions.ts";

const TURN_MAX = 240;
const TITLE_MAX = 60;

// "ollama/qwen3:32b" → "qwen3": the part after the last "/", cut at the first ":".
export function shortModel(model: string | null): string | null {
	if (!model) return null;
	const tail = model.slice(model.lastIndexOf("/") + 1);
	return tail.split(":")[0] || null;
}

// A live session: context from the handle's stats, else the live estimate; speed from the stream.
export function liveSession(h: SessionHandle, live: LiveStats | undefined): WatchSession {
	const snap = h.snapshot();
	const ctx = snap.stats?.contextUsage;
	const est = live?.context();
	const percent = ctx?.percent ?? est?.percent ?? null;
	const tps = live?.speed()?.tps;
	return {
		id: h.sessionId,
		title: sessionTitle(snap),
		state: h.liveState(),
		live: true,
		model: shortModel(snap.state.model?.id ?? null),
		contextPercent: percent === null ? null : Math.round(percent),
		contextTokens: ctx?.tokens ?? est?.tokens ?? null,
		contextWindow: ctx?.contextWindow ?? est?.contextWindow ?? null,
		tps: tps === undefined ? null : Math.round(tps),
		updatedAt: h.lastActive,
	};
}

// A session that has no live handle, as the watch lists it.
export function closedSession(s: FileSummary): WatchSession {
	const first = s.firstPrompt?.trim().split("\n")[0]?.trim();
	const title = s.name?.trim() || first || basename(s.cwd) || "pi";
	return {
		id: s.id,
		title: clipTo(title, TITLE_MAX),
		state: "idle",
		live: false,
		model: shortModel(s.model),
		contextPercent: null,
		contextTokens: s.contextTokens,
		contextWindow: null,
		tps: null,
		updatedAt: s.updatedAt,
	};
}

// User text → "you"; assistant text → "agent"; each tool call → one "tool" line.
// Tool results, bash executions, custom messages and summaries are skipped.
export function turnsFrom(messages: AgentMessage[], tools: Record<string, ToolRun>): WatchTurn[] {
	const out: WatchTurn[] = [];
	const add = (role: WatchTurn["role"], text: string) => {
		const t = text.trim();
		if (t) out.push({ i: out.length, role, text: clipTo(t, TURN_MAX) });
	};
	for (const m of messages) {
		if (m.role === "user") add("you", contentText(m.content));
		else if (m.role === "assistant") {
			add("agent", contentText(m.content));
			if (!Array.isArray(m.content)) continue;
			for (const b of m.content) {
				if (b.type !== "toolCall") continue;
				const args = (tools[b.id]?.args ?? b.arguments ?? {}) as Record<string, unknown>;
				const line = String(args.command ?? args.path ?? JSON.stringify(args)).trim().split("\n")[0] ?? "";
				add("tool", `${b.name} · ${line}`);
			}
		}
	}
	return out;
}

export function clipTo(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
