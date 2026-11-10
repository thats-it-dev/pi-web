// pi-web guard: a pi extension that blocks the slow or unsafe habits a local model falls into while
// working on thatsit.app apps, and restarts a coding run that stops without a reply. Rules: rules.ts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appsNeedingPr, checkToolCall, dropReinjected, reviewedSinceUser, reviewFree, NUDGE, NUDGE_TYPE, openTodos, PR_NUDGE_TYPE, prNudge, shouldNudge, shouldNudgePr, shouldNudgeTodos, TODO_NUDGE_TYPE, todoNudge } from "./rules.ts";

type Ctx = { cwd: string; sessionManager?: { getBranch(): Iterable<unknown> } };
type PiApi = { on(event: string, handler: (event: any, ctx: Ctx) => unknown): unknown };

function hasScript(dir: string, name: string): boolean {
	try {
		return name in (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {});
	} catch {
		return false;
	}
}

// Uncommitted changes to tracked files. Untracked files are not at risk from checkout or restore.
function dirty(dir: string): boolean {
	try {
		return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, encoding: "utf8", timeout: 5000 }).trim() !== "";
	} catch {
		return false;
	}
}

// Work an app still has to publish: uncommitted changes (untracked files included, .gitignore applies), commits not
// on the remote, or a branch that was never pushed.
export function needsPr(dir: string): boolean {
	let out: string;
	try {
		out = execFileSync("git", ["status", "--porcelain=v2", "--branch"], { cwd: dir, encoding: "utf8", timeout: 5000 });
	} catch {
		return false;
	}
	const lines = out.split("\n").filter(Boolean);
	if (lines.some((l) => !l.startsWith("#"))) return true;
	const head = lines.find((l) => l.startsWith("# branch.head "))?.slice(14);
	const ahead = Number(/^# branch\.ab \+(\d+)/m.exec(out)?.[1] ?? 0);
	if (ahead > 0) return true;
	return head !== "main" && !lines.some((l) => l.startsWith("# branch.upstream "));
}

// Files the branch changes against main, committed or not. When git can't say, assume code changed.
export function codeChanged(dir: string): boolean {
	try {
		const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 });
		const files = [...run(["diff", "--name-only", "main...HEAD"]).split("\n"), ...run(["diff", "--name-only", "HEAD"]).split("\n")].filter(Boolean);
		return files.length === 0 || files.some((f) => !reviewFree(f));
	} catch {
		return true;
	}
}

// Lines in an existing file, undefined when it does not exist or can't be read.
function lines(path: string): number | undefined {
	try {
		return readFileSync(path, "utf8").split("\n").length;
	} catch {
		return undefined;
	}
}

export default function piGuard(pi: PiApi, gitNeedsPr: (dir: string) => boolean = needsPr): void {
	const home = homedir();
	const rewrites = new Set<string>();

	pi.on("tool_call", (event, ctx) =>
		checkToolCall(event.toolName, event.input ?? {}, {
			cwd: ctx.cwd,
			home,
			hasScript,
			dirty,
			reviewed: () => reviewedSinceUser(ctx.sessionManager?.getBranch() ?? []),
			codeChanged,
			lines,
			rewrites,
		}),
	);

	// Filter in place and return nothing: pi's default summarizer then runs on the same preparation object.
	pi.on("session_before_compact", (event) => {
		dropReinjected(event.preparation?.messagesToSummarize);
		dropReinjected(event.preparation?.turnPrefixMessages);
		return undefined;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		// context.canContinue describes the context before these entries: it is false whenever the run ended on an
		// assistant reply, which is exactly when a nudge is wanted. pi re-checks after appending the nudge.
		if (event.outcome !== "completed") return undefined;
		const messages = event.context.contextMessages ?? [];
		if (shouldNudge(messages)) return { entries: [{ type: "custom_message", customType: NUDGE_TYPE, content: NUDGE, display: true }], continue: true };
		// The branch, not the context: after a compaction the last todo result is no longer in the context.
		const open = openTodos(ctx.sessionManager?.getBranch() ?? []);
		if (shouldNudgeTodos(messages, open)) return { entries: [{ type: "custom_message", customType: TODO_NUDGE_TYPE, content: todoNudge(open), display: true }], continue: true };
		const apps = appsNeedingPr(messages, home, gitNeedsPr);
		if (!shouldNudgePr(messages, apps)) return undefined;
		return { entries: [{ type: "custom_message", customType: PR_NUDGE_TYPE, content: prNudge(apps), display: true }], continue: true };
	});
}
