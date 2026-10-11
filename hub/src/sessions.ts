// Finds pi sessions on disk so ones started from the CLI show up next to ones
// started from the app. Each file is parsed once per (mtime, size).

import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, SessionSummary } from "../../shared/src/protocol.ts";
import { contentText } from "../../shared/src/reducer.ts";

export type FileSummary = Omit<SessionSummary, "live" | "handleKind" | "state"> & { file: string };

type Entry = Record<string, any>;

export function sessionsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
	const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		if (typeof settings.sessionDir === "string" && settings.sessionDir) return settings.sessionDir.replace(/^~(?=\/|$)/, home);
	} catch {}
	return join(agentDir, "sessions");
}

function parseEntries(text: string): Entry[] {
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

export function summarize(file: string, text: string, mtimeMs: number): FileSummary | null {
	const entries = parseEntries(text);
	const header = entries[0];
	if (header?.type !== "session" || typeof header.id !== "string") return null;
	let name: string | null = null;
	let firstPrompt: string | null = null;
	let userMessages = 0;
	let model: string | null = null;
	let contextTokens: number | null = null;
	for (const e of entries) {
		if (e.type === "session_info") name = e.name || null;
		else if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
		else if (e.type === "message") {
			const m = e.message;
			if (m?.role === "user") {
				userMessages++;
				firstPrompt ??= contentText(m.content).trim().slice(0, 200) || null;
			} else if (m?.role === "assistant") {
				if (m.provider && m.model) model = `${m.provider}/${m.model}`;
				const u = m.usage;
				if (u && m.stopReason !== "aborted" && m.stopReason !== "error") contextTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
			}
		}
	}
	return {
		id: header.id,
		file,
		cwd: typeof header.cwd === "string" ? header.cwd : "",
		name,
		firstPrompt,
		userMessages,
		model,
		contextTokens,
		createdAt: Date.parse(header.timestamp) || mtimeMs,
		updatedAt: mtimeMs,
		parentSession: header.parentSession ?? null,
	};
}

export class SessionIndex {
	readonly dir: string;
	private cache = new Map<string, { mtimeMs: number; size: number; summary: FileSummary | null }>();

	constructor(dir: string) {
		this.dir = dir;
	}

	async list(): Promise<FileSummary[]> {
		if (!existsSync(this.dir)) return [];
		const out: FileSummary[] = [];
		for (const sub of await readdir(this.dir, { withFileTypes: true })) {
			if (!sub.isDirectory()) continue;
			const subdir = join(this.dir, sub.name);
			let names: string[];
			try {
				names = await readdir(subdir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				const file = join(subdir, name);
				try {
					const st = await stat(file);
					let hit = this.cache.get(file);
					if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
						hit = { mtimeMs: st.mtimeMs, size: st.size, summary: summarize(file, await readFile(file, "utf8"), st.mtimeMs) };
						this.cache.set(file, hit);
					}
					if (hit.summary) out.push(hit.summary);
				} catch {} // file vanished between readdir and stat
			}
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async find(id: string): Promise<FileSummary | null> {
		return (await this.list()).find((s) => s.id === id) ?? null;
	}
}

// Messages on the active branch: walk from the last entry back to the root.
export function historyFromText(text: string): AgentMessage[] {
	const entries = parseEntries(text);
	const byId = new Map<string, Entry>();
	for (const e of entries) if (e.id) byId.set(e.id, e);
	const path: Entry[] = [];
	const seen = new Set<Entry>();
	for (let e = entries.findLast((x) => x.id); e && !seen.has(e); e = e.parentId ? byId.get(e.parentId) : undefined) {
		seen.add(e); // a parentId cycle would otherwise loop forever
		path.push(e);
	}
	path.reverse();
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

export async function readHistory(file: string): Promise<AgentMessage[]> {
	return historyFromText(await readFile(file, "utf8"));
}

export function knownCwds(summaries: FileSummary[], home: string): string[] {
	const counts = new Map<string, number>();
	for (const s of summaries) if (s.cwd) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
	if (!counts.has(home)) counts.set(home, 0);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([cwd]) => cwd)
		.filter((cwd) => existsSync(cwd));
}
