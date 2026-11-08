// Reads pi session files (JSONL entries) into the active branch and its messages.

import type { AgentMessage } from "./protocol.ts";

export type Entry = Record<string, any>;

export function parseEntries(text: string): Entry[] {
	const out: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line);
			if (v && typeof v === "object" && !Array.isArray(v)) out.push(v); // null, numbers, arrays are not entries
		} catch {} // half-written or corrupt line
	}
	return out;
}

// Messages on the active branch: walk from the last entry back to the root.
export function historyFromText(text: string): AgentMessage[] {
	return historyFromEntries(branchEntries(text));
}

// Entries on the active branch, root first (walk from the last entry back to the root).
export function branchEntries(text: string): Entry[] {
	const entries = parseEntries(text);
	const byId = new Map<string, Entry>();
	for (const e of entries) if (e.id) byId.set(e.id, e);
	const path: Entry[] = [];
	const seen = new Set<Entry>();
	for (let e = entries.findLast((x) => x.id); e && !seen.has(e); e = e.parentId ? byId.get(e.parentId) : undefined) {
		seen.add(e); // a parentId cycle would otherwise loop forever
		path.push(e);
	}
	return path.reverse();
}

function historyFromEntries(path: Entry[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const e of path) {
		const ts = Date.parse(e.timestamp);
		if (e.type === "message") {
			const m = e.message;
			if (m && typeof m === "object" && m.role !== "system") out.push(m);
		}
		else if (e.type === "compaction") out.push({ role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: ts });
		else if (e.type === "branch_summary") out.push({ role: "branchSummary", summary: e.summary, timestamp: ts });
		else if (e.type === "custom_message" && e.display) out.push({ role: "custom", customType: e.customType, content: e.content, display: true, timestamp: ts });
	}
	return out;
}

