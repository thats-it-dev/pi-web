// Pure parsers for a bench run's artifacts: the session JSONL pi wrote, the guard's block log, and the guard's prompt
// digest. No side effects, no spawning — run.ts does the running, this turns the files into one metrics record so the
// numbers are testable without a model. Every field here is a cheap proxy the 2026-11-24 harness review's protocol
// asks for; the oracle (pass/fail, lint count) comes from the task, not from here.

/** One assistant turn's cost and shape, summed over a session. */
export interface SessionMetrics {
	turns: number; // assistant messages
	toolCalls: number;
	byTool: Record<string, number>; // tool name -> count
	harnessTurns: number; // turns whose only tool calls are subagent/ask/todo/preview — planning and review, not work
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheHitRatio: number; // cacheRead / (input + cacheRead), 0 when nothing ran
	peakContextTokens: number;
	compactions: number;
	asks: number; // ask_user_question calls = interventions
	subagents: number; // subagent launches (reviewer/worker/scout)
	models: string[]; // every model the session ran on, in order of first use
}

const WORK_TOOLS = new Set(["edit", "write", "bash", "bg_bash"]);
const HARNESS_ONLY = new Set(["subagent", "ask_user_question", "todo", "preview"]);

/** Parses the lines of one session JSONL (pi writes one JSON object per line). Tolerant of blank and unparseable lines. */
export function parseSession(jsonl: string): SessionMetrics {
	const m: SessionMetrics = {
		turns: 0, toolCalls: 0, byTool: {}, harnessTurns: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
		cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRatio: 0, peakContextTokens: 0, compactions: 0, asks: 0, subagents: 0, models: [],
	};
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "compaction" || e.type === "compaction_summary" || e.type === "compactionSummary") m.compactions++;
		if (e.type === "model_change" && typeof e.modelId === "string") {
			const name = `${e.provider ?? ""}/${e.modelId}`.replace(/^\//, "");
			if (!m.models.includes(name)) m.models.push(name);
		}
		const msg = (e.message ?? e) as Record<string, unknown>;
		if (msg.role !== "assistant") continue;
		m.turns++;
		const u = (msg.usage ?? {}) as Record<string, number>;
		m.inputTokens += u.input ?? 0;
		m.outputTokens += u.output ?? 0;
		m.reasoningTokens += u.reasoning ?? 0;
		m.cacheReadTokens += u.cacheRead ?? 0;
		m.cacheWriteTokens += u.cacheWrite ?? 0;
		m.peakContextTokens = Math.max(m.peakContextTokens, (u.input ?? 0) + (u.cacheRead ?? 0));
		const calls = (Array.isArray(msg.content) ? msg.content : []).filter((c) => (c as { type?: string }).type === "toolCall") as { name?: string }[];
		let onlyHarness = calls.length > 0;
		for (const c of calls) {
			const name = c.name ?? "unknown";
			m.toolCalls++;
			m.byTool[name] = (m.byTool[name] ?? 0) + 1;
			if (name === "ask_user_question") m.asks++;
			if (name === "subagent") m.subagents++;
			if (WORK_TOOLS.has(name)) onlyHarness = false;
			else if (!HARNESS_ONLY.has(name)) onlyHarness = false; // a read/grep/ls is neither; don't count the turn as pure harness
		}
		if (onlyHarness) m.harnessTurns++;
	}
	const denom = m.inputTokens + m.cacheReadTokens;
	m.cacheHitRatio = denom > 0 ? Number((m.cacheReadTokens / denom).toFixed(3)) : 0;
	return m;
}

/** A block the guard wrote to pi-guard-blocks.jsonl: the reason key is what the measurement tallies, with a
 *  hand-set false-positive flag added later. */
export interface BlockRow {
	t: string;
	reason: string;
	tool: string;
	child: boolean;
}

/** The blocks in a window [t0, t1] (ISO strings). Each run brackets its own; a null t1 means "to the end". */
export function scanBlocks(jsonl: string, t0: string, t1: string | null = null): BlockRow[] {
	const out: BlockRow[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as Record<string, unknown>;
			const t = String(e.t ?? "");
			if (t < t0 || (t1 !== null && t > t1)) continue;
			out.push({ t, reason: String(e.reason ?? "?"), tool: String(e.tool ?? "?"), child: e.child === true });
		} catch {
			// skip
		}
	}
	return out;
}

export interface BlockTally {
	total: number;
	byReason: Record<string, number>;
}

export function tallyBlocks(rows: BlockRow[]): BlockTally {
	const byReason: Record<string, number> = {};
	for (const r of rows) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
	return { total: rows.length, byReason };
}

/** The fresh-parent request in a window: the smallest-message parent digest entry (child=false), by payload size.
 *  That is the static-prefix tax the budget watches, independent of how far a session ran. */
export function freshParent(digestJsonl: string, t0: string, t1: string | null = null): { chars: number; tools: number; sysChars: number } | null {
	let best: { chars: number; tools: number; sysChars: number; msgs: number } | null = null;
	for (const line of digestJsonl.split("\n")) {
		if (!line.trim()) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const t = String(e.t ?? "");
		if (t < t0 || (t1 !== null && t > t1) || e.child === true) continue;
		const msgs = Array.isArray(e.msgs) ? e.msgs.length : Infinity;
		if (best === null || msgs < best.msgs) best = { chars: Number(e.chars ?? 0), tools: Number(e.tools ?? 0), sysChars: Number(e.sysChars ?? 0), msgs };
	}
	return best ? { chars: best.chars, tools: best.tools, sysChars: best.sysChars } : null;
}

export interface RunMetrics extends SessionMetrics {
	task: string;
	arm: string;
	model: string;
	wallSeconds: number;
	timedOut: boolean;
	oraclePass: boolean;
	oracleDetail: string;
	lintViolations: number | null;
	blocks: BlockTally;
	fresh: { chars: number; tools: number; sysChars: number } | null;
}
