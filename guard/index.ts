// pi-web guard: a pi extension that blocks the slow or unsafe habits a local model falls into while
// working on thatsit.app apps, and restarts a coding run that stops without a reply. Rules: rules.ts.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appsNeedingPr, asyncRunId, busyWorker, checkToolCall, pairSettings, dropReinjected, indirectReviewer, lastReview, lastScreen, noteWithdrawn, promptDigest, REASONS, REVIEW_BUDGET, reviewApp, reviewedSinceUser, reviewFree, reviewHeader, reviewMark, reviewPendingMark, REVIEW_NO_VERDICT, reviewVerdict, type ReviewScope, screenCompareContent, screenMark, screenResult, screenshotDir, uiFile, userPictures, UNKNOWN_RUN, verifiedSinceEdit, NUDGE, NUDGE_TYPE, openTodos, partialAnswers, PR_NUDGE_TYPE, prNudge, shouldNudge, shouldNudgePr, shouldNudgeTodos, TODO_NUDGE_TYPE, todoNudge } from "./rules.ts";

type Ctx = { cwd: string; sessionManager?: { getBranch(): Iterable<unknown> } };
type Block = { block: true; reason: string };
type PiApi = { on(event: string, handler: (event: any, ctx: Ctx) => unknown): unknown };

/** pi's settings.json under `home`, or undefined when it is missing or unreadable. */
function readSettings(home: string): unknown {
	try {
		return JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
	} catch {
		return undefined;
	}
}

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

// UI files the branch changes against main, committed, staged, unstaged or untracked. When git can't say, assume it does.
export function uiChanged(dir: string): boolean {
	try {
		const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 }).split("\n").filter(Boolean);
		return [...run(["diff", "--name-only", "main...HEAD"]), ...run(["diff", "--name-only", "HEAD"]), ...run(["ls-files", "--others", "--exclude-standard"])].some(uiFile);
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

/** True when the last picture of the app shows its UI files as they are now: a snapshot was pictured, and no UI file
 *  differs between it and the working tree (briefs, docs and tests may). */
export function screenUpToDate(dir: string, branch: Iterable<unknown>): boolean {
	const last = lastScreen(branch, dir);
	if (!last) return false;
	try {
		return exists(dir, last) && !git(dir, ["diff", "--name-only", last, snapshot(dir)]).split("\n").some(uiFile);
	} catch {
		return false;
	}
}

/** Pictures larger than this stay on disk: the model would not get them anyway (pi-web's show_image has the same cap). */
export const MAX_PICTURE_BYTES = 2_000_000;

/** The content a finished `screenshot` command's result gets: the picture itself, so the model sees the screen in the
 *  same turn, and the mark that makes the gate pass. A missing or oversized file gets a note and no mark. */
export const MAX_SPEC_CHARS = 8000;

/** The app's spec as written, for the screen comparison; undefined while it is missing or still the starter. */
export function specText(dir: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(join(dir, "docs", "spec.md"), "utf8");
	} catch {
		return undefined;
	}
	if (!text.trim() || text.includes("starter spec:")) return undefined;
	return text.length > MAX_SPEC_CHARS ? `${text.slice(0, MAX_SPEC_CHARS)}\n[cut here; read docs/spec.md for the rest]` : text;
}

/** The blocks appended to a screenshot command's result: the picture, the spec and Michael's pictures from the branch
 *  to compare it with, the comparison owed, and the mark. */
export function screenContent(file: string, dir: string, snap: string, branch: Iterable<unknown> = []): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch (err) {
		return [{ type: "text", text: `[pi-guard] the picture ${file} could not be read (${(err as Error).message.split("\n")[0]}); run the screenshot command again.` }];
	}
	if (bytes.length > MAX_PICTURE_BYTES) return [{ type: "text", text: `[pi-guard] the picture is ${(bytes.length / 1_000_000).toFixed(1)} MB, too large to show; picture one screen with --path.` }];
	// A picture over the limit is left out rather than failing the look; base64 is 4/3 of the bytes.
	const pictures = userPictures(branch).filter((p) => p.data.length <= (MAX_PICTURE_BYTES * 4) / 3);
	return [
		{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
		...screenCompareContent(specText(dir), pictures),
		{ type: "text", text: screenMark(dir, snap) },
	];
}

