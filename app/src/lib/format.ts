import type { AgentMessage, SessionSummary } from "../../../shared/src/protocol.ts";
import { contentText } from "../../../shared/src/reducer.ts";

const trimZero = (s: string) => s.replace(/\.0$/, "");

export function formatTokens(n?: number | null): string {
	if (n == null) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : trimZero(k.toFixed(1))}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : trimZero(m.toFixed(1))}M`;
}

export function formatCost(usd: number): string {
	if (!usd) return "";
	return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function relativeTime(ts: number, now = Date.now()): string {
	const s = Math.max(0, (now - ts) / 1000);
	if (s < 45) return "now";
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86_400) return `${Math.round(s / 3600)}h`;
	if (s < 86_400 * 30) return `${Math.round(s / 86_400)}d`;
	return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function abbreviateCwd(cwd: string, home: string): string {
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export function sessionTitle(s: { name: string | null; firstPrompt: string | null }): string {
	return s.name || s.firstPrompt?.split("\n")[0].slice(0, 80) || "new session";
}

export interface SessionGroup {
	cwd: string;
	label: string;
	sessions: SessionSummary[];
}

// Input is newest-first, so groups come out ordered by their newest session.
export function groupSessions(sessions: SessionSummary[], query: string, home: string): SessionGroup[] {
	const q = query.trim().toLowerCase();
	const groups = new Map<string, SessionGroup>();
	for (const s of sessions) {
		if (q && ![s.name, s.firstPrompt, s.cwd].some((v) => v?.toLowerCase().includes(q))) continue;
		let g = groups.get(s.cwd);
		if (!g) {
			g = { cwd: s.cwd, label: abbreviateCwd(s.cwd, home), sessions: [] };
			groups.set(s.cwd, g);
		}
		g.sessions.push(s);
	}
	return [...groups.values()];
}

const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url"];

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summarizeToolArgs(_name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const key = ARG_KEYS.find((k) => typeof a[k] === "string");
	const text = key ? (a[key] as string) : Object.keys(a).length ? JSON.stringify(a) : "";
	return oneLine(text, 120);
}

// Tool-call arguments arrive as partial JSON while streaming.
export function parseArgsRaw(raw?: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		const m = raw.match(/"(command|path|file_path|pattern|query|url)"\s*:\s*"((?:[^"\\]|\\.)*)/);
		return m ? { [m[1]]: m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"') } : {};
	}
}

export const OUTPUT_LIMIT = 20_000;

export function truncateOutput(text: string, limit = OUTPUT_LIMIT): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n… ${text.length - limit} more characters`;
}

export function wordCount(s: string): number {
	const t = s.trim();
	return t ? t.split(/\s+/).length : 0;
}

export function blocksText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return contentText(content.filter((b) => b !== null && typeof b === "object") as AgentMessage["content"]);
}
