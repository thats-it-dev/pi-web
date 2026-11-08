// Read-only routes behind the progress panel: the goal, a plan file, subagent children and a child's transcript.
// Each one reads only what a session's own records point at, and nothing else:
//   goal      the session file of the id (live handle or index)
//   plan      one .md file whose real path stays under the session's real cwd
//   subagents <asyncDir>/status.json, with asyncDir taken from the parent's recorded tool result
//   history   the one sessionFile recorded for a child whose key the parent's own records produce

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { goalFromEntries } from "../../shared/src/goal.ts";
import { type ChildState, type SubagentChild, deriveProgress } from "../../shared/src/progress.ts";
import { createConversation } from "../../shared/src/reducer.ts";
import { branchEntries } from "../../shared/src/session-file.ts";
import { HttpError } from "./errors.ts";
import { type Cors, sendJson } from "./http.ts";
import type { Registry } from "./registry.ts";
import { type SessionIndex, readHistory } from "./sessions.ts";

export interface ProgressDeps {
	registry: Registry;
	index: SessionIndex;
	cors: Cors;
}

const MAX_PLAN_BYTES = 512 * 1024;
const MAX_STATUS_BYTES = 1024 * 1024;
const notFound = (what: string) => new HttpError(404, `${what} not found`);

const STATE: Record<string, ChildState> = {
	queued: "running",
	running: "running",
	complete: "done",
	failed: "failed",
	partial: "failed",
	rejected: "failed",
	stopped: "stopped",
};

export async function routeProgress(req: IncomingMessage, res: ServerResponse, url: URL, deps: ProgressDeps): Promise<boolean> {
	if (req.method !== "GET") return false;
	const m = url.pathname.match(/^\/api\/sessions\/([\w.-]+)\/(goal|plan|subagents)$/);
	const hm = url.pathname.match(/^\/api\/sessions\/([\w.-]+)\/subagents\/([^/]+)\/history$/);
	if (!m && !hm) return false;
	const { registry, index, cors } = deps;

	const located = async (id: string): Promise<{ file: string | null; cwd: string }> => {
		const live = registry.get(id);
		const s = await index.find(id);
		if (!live && !s) throw notFound("Session");
		return { file: live?.sessionFile ?? s?.file ?? null, cwd: live?.cwd ?? s?.cwd ?? "" };
	};
	const parentConv = async (id: string) => {
		const live = registry.get(id);
		if (live) return { conv: live.snapshot().conv, live: true };
		const { file } = await located(id);
		if (!file) throw notFound("Session");
		return { conv: createConversation(await readHistory(file)), live: false };
	};
	const children = async (id: string): Promise<SubagentChild[]> => {
		const { conv, live } = await parentConv(id);
		return Promise.all(deriveProgress(conv, { live }).subagents.map(withStatus));
	};

	if (m) {
		const [, id, kind] = m;
		if (kind === "goal") {
			const { file } = await located(id);
			let goal = null;
			if (file) goal = goalFromEntries(branchEntries(await readFile(file, "utf8").catch(() => "")));
			sendJson(res, 200, { goal }, cors);
		} else if (kind === "plan") {
			const { cwd } = await located(id);
			sendJson(res, 200, await readPlan(cwd, url.searchParams.get("path")), cors);
		} else {
			sendJson(res, 200, { children: await children(id) }, cors);
		}
		return true;
	}

	const [, id, rawKey] = hm!;
	let key: string;
	try {
		key = decodeURIComponent(rawKey);
	} catch {
		throw notFound("Subagent");
	}
	// The key must be one the parent's own records produce; nothing is read before this.
	const child = (await children(id)).find((c) => c.key === key);
	if (!child) throw notFound("Subagent");
	const file = child.sessionFile;
	if (!file || !isAbsolute(file) || !file.endsWith(".jsonl")) throw notFound("Subagent transcript");
	let messages;
	try {
		messages = await readHistory(file);
	} catch {
		throw notFound("Subagent transcript");
	}
	sendJson(res, 200, { messages, child }, cors);
	return true;
}

// Background children report through status.json; a foreground child keeps its derived state.
async function withStatus(c: SubagentChild): Promise<SubagentChild> {
	if (!c.background) return c;
	const unknown = { ...c, state: "unknown" as const };
	if (!c.asyncDir || !isAbsolute(c.asyncDir)) return unknown;
	try {
		const file = join(c.asyncDir, "status.json");
		if ((await stat(file)).size > MAX_STATUS_BYTES) return unknown;
		const s = JSON.parse(await readFile(file, "utf8"));
		if (!s || typeof s !== "object" || Array.isArray(s)) return unknown;
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
		return {
			...c,
			state: (typeof s.state === "string" && Object.hasOwn(STATE, s.state) ? STATE[s.state] : "unknown") as ChildState,
			startedAt: num(s.startedAt) ?? c.startedAt,
			endedAt: num(s.endedAt),
		};
	} catch {
		return unknown;
	}
}

async function readPlan(cwd: string, path: string | null): Promise<{ path: string; text: string; mtimeMs: number }> {
	if (!cwd || !path || path.includes("\0") || isAbsolute(path) || !/\.md$/.test(path)) throw notFound("Plan");
	try {
		const base = await realpath(cwd);
		const real = await realpath(join(base, path));
		if (!real.startsWith(base.endsWith(sep) ? base : base + sep)) throw notFound("Plan");
		const st = await stat(real);
		if (!st.isFile() || st.size > MAX_PLAN_BYTES) throw notFound("Plan");
		return { path, text: await readFile(real, "utf8"), mtimeMs: st.mtimeMs };
	} catch {
		throw notFound("Plan");
	}
}
