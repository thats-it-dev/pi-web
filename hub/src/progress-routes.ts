// Read-only routes behind the progress panel: the goal, a plan file, subagent children and a child's transcript.
// Each one reads only what a session's own records point at, and nothing else:
//   goal      the session file of the id (live handle or index)
//   plan      one .md file whose real path stays under the session's real cwd
//   subagents <asyncDir>/status.json, with asyncDir taken from the parent's recorded tool result
//   history   for a child whose key the parent's own records produce, the first transcript that exists of:
//             its recorded sessionFile; the sessionFile its status.json names (background); and the
//             derived <parent file minus .jsonl>/<runId>/run-<index>/session.jsonl (runId from the
//             parent's records), whose real path must stay under <parent file minus .jsonl>/.
//             A recorded or status.json sessionFile must have a real path under the hub's real sessions
//             dir (status.json sits in a shared tmp dir any local user could write); one that doesn't is
//             neither read nor echoed to the client.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
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
const RUN_ID_RE = /^[\w-]+$/;
const under = (base: string, p: string) => p.startsWith(base.endsWith(sep) ? base : base + sep);

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
		return Promise.all(deriveProgress(conv, { live }).subagents.map(async (c) => vetted(await withStatus(c), index.dir)));
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
	const messages = await childTranscript(child, (await located(id)).file, index.dir);
	if (!messages) throw notFound("Subagent transcript");
	sendJson(res, 200, { messages, child }, cors);
	return true;
}

const transcriptPath = (p: string | null): p is string => !!p && isAbsolute(p) && p.endsWith(".jsonl") && !p.includes("\0");

// The child's transcript, or null while none of its candidate files exists yet. `child.sessionFile`
// is the recorded one, or (background) the one its status.json names; the derived layout comes last.
async function childTranscript(child: SubagentChild, parentFile: string | null, sessionsRoot: string): Promise<Awaited<ReturnType<typeof readHistory>> | null> {
	const named = await inSessions(child.sessionFile, sessionsRoot);
	if (named) {
		try {
			return await readHistory(named);
		} catch {}
	}
	if (!parentFile || !parentFile.endsWith(".jsonl") || !child.runId || !RUN_ID_RE.test(child.runId)) return null;
	const runs = parentFile.slice(0, -".jsonl".length);
	const derived = join(runs, child.runId, `run-${child.index}`, "session.jsonl");
	if (!transcriptPath(derived)) return null;
	try {
		const base = await realpath(runs);
		if (!under(base, await realpath(derived))) return null;
		return await readHistory(derived);
	} catch {
		return null;
	}
}

// The real path of a transcript that exists under the real sessions dir, else null.
async function inSessions(p: string | null, sessionsRoot: string): Promise<string | null> {
	if (!transcriptPath(p)) return null;
	try {
		const real = await realpath(p);
		return under(await realpath(sessionsRoot), real) ? real : null;
	} catch {
		return null;
	}
}

// A child as the client may see it: a sessionFile that fails `inSessions` is dropped.
async function vetted(c: SubagentChild, sessionsRoot: string): Promise<SubagentChild> {
	if (c.sessionFile === null || (await inSessions(c.sessionFile, sessionsRoot))) return c;
	return { ...c, sessionFile: null };
}

// Whether a pid names no process at all (EPERM means it exists but isn't ours).
function pidGone(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ESRCH";
	}
}

// Background children report through status.json; a foreground child keeps its derived state.
// A queued/running report whose runner is gone (pid) or past its deadline is unconfirmable: unknown.
async function withStatus(c: SubagentChild, now = Date.now()): Promise<SubagentChild> {
	if (!c.background) return c;
	const unknown = { ...c, state: "unknown" as const };
	if (!c.asyncDir || !isAbsolute(c.asyncDir)) return unknown;
	try {
		const file = join(c.asyncDir, "status.json");
		if ((await stat(file)).size > MAX_STATUS_BYTES) return unknown;
		const s = JSON.parse(await readFile(file, "utf8"));
		if (!s || typeof s !== "object" || Array.isArray(s)) return unknown;
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
		let state = (typeof s.state === "string" && Object.hasOwn(STATE, s.state) ? STATE[s.state] : "unknown") as ChildState;
		if (state === "running") {
			const deadline = num(s.deadlineAt);
			if (pidGone(s.pid) || (deadline !== null && deadline < now)) state = "unknown";
		}
		const step = Array.isArray(s.steps) ? s.steps[c.index] : undefined;
		const named = (v: unknown) => (typeof v === "string" && transcriptPath(v) ? v : null);
		const sessionFile = c.sessionFile ?? named(step && typeof step === "object" ? step.sessionFile : null) ?? (c.index === 0 ? named(s.sessionFile) : null);
		return {
			...c,
			state,
			startedAt: num(s.startedAt) ?? c.startedAt,
			endedAt: num(s.endedAt),
			sessionFile,
		};
	} catch {
		return unknown;
	}
}

async function readPlan(cwd: string, path: string | null): Promise<{ path: string; text: string; mtimeMs: number }> {
	if (!cwd || !path || path.includes("\0") || !/\.md$/.test(path)) throw notFound("Plan");
	try {
		const base = await realpath(cwd);
		// An absolute path is fine as long as its real path is under the real cwd, like any other.
		const real = await realpath(resolve(base, path));
		if (!under(base, real)) throw notFound("Plan");
		const st = await stat(real);
		if (!st.isFile() || st.size > MAX_PLAN_BYTES) throw notFound("Plan");
		return { path, text: await readFile(real, "utf8"), mtimeMs: st.mtimeMs };
	} catch {
		throw notFound("Plan");
	}
}
