// pi-web guard: a pi extension that blocks the slow or unsafe habits a local model falls into while
// working on thatsit.app apps, and restarts a coding run that stops without a reply. Rules: rules.ts.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { appDir, appsNeedingPr, asyncRunId, busyWorker, checkToolCall, codeOf, designDoc, pairSettings, dropReinjected, indirectReviewer, lastBlockedReview, lastReview, lastScreen, noteWithdrawn, promptDigest, REASONS, REVIEW_BUDGET, reviewApp, reviewedSinceUser, reviewFree, reviewGap, reviewHeader, lastRequest, requestFiles, reviewBlocked, reviewBlockedMark, reviewMark, reviewPendingMark, REVIEW_NO_VERDICT, REVIEW_UNSCOPED, reviewVerdict, type ReviewScope, screenCompareContent, screenMark, screenResult, screenshotDir, screenshotUpload, uiFile, userPictures, UNKNOWN_RUN, verifiedSinceEdit, NUDGE, NUDGE_TYPE, MERGE_NUDGE, MERGE_NUDGE_TYPE, shouldNudgeMerge, openTodos, partialAnswers, PR_NUDGE_TYPE, prNudge, shouldNudge, shouldNudgePr, shouldNudgeTodos, TODO_NUDGE_TYPE, todoNudge, workspacePath, reposNeedingPr, repoPrNudge } from "./rules.ts";

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
	return head !== mainBranch(dir) && !lines.some((l) => l.startsWith("# branch.upstream "));
}

export type PrState = (dir: string, branch: string) => "MERGED" | undefined;

// Whether GitHub has a merged PR for the branch. Any failure (offline, no gh, no remote) reads as not merged.
function ghPrState(dir: string, branch: string): "MERGED" | undefined {
	try {
		const n = execFileSync("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--jq", "length"], { cwd: dir, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return n !== "" && n !== "0" ? "MERGED" : undefined;
	} catch {
		return undefined;
	}
}

/** The branch the checkout was left on after Michael merged its PR, when the tree is clean; else undefined.
 *  Why: on 2026-11-16 keeb's checkout still sat on the merged accuracy-tracker branch, the worker's commit landed on it,
 *  and moving it to a fresh branch cost a conflicted cherry-pick that dropped two spec items. */
export function mergedBranch(dir: string, prState: PrState = ghPrState): string | undefined {
	try {
		const branch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8", timeout: 5000 }).trim();
		if (!branch || branch === "main") return undefined;
		if (execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", timeout: 5000 }).trim() !== "") return undefined;
		return prState(dir, branch) === "MERGED" ? branch : undefined;
	} catch {
		return undefined;
	}
}

/** Switch a clean checkout to main and fast-forward it; the short head afterwards, or undefined when the switch failed. */
export function switchToMain(dir: string): string | undefined {
	try {
		git(dir, ["switch", "main"]);
	} catch {
		return undefined;
	}
	try {
		git(dir, ["pull", "--ff-only"]);
	} catch {
		// Offline or diverged: main as it is locally still beats the merged branch.
	}
	try {
		return git(dir, ["rev-parse", "--short", "HEAD"]);
	} catch {
		return undefined;
	}
}

export const switchedNote = (dir: string, branch: string, head: string) => `[pi-guard] ${dir} was still on branch ${branch}, whose PR is merged; switched it to main (${head}) before this call. New work starts on a new branch from main (git switch -c <short-name>).`;

// The app a tool call works in, for the merged-branch check: a shell command's path, an edit's path, a worker's brief.
function callApp(toolName: string, input: Record<string, unknown>, cwd: string, home: string): string | undefined {
	if (toolName === "edit" || toolName === "write") return typeof input.path === "string" ? appDir(input.path, "", home) : undefined;
	if (toolName === "subagent") return appDir(String(input.task ?? input.message ?? ""), "", home);
	const { shell } = codeOf(toolName, input);
	for (const command of shell) {
		const dir = appDir(command, cwd, home);
		if (dir) return dir;
	}
	return undefined;
}

/** The repo's trunk: `main`, or `master` where that is the branch that exists (pi-web). */
export function mainBranch(dir: string): string {
	for (const name of ["main", "master"]) {
		try {
			execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: dir, stdio: "pipe", timeout: 5000 });
			return name;
		} catch {
			// not this one
		}
	}
	return "main";
}

