// Derives the progress panel's data (to-dos, subagents, plan file) from a conversation.
// Pure: the hub and the app both call it on the same Conversation.

import type { AgentMessage, Conversation } from "./protocol.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export interface Todo { id: number; subject: string; status: TodoStatus; activeForm?: string }
export type ChildState = "running" | "done" | "failed" | "stopped" | "unknown";
export interface SubagentChild {
	key: string; // `${toolCallId}:${index}`
	toolCallId: string;
	index: number;
	agent: string;
	task: string; // from the toolCall's arguments: results[].task is the literal "[prompt redacted]"
	state: ChildState;
	background: boolean;
	turn: number; // number of user messages before the spawning toolCall
	startedAt: number | null;
	endedAt: number | null; // ms epoch
	sessionFile: string | null;
	asyncDir: string | null;
	runId: string | null; // the parent's recorded details.runId/asyncId (from partialResult while running); unvalidated
}
export type PrCi = "running" | "passed" | "failed" | "lost" | "none";
export interface LatestPr {
	url: string;
	number: number | null;
	title: string | null;
	ci: PrCi;
	preview: string | null;
	gatewayPreview: string | null;
	reason: string | null;
}
export interface Progress { todos: Todo[] | null; subagents: SubagentChild[]; planPath: string | null; pr: LatestPr | null }

export const PLAN_PATH_RE = /(^|\/)docs\/superpowers\/plans\/[^/]+\.md$/;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const rec = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);

interface Spec { agent: string | null; task: string | null }

// Children the call asked for: a single {agent, task}, parallel `tasks[]` or `chain[]`.
function specsFromArgs(args: Record<string, any> | null): Spec[] {
	if (!args) return [];
	for (const key of ["tasks", "chain"]) {
		if (Array.isArray(args[key]) && args[key].length) {
			return args[key].map((s: unknown) => {
				const r = rec(s);
				return { agent: str(r?.agent), task: str(r?.task) };
			});
		}
	}
	return [{ agent: str(args.agent), task: str(args.task) }];
}

function childState(r: Record<string, any> | undefined, isError: boolean): ChildState {
	if (r?.stopped || r?.interrupted || r?.timedOut) return "stopped";
	if (isError || (typeof r?.exitCode === "number" && r.exitCode !== 0)) return "failed";
	return "done";
}

const PR_CMD_RE = /thatsit-app\.ts\s+(?:gateway-)?pr\s/;
const PR_WAIT_RE = /(?:gateway-)?pr-wait\b/;

// Text of a message's content: a string, or the text parts of a content array.
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n");
}

// The last `RESULT {...}` line's JSON object, if there is one.
function resultOf(text: string): Record<string, any> | null {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i].trim();
		if (!l.startsWith("RESULT ")) continue;
		try {
			return rec(JSON.parse(l.slice(7)));
		} catch {
			return null;
		}
	}
	return null;
}

const firstLine = (v: unknown): string | null => str(typeof v === "string" ? v.split("\n").find((l) => l.trim()) : null)?.trim() ?? null;

