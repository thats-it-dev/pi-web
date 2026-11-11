// pi-web guard: a pi extension that blocks the slow or unsafe habits a local model falls into while
// working on thatsit.app apps, and restarts a coding run that stops without a reply. Rules: rules.ts.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appsNeedingPr, checkToolCall, dropReinjected, indirectReviewer, lastReview, REASONS, REVIEW_BUDGET, reviewApp, reviewedSinceUser, reviewFree, reviewHeader, reviewMark, type ReviewScope, verifiedSinceEdit, NUDGE, NUDGE_TYPE, openTodos, partialAnswers, PR_NUDGE_TYPE, prNudge, shouldNudge, shouldNudgePr, shouldNudgeTodos, TODO_NUDGE_TYPE, todoNudge } from "./rules.ts";

type Ctx = { cwd: string; sessionManager?: { getBranch(): Iterable<unknown> } };
type Block = { block: true; reason: string };
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


// --- scoped reviews ---

const git = (dir: string, args: string[], env?: NodeJS.ProcessEnv) =>
	execFileSync("git", ["-c", "user.name=pi-guard", "-c", "user.email=pi-guard@localhost", ...args], {
		cwd: dir,
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 64 * 1024 * 1024,
		env: env ? { ...process.env, ...env } : process.env,
	}).trim();

// A commit holding the app's working tree as it is now, uncommitted and untracked (not ignored) files included.
// Built in a throwaway index, so the app's own index, branch and stash are untouched.
export function snapshot(dir: string): string {
	const index = join(tmpdir(), `pi-guard-index-${process.pid}-${Date.now()}`);
	try {
		const env = { GIT_INDEX_FILE: index };
		git(dir, ["read-tree", "HEAD"], env);
		git(dir, ["add", "-A"], env);
		const tree = git(dir, ["write-tree"], env);
		return git(dir, ["commit-tree", tree, "-p", "HEAD", "-m", "pi-guard review snapshot"]);
	} finally {
		rmSync(index, { force: true });
	}
}

const sameTree = (dir: string, a: string, b: string) => git(dir, ["rev-parse", `${a}^{tree}`]) === git(dir, ["rev-parse", `${b}^{tree}`]);
const exists = (dir: string, sha: string) => {
	try {
		git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
		return true;
	} catch {
		return false;
	}
};

// Lockfiles and build output: long, generated, and never what a review is for.
const NOT_REVIEWED = [":(exclude)package-lock.json", ":(exclude,glob)**/*.lock", ":(exclude)dist", ":(exclude)node_modules", ":(exclude,glob)**/*.min.js", ":(exclude,glob)**/*.map"];

/** True when the app's working tree is exactly what the last scoped review covered. */
export function upToDate(dir: string, branch: Iterable<unknown>): boolean {
	const last = lastReview(branch, dir);
	if (!last) return false;
	try {
		return exists(dir, last) && sameTree(dir, last, snapshot(dir));
	} catch {
		return false;
	}
}

/** Scopes a direct reviewer call on an app: checks verify ran, writes the diff since the last review (or since main)
 *  and rewrites the call's input so the reviewer reads only that, in the app, within the tool budget. */
export function scopeReview(input: Record<string, unknown>, branch: unknown[], cwd: string, home: string): Block | { dir: string; snap: string } | undefined {
	if (indirectReviewer(input) && reviewApp(JSON.stringify(input), cwd, home)) return { block: true, reason: REASONS.reviewWorkflow };
	if (input.agent !== "reviewer") return undefined;
	const task = String(input.task ?? "");
	const dir = reviewApp(task, cwd, home);
	if (!dir) return undefined;
	if (hasScript(dir, "verify") && !verifiedSinceEdit(branch, dir, cwd, home)) return { block: true, reason: REASONS.reviewUnverified };
	const snap = snapshot(dir);
	const prev = lastReview(branch, dir);
	let base: string;
	let baseFrom: ReviewScope["baseFrom"];
	if (prev && exists(dir, prev)) {
		base = prev;
		baseFrom = "review";
	} else {
		try {
			base = git(dir, ["merge-base", "main", snap]);
		} catch {
			base = git(dir, ["rev-parse", "HEAD"]);
		}
		baseFrom = "main";
	}
	if (sameTree(dir, base, snap)) return { block: true, reason: REASONS.reviewNothing };
	const diffPath = `/tmp/${basename(dir)}-review.diff`;
	writeFileSync(diffPath, git(dir, ["diff", base, snap, "--", ".", ...NOT_REVIEWED]) + "\n");
	const files = git(dir, ["diff", "--numstat", base, snap, "--", ".", ...NOT_REVIEWED])
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [added, removed, path] = l.split("\t");
			return { path, added, removed };
		});
	input.task = `${reviewHeader({ dir, base, baseFrom, diffPath, files })}\n${task}`;
	input.async = false;
	input.cwd = dir;
	input.toolBudget = { ...REVIEW_BUDGET };
	for (const k of ["context", "model", "thinking", "tools", "skill", "usageBudget"]) delete input[k];
	return { dir, snap };
}

export default function piGuard(pi: PiApi, gitNeedsPr: (dir: string) => boolean = needsPr): void {
	const home = homedir();
	const rewrites = new Set<string>();
	// Scoped reviewer calls in flight: tool call id -> the app and the snapshot the review covers.
	const reviews = new Map<string, { dir: string; snap: string }>();

	pi.on("tool_call", (event, ctx) => {
		const branch = () => [...(ctx.sessionManager?.getBranch() ?? [])];
		const block = checkToolCall(event.toolName, event.input ?? {}, {
			cwd: ctx.cwd,
			home,
			hasScript,
			dirty,
			reviewed: (dir) => {
				const b = branch();
				return reviewedSinceUser(b) || upToDate(dir, b);
			},
			codeChanged,
			lines,
			rewrites,
		});
		if (block || event.toolName !== "subagent" || !event.input) return block;
		let scoped: ReturnType<typeof scopeReview>;
		try {
			scoped = scopeReview(event.input, branch(), ctx.cwd, home);
		} catch (err) {
			return { block: true, reason: `Blocked: pi-guard could not prepare the review diff (${(err as Error).message.split("\n")[0]}). Check the app's git state (git status in the app), then call the reviewer again.` };
		}
		if (scoped && "block" in scoped) return scoped;
		if (scoped) reviews.set(event.toolCallId, scoped);
		return undefined;
	});

	// Mark a finished scoped review in its result, so the PR gate and the next review's base survive a restart.
	pi.on("tool_result", (event) => {
		if (event.toolName === "ask_user_question") {
			const text = partialAnswers(event.input, event.details);
			return text ? { content: [{ type: "text", text }], details: event.details } : undefined;
		}
		const scoped = reviews.get(event.toolCallId);
		if (!scoped) return undefined;
		reviews.delete(event.toolCallId);
		if (event.isError) return undefined;
		return { content: [...(event.content ?? []), { type: "text", text: reviewMark(scoped.dir, scoped.snap) }], structuredContent: event.structuredContent };
	});

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