/** The git root of a path under ~/workspace outside apps, for the review gate on other repos: the toplevel of the
 *  nearest directory that exists (a worktree is its own root). Undefined outside ~/workspace, under apps, or outside any repo. */
export function repoRoot(path: string, home: string): string | undefined {
	const ws = `${join(home, "workspace")}/`;
	if (!path.startsWith(ws) || path.startsWith(`${ws}apps/`)) return undefined;
	let dir = path;
	while (dir.startsWith(ws) && !existsSync(dir)) dir = dirname(dir);
	if (!dir.startsWith(ws)) return undefined;
	try {
		const cwd = statSync(dir).isDirectory() ? dir : dirname(dir);
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return root.startsWith(ws) && !root.startsWith(`${ws}apps/`) ? root : undefined;
	} catch {
		return undefined;
	}
}

// Files the branch changes against main, committed, staged, unstaged or untracked. When git can't say, assume code changed.
export function codeChanged(dir: string): boolean {
	try {
		const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 });
		const files = [...run(["diff", "--name-only", `${mainBranch(dir)}...HEAD`]).split("\n"), ...run(["diff", "--name-only", "HEAD"]).split("\n"), ...run(["ls-files", "--others", "--exclude-standard"]).split("\n")].filter(Boolean);
		return files.length === 0 || files.some((f) => !reviewFree(f));
	} catch {
		return true;
	}
}

// A design doc or plan the branch adds or changes against main, committed or not. When git can't say, assume none.
export function docsChanged(dir: string): boolean {
	try {
		const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 }).split("\n").filter(Boolean);
		return [...run(["diff", "--name-only", `${mainBranch(dir)}...HEAD`]), ...run(["diff", "--name-only", "HEAD"]), ...run(["ls-files", "--others", "--exclude-standard"])].some(designDoc);
	} catch {
		return false;
	}
}