export function deriveProgress(conv: Conversation, opts: { live: boolean }): Progress {
	let pr: LatestPr | null = null;
	let prJob: string | null = null; // the pr-wait job of the latest PR
	let prDone: { code: string; text: string } | null = null;
	const commands = new Map<string, string>();
	let todos: Todo[] | null = null;
	let planPath: string | null = null;
	let turn = 0;
	const pending: Array<{ id: string; args: Record<string, any> | null; turn: number; at: number | null }> = [];
	const results = new Map<string, AgentMessage>();

	for (const m of conv.messages) {
		if (m.role === "toolResult" && typeof m.toolCallId === "string") {
			results.set(m.toolCallId, m);
			const cmd = commands.get(m.toolCallId);
			if (cmd && m.toolName === "bash" && PR_CMD_RE.test(cmd)) {
				const r = resultOf(textOf(m.content));
				if (r?.ok === true && typeof r.pr === "string") {
					pr = { url: r.pr, number: typeof r.number === "number" ? r.number : null, title: /--title\s+(?:"([^"]*)"|'([^']*)')/.exec(cmd)?.slice(1).find((x) => x != null) ?? null, ci: "none", preview: null, gatewayPreview: null, reason: null };
					prJob = null;
					prDone = null;
				}
			} else if (cmd && pr && m.toolName === "bg_bash" && PR_WAIT_RE.test(cmd)) {
				prJob = /started job (bg-\d+)/.exec(textOf(m.content))?.[1] ?? str(rec(m.details)?.id);
				prDone = null;
			}
			if (m.toolName === "todo") {
				const tasks = rec(m.details)?.tasks;
				if (Array.isArray(tasks)) {
					todos = tasks
						.filter((t) => rec(t) && typeof t.id === "number" && typeof t.subject === "string" && t.status !== "deleted")
						.map((t) => ({ id: t.id, subject: t.subject, status: t.status ?? "pending", ...(t.activeForm ? { activeForm: t.activeForm } : {}) }));
				}
			}
		} else if (m.role === "custom" && m.customType === "bg-bash-done") {
			const text = textOf(m.content);
			const head = /^bg_bash job (bg-\d+) (?:exited (\S+)|was (cancelled|killed))/.exec(text);
			if (pr && prJob && head && head[1] === prJob) prDone = { code: head[2] ?? head[3], text };
		} else if (m.role === "user") turn++;
		else if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const c of m.content) {
				if (c.type !== "toolCall") continue;
				const args = rec(c.arguments);
				if ((c.name === "bash" || c.name === "bg_bash") && typeof args?.command === "string") commands.set(c.id, args.command);
				if (c.name === "subagent") pending.push({ id: c.id, args, turn, at: m.timestamp ?? null });
				else if ((c.name === "read" || c.name === "edit" || c.name === "write") && PLAN_PATH_RE.test(str(args?.path) ?? "")) planPath = args!.path;
			}
		}
	}

	const subagents: SubagentChild[] = [];
	for (const call of pending) {
		const msg = results.get(call.id);
		const run = conv.tools[call.id];
		// Async is pi-subagents' default, so a pending call without `async: false` is a background run.
		// Finished only once a result exists; exitCode is already 0 while a child runs.
		const finished = !!msg || (run?.running === false && !!run.result);
		const details = rec(msg ? msg.details : (run?.result ?? run?.partialResult)?.details) ?? {};
		const rs: any[] = Array.isArray(details.results) ? details.results : [];
		const progress: any[] = Array.isArray(details.progress) ? details.progress : [];
		const asyncDir = str(details.asyncDir);
		const runId = str(details.runId) ?? str(details.asyncId);
		const background = !!asyncDir || !!str(details.asyncId) || (!finished && call.args?.async !== false);
		const specs = specsFromArgs(call.args);
		const count = Math.max(specs.length, rs.length, progress.length, 1);
		const isError = msg ? !!msg.isError : !!run?.isError;
		const endedAt = msg ? (msg.timestamp ?? null) : null;
		for (let i = 0; i < count; i++) {
			const r = rs.find((x) => x?.index === i) ?? (rs.length === count ? rs[i] : undefined);
			const p = progress.find((x) => x?.index === i);
			let state: ChildState;
			if (background) state = "unknown";
			else if (finished) state = childState(r, isError);
			else state = opts.live && run?.running ? "running" : "unknown";
			subagents.push({
				key: `${call.id}:${i}`,
				toolCallId: call.id,
				index: i,
				agent: str(r?.agent) ?? str(p?.agent) ?? specs[i]?.agent ?? str(call.args?.agent) ?? "subagent",
				task: specs[i]?.task ?? "",
				state,
				background,
				turn: call.turn,
				startedAt: call.at,
				endedAt: finished && !background ? endedAt : null,
				sessionFile: str(r?.sessionFile),
				asyncDir,
				runId,
			});
		}
	}

	if (pr && prJob) {
		const p: LatestPr = pr;
		if (prDone) {
			const r = resultOf(prDone.text);
			if (prDone.code === "0") {
				p.ci = "passed";
				p.preview = str(r?.preview);
				p.gatewayPreview = str(r?.gatewayPreview);
			} else {
				p.ci = "failed";
				p.reason = prDone.code === "cancelled" || prDone.code === "killed" ? prDone.code : firstLine(r?.reason) ?? prDone.text.split("\n").slice(1).find((l) => l.trim() && !l.startsWith("RESULT "))?.trim() ?? null;
			}
		} else p.ci = opts.live ? "running" : "lost"; // live: the done message can wait minutes in pi's follow-up queue
	}
	return { todos, subagents, planPath, pr };
}

// The latest turn's children, plus background ones still running, are "recent"; everything else is earlier.
export function groupSubagents(children: SubagentChild[]): { recent: SubagentChild[]; earlier: SubagentChild[] } {
	const newest = (a: SubagentChild, b: SubagentChild) => b.turn - a.turn || b.index - a.index;
	const top = children.reduce((n, c) => Math.max(n, c.turn), 0);
	const recent: SubagentChild[] = [];
	const earlier: SubagentChild[] = [];
	for (const c of [...children].sort(newest)) (c.turn === top || (c.background && c.state === "running") ? recent : earlier).push(c);
	return { recent, earlier };
}