/** Scopes a direct reviewer call on an app: checks verify ran, writes the diff since the last review (or since main)
 *  and rewrites the call's input so the reviewer reads only that, in the app, within the tool budget. */
/** Model ids llama-swap reports as loaded and ready; `[]` on any failure. A reviewer may name one of these. */
export type Resident = () => string[];

export function defaultResident(): string[] {
	try {
		const out = execFileSync("curl", ["-s", "--max-time", "2", "http://127.0.0.1:9000/running"], { encoding: "utf8" });
		const { running } = JSON.parse(out) as { running?: { model?: string; state?: string }[] };
		return (running ?? []).filter((r) => r.state === "ready" && r.model).map((r) => r.model as string);
	} catch {
		return [];
	}
}

export function scopeReview(input: Record<string, unknown>, branch: unknown[], cwd: string, home: string, resident: Resident = defaultResident): Block | { dir: string; snap: string; async: boolean } | undefined {
	if (indirectReviewer(input) && reviewApp(JSON.stringify(input), cwd, home)) return { block: true, reason: REASONS.reviewWorkflow };
	if (input.agent !== "reviewer") return undefined;
	const task = String(input.task ?? "");
	const dir = reviewApp(task, cwd, home);
	if (!dir) return undefined;
	if (hasScript(dir, "verify") && !verifiedSinceEdit(branch, dir, cwd, home)) return { block: true, reason: REASONS.reviewUnverified };
	// The orchestrator looks at a UI change before anyone reviews its code: a wrong picture goes back to the worker.
	if (uiChanged(dir) && !screenUpToDate(dir, branch)) return { block: true, reason: REASONS.screen };
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
	// `async` is the caller's: an async review is marked pending on its launch result and counts once its run
	// completes (rules.ts, reviewedSinceUser/lastReview), so the orchestrator can start the next task meanwhile.
	input.cwd = dir;
	input.toolBudget = { ...REVIEW_BUDGET };
	// A model stays only when it is already loaded: a review must never swap the serving group (flash-next and
	// the agent pair are exclusive in llama-swap), but the final review may name the resident orchestrator model.
	let loaded: string[] = [];
	try {
		loaded = resident();
	} catch {
		loaded = [];
	}
	if (typeof input.model !== "string" || !loaded.includes(input.model.replace(/^spark\//, ""))) delete input.model;
	for (const k of ["context", "thinking", "tools", "skill", "usageBudget"]) delete input[k];
	return { dir, snap, async: !!input.async };
}

export default function piGuard(pi: PiApi, gitNeedsPr: (dir: string) => boolean = needsPr, env: Record<string, string | undefined> = process.env, resident: Resident = defaultResident): void {
	const home = env.HOME ?? homedir();
	// A pi-subagents child runs this extension too. The blocking rules hold there; the nudges (stall, to-dos,
	// PR) are the parent session's business — a worker told to open a PR would fight its brief.
	const child = !!env.PI_SUBAGENT_CHILD;
	// With the agent pair in pi's settings, the parent session orchestrates and never edits app code (rules.ts).
	const orchestrator = !child && pairSettings(readSettings(home));
	const rewrites = new Set<string>();
	// Scoped reviewer calls in flight: tool call id -> the app and the snapshot the review covers.
	const reviews = new Map<string, { dir: string; snap: string; async: boolean }>();
	// Screenshot commands in flight: tool call id -> the app and the snapshot the picture will show.
	const screens = new Map<string, { dir: string; snap: string }>();

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
			orchestrator,
			busy: (dir) => busyWorker(branch(), dir, ctx.cwd, home),
			screenSeen: (dir) => screenUpToDate(dir, branch()),
			uiChanged,
		});
		if (block) return block;
		if (event.toolName === "bash") {
			const dir = screenshotDir(String(event.input?.command ?? ""), ctx.cwd, home);
			if (dir) {
				try {
					screens.set(event.toolCallId, { dir, snap: snapshot(dir) });
				} catch {
					// No snapshot, no mark: the picture still comes back, the gate stays shut.
				}
			}
			return undefined;
		}
		if (event.toolName !== "subagent" || !event.input) return undefined;
		// A resume after a stop tells the worker the stopped run's follow-up is withdrawn (its session file still holds it).
		noteWithdrawn(event.input, branch());
		let scoped: ReturnType<typeof scopeReview>;
		try {
			scoped = scopeReview(event.input, branch(), ctx.cwd, home, resident);
		} catch (err) {
			return { block: true, reason: `Blocked: pi-guard could not prepare the review diff (${(err as Error).message.split("\n")[0]}). Check the app's git state (git status in the app), then call the reviewer again.` };
		}
		if (scoped && "block" in scoped) return scoped;
		if (scoped) reviews.set(event.toolCallId, scoped);
		return undefined;
	});

	// Mark a finished scoped review in its result, so the PR gate and the next review's base survive a restart.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "ask_user_question") {
			const text = partialAnswers(event.input, event.details);
			return text ? { content: [{ type: "text", text }], details: event.details } : undefined;
		}
		const screen = screens.get(event.toolCallId);
		if (screen) {
			screens.delete(event.toolCallId);
			if (event.isError) return undefined;
			const file = screenResult((event.content ?? []).map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("\n"));
			if (!file) return undefined;
			// The branch, not the context: Michael's pictures stay on it after a compaction.
			const branch = [...(ctx?.sessionManager?.getBranch() ?? [])];
			return { content: [...(event.content ?? []), ...screenContent(file, screen.dir, screen.snap, branch)], structuredContent: event.structuredContent };
		}
		const scoped = reviews.get(event.toolCallId);
		if (!scoped) return undefined;
		reviews.delete(event.toolCallId);
		if (event.isError) return undefined;
		const text = (event.content ?? []).map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
		// An async launch result holds no review: it is marked pending by run id, and when the id can't be read the
		// mark names an unknown run, which never counts (fail closed), rather than passing for a finished review.
		const runId = asyncRunId(text) ?? (scoped.async ? UNKNOWN_RUN : undefined);
		// A sync result is the review itself: without a verdict it gets a note, never the mark, so the PR gate stays shut and
		// the next review starts from the same base. (An async run's reply is checked when its pending mark is resolved.)
		if (!runId && !reviewVerdict(text)) return { content: [...(event.content ?? []), { type: "text", text: REVIEW_NO_VERDICT }], structuredContent: event.structuredContent };
		const mark = runId ? reviewPendingMark(scoped.dir, scoped.snap, runId) : reviewMark(scoped.dir, scoped.snap);
		return { content: [...(event.content ?? []), { type: "text", text: mark }], structuredContent: event.structuredContent };
	});

	// Filter in place and return nothing: pi's default summarizer then runs on the same preparation object.
	pi.on("session_before_compact", (event) => {
		dropReinjected(event.preparation?.messagesToSummarize);
		dropReinjected(event.preparation?.turnPrefixMessages);
		return undefined;
	});

	// Every request, digested, in ~/.pi/agent/tmp/pi-guard-prompts.jsonl: with the server's cached-token count it says
	// whether a cold prefill came from a changed system prompt (its sections are listed by length) or an earlier message.
	const promptLog = join(home, ".pi", "agent", "tmp", "pi-guard-prompts.jsonl");
	let sections: Record<string, number> = {};
	pi.on("before_agent_start", (event) => {
		const s = (event.systemPromptOptions?.sections ?? {}) as Record<string, unknown>;
		sections = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "string" ? v.length : v == null ? 0 : -1]));
		return undefined;
	});
	pi.on("before_provider_request", (event) => {
		const d = promptDigest(event.payload);
		if (!d) return undefined;
		try {
			mkdirSync(join(home, ".pi", "agent", "tmp"), { recursive: true });
			appendFileSync(promptLog, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, child, ...d, sections })}\n`);
		} catch {
			// A log that cannot be written changes nothing about the request.
		}
		return undefined;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		// context.canContinue describes the context before these entries: it is false whenever the run ended on an
		// assistant reply, which is exactly when a nudge is wanted. pi re-checks after appending the nudge.
		if (child || event.outcome !== "completed") return undefined;
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