// UI files the branch changes against main, committed, staged, unstaged or untracked. When git can't say, assume it does.
export function uiChanged(dir: string): boolean {
	try {
		const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 }).split("\n").filter(Boolean);
		return [...run(["diff", "--name-only", `${mainBranch(dir)}...HEAD`]), ...run(["diff", "--name-only", "HEAD"]), ...run(["ls-files", "--others", "--exclude-standard"])].some(uiFile);
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
export function screenContent(file: string, dir: string, snap: string, branch: Iterable<unknown> = [], upload?: string, home = homedir()): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
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
		...screenCompareContent(specText(dir), pictures, requestFiles(lastRequest(branch), home), upload),
		{ type: "text", text: screenMark(dir, snap, upload) },
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
	// The call's own cwd names the app as well as the task does: on keeb 2026-11-16 the orchestrator passed
	// cwd=<app> on every reviewer call and, from the 11th on, a diff path relative to it, and none was scoped.
	const callCwd = typeof input.cwd === "string" && input.cwd ? input.cwd.replace(/^~(?=\/)/, home) : cwd;
	// An app first; else any other git repo under ~/workspace the task or the call's cwd names (its root, so a worktree
	// is reviewed as itself).
	const app = reviewApp(task, callCwd, home);
	const named = app ? undefined : workspacePath(task, callCwd, home);
	const dir = app ?? (named ? repoRoot(named, home) : undefined);
	if (!dir) return undefined;
	// A docs-only change (a design doc, a plan) needs no verify and no screen: keeb 2026-11-17, flash ran the full
	// verify to get a plan review past this gate.
	const docsOnly = !codeChanged(dir);
	if (!docsOnly && hasScript(dir, "verify") && !verifiedSinceEdit(branch, dir, cwd, home)) return { block: true, reason: REASONS.reviewUnverified };
	// The orchestrator looks at a UI change before anyone reviews its code: a wrong picture goes back to the worker.
	// (The screenshot command is the app skill's, so only an app has a screen gate.)
	if (!docsOnly && app && uiChanged(dir) && !screenUpToDate(dir, branch)) return { block: true, reason: REASONS.screen };
	const snap = snapshot(dir);
	// A review that ended BLOCK is not re-run on the same tree: keeb 2026-11-17 18:27, the orchestrator asked the
	// reviewer to "re-verify" its P0 with its own counter-evidence, and the gate let the unchanged code through.
	const blockedAt = lastBlockedReview(branch, dir);
	if (blockedAt && exists(dir, blockedAt) && sameTree(dir, blockedAt, snap)) return { block: true, reason: REASONS.reviewBlockedSame };
	const prev = lastReview(branch, dir);
	let base: string;
	let baseFrom: ReviewScope["baseFrom"];
	if (prev && exists(dir, prev)) {
		base = prev;
		baseFrom = "review";
	} else {
		try {
			base = git(dir, ["merge-base", mainBranch(dir), snap]);
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
	// Michael's words go to the reviewer unsummarised: on keeb 2026-11-17 the parent's brief and the reviewer's task both
	// dropped "space and enter switch layers instead of typing", the worker enshrined that behavior in a test, and the
	// review passed it.
	const kind: ReviewScope["kind"] = files.some((f) => !reviewFree(f.path)) ? "code" : "docs";
	const request = lastRequest(branch);
	input.task = `${reviewHeader({ dir, kind, base, baseFrom, diffPath, files, request, inputs: requestFiles(request, home) })}\n${task}`;
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

export default function piGuard(pi: PiApi, gitNeedsPr: (dir: string) => boolean = needsPr, env: Record<string, string | undefined> = process.env, resident: Resident = defaultResident, prState: PrState = ghPrState): void {
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
	const screens = new Map<string, { dir: string; snap: string; upload?: string }>();
	// Apps checked once for a checkout left on a merged branch, and the note owed to the call that triggered the switch.
	const freshened = new Set<string>();
	const switched = new Map<string, string>();
	// Reviewer launches the guard could not tie to an app: their result says so, since they never count.
	const unscoped = new Set<string>();

	pi.on("tool_call", (event, ctx) => {
		const branch = () => [...(ctx.sessionManager?.getBranch() ?? [])];
		// The first call into an app this session: a clean checkout on a merged branch goes back to main before the
		// call runs, so neither the worker's edits nor the orchestrator's commit land on top of the merge.
		const app = child ? undefined : callApp(event.toolName, event.input ?? {}, ctx.cwd, home);
		if (app && !freshened.has(app)) {
			freshened.add(app);
			const stale = mergedBranch(app, prState);
			const head = stale ? switchToMain(app) : undefined;
			if (stale && head) switched.set(event.toolCallId, switchedNote(app, stale, head));
		}
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
			docsChanged,
			reviewGap: (dir) => reviewGap(branch(), dir),
			repoRoot: (path) => repoRoot(path, home),
			lines,
			rewrites,
			orchestrator,
			busy: (dir) => busyWorker(branch(), dir, ctx.cwd, home),
			screenSeen: (dir) => screenUpToDate(dir, branch()),
			uiChanged,
		});
		if (block) return block;
		if (event.toolName === "bash") {
			const command = String(event.input?.command ?? "");
			const dir = screenshotDir(command, ctx.cwd, home);
			if (dir) {
				try {
					screens.set(event.toolCallId, { dir, snap: snapshot(dir), upload: screenshotUpload(command, home) });
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
		else if (event.input.agent === "reviewer") unscoped.add(event.toolCallId);
		return undefined;
	});

	// Mark a finished scoped review in its result, so the PR gate and the next review's base survive a restart.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "ask_user_question") {
			const text = partialAnswers(event.input, event.details);
			return text ? { content: [{ type: "text", text }], details: event.details } : undefined;
		}
		// The note for a call that found its app on a merged branch rides on whatever else this result gets.
		const note = switched.get(event.toolCallId);
		switched.delete(event.toolCallId);
		const extra: { type: "text"; text: string }[] = note ? [{ type: "text", text: note }] : [];
		const withExtra = (content: unknown[]) => ({ content: [...(event.content ?? []), ...content, ...extra], structuredContent: event.structuredContent });
		const plain = () => (extra.length ? withExtra([]) : undefined);
		const screen = screens.get(event.toolCallId);
		if (screen) {
			screens.delete(event.toolCallId);
			if (event.isError) return plain();
			const file = screenResult((event.content ?? []).map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("\n"));
			if (!file) return plain();
			// The branch, not the context: Michael's pictures stay on it after a compaction.
			const branch = [...(ctx?.sessionManager?.getBranch() ?? [])];
			return withExtra(screenContent(file, screen.dir, screen.snap, branch, screen.upload, home));
		}
		if (unscoped.delete(event.toolCallId)) return event.isError ? plain() : withExtra([{ type: "text", text: REVIEW_UNSCOPED }]);
		const scoped = reviews.get(event.toolCallId);
		if (!scoped) return plain();
		reviews.delete(event.toolCallId);
		if (event.isError) return plain();
		const text = (event.content ?? []).map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
		// An async launch result holds no review: it is marked pending by run id, and when the id can't be read the
		// mark names an unknown run, which never counts (fail closed), rather than passing for a finished review.
		const runId = asyncRunId(text) ?? (scoped.async ? UNKNOWN_RUN : undefined);
		// A sync result is the review itself: without a verdict it gets a note, never the mark, so the PR gate stays shut and
		// the next review starts from the same base. (An async run's reply is checked when its pending mark is resolved.)
		if (!runId && !reviewVerdict(text)) return withExtra([{ type: "text", text: REVIEW_NO_VERDICT }]);
		// A sync BLOCK gets the blocked mark: it refuses a second review of the same tree and never opens the gate.
		const mark = runId ? reviewPendingMark(scoped.dir, scoped.snap, runId) : reviewBlocked(text) ? reviewBlockedMark(scoped.dir, scoped.snap) : reviewMark(scoped.dir, scoped.snap);
		return withExtra([{ type: "text", text: mark }]);
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
		// A reply that hands Michael a merge command is wrong whatever else happened in the run, so it goes first.
		if (shouldNudgeMerge(messages)) return { entries: [{ type: "custom_message", customType: MERGE_NUDGE_TYPE, content: MERGE_NUDGE, display: true }], continue: true };
		if (shouldNudge(messages)) return { entries: [{ type: "custom_message", customType: NUDGE_TYPE, content: NUDGE, display: true }], continue: true };
		// The branch, not the context: after a compaction the last todo result is no longer in the context.
		const open = openTodos(ctx.sessionManager?.getBranch() ?? []);
		if (shouldNudgeTodos(messages, open)) return { entries: [{ type: "custom_message", customType: TODO_NUDGE_TYPE, content: todoNudge(open), display: true }], continue: true };
		const apps = appsNeedingPr(messages, home, gitNeedsPr);
		const repos = reposNeedingPr(messages, ctx.cwd, home, (p) => repoRoot(p, home), gitNeedsPr);
		if (!shouldNudgePr(messages, [...apps, ...repos])) return undefined;
		const content = [...(apps.length ? [prNudge(apps)] : []), ...(repos.length ? [repoPrNudge(repos)] : [])].join("\n\n");
		return { entries: [{ type: "custom_message", customType: PR_NUDGE_TYPE, content, display: true }], continue: true };
	});
}
