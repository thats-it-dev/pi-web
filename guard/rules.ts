// Pure rules for the guard extension. index.ts wires them to pi's events.
import { isAbsolute, join } from "node:path";

export type Block = { block: true; reason: string };

const SKILL_CLI = "node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts";

export const REASONS = {
	push: `Blocked: in an app, never push yourself. Commit, then run \`${SKILL_CLI} pr <dir> ...\`; it pushes and opens the PR. Then wait for CI: run \`${SKILL_CLI} pr-wait <dir>\` with the bg_bash tool. For the first version, run \`ship\` with the bg_bash tool instead.`,
	ci: `Blocked: don't wait for or poll CI yourself (no sleep, gh run list/watch/view, gh pr checks). Wait with \`pr-wait\`, \`gateway-pr-wait\` or \`ship\` through the bg_bash tool; it prints the failing log lines. After a fix commit, rerun the same \`pr\` command, then \`pr-wait\` with bg_bash.`,
	e2e: "Blocked: the full e2e suite runs only before a commit, through `npm run verify`. While iterating, run one spec: `npm run e2e:one -- e2e/<file>.spec.ts`.",
	rewrite: "Blocked: don't rewrite files with a Python script. Use the edit tool (read the lines first); it checks the edit and tells you when the old text doesn't match.",
	prTimeout: "Blocked: `pr` and `gateway-pr` return as soon as the PR is open. Run the same command again with no timeout.",
	waitInBackground: "Blocked: `pr-wait`, `gateway-pr-wait` and `ship` wait on CI. Run the same command with the bg_bash tool, tell Michael the PR link, then end your turn; a bg-bash-done message wakes you when CI finishes.",
	review: `Blocked: run the reviewer before opening the PR. Run \`npm run verify\` in the app if you edited code since it last passed, then call the \`subagent\` tool (call \`subagents_enable\` first if it is not available) with agent "reviewer" and a task that names Michael's request and \`docs/spec.md\` (and, if the app generates content or changes with the user's progress, a file sampling output at the first, a middle and the last stage). The guard writes the diff and the review scope itself; don't write a diff. Fix what you confirm, rerun \`npm run verify\`, commit, list the findings you fixed and rejected in the PR body, then rerun this command.`,
	reviewUnverified: "Blocked: run `npm run verify` in the app first, and call the reviewer once it passes. Edits to code since the last green verify make the review stale; edits to docs and Markdown don't.",
	reviewWorkflow: 'Blocked: in an app, call the reviewer directly: the `subagent` tool with agent "reviewer" and a task, not inside a workflow, chain or task list. The guard scopes a direct call to the diff.',
	reviewNothing: "Blocked: nothing changed in the app since the last review, so there is nothing to review. Go on with the next step (commit, then the skill's `pr` command).",
	overwrite: `Blocked: this rewrites a long existing file. Every line you write costs generation time, so change it with the edit tool: oldText is the fewest unique lines that locate the change (usually 1-3), and newText repeats as few unchanged lines as possible. If you really mean to replace most of the file, send the same write again and it will go through.`,
	discard: "Blocked: this would throw away uncommitted changes in the app. To show a test fails, write the test first and run it before the fix; never revert source to prove it red. To see an older version, use `git show <ref>:<path>`. To set work aside, commit it first.",
};

// The app a command works in: from a path to ~/workspace/apps/<name> in the command, else the session cwd.
export function appDir(command: string, cwd: string, home: string): string | undefined {
	const apps = join(home, "workspace", "apps");
	const expanded = command.replace(/(^|[\s="'(])(~|\$HOME|\$\{HOME\})(?=\/)/g, `$1${home}`);
	const at = expanded.indexOf(`${apps}/`);
	if (at >= 0) {
		const name = /^[A-Za-z0-9._-]+/.exec(expanded.slice(at + apps.length + 1))?.[0];
		if (name) return join(apps, name);
	}
	if (cwd.startsWith(`${apps}/`)) return join(apps, cwd.slice(apps.length + 1).split("/")[0]);
	return undefined;
}

// The directory a command runs in: its leading `cd`, else the session cwd.
export function workDir(command: string, cwd: string, home: string): string {
	const target = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1].replace(/^["']|["']$/g, "");
	if (!target) return cwd;
	return target.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

// True when a command runs the whole e2e suite rather than one spec or a grep.
export function fullE2e(command: string): boolean {
	if (/\bBASE_URL=/.test(command)) return false; // checking a deployed site
	// Quoted text is an argument (a grep pattern, a commit message), not a command that runs.
	const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
	for (const m of bare.matchAll(/\b(?:npm\s+run\s+e2e(?![:\w-])|playwright\s+test\b)([^;&|\n]*)/g)) {
		if (!/\.spec\.|\.ts\b|\s(?:-g|--grep)\b/.test(m[1])) return true;
	}
	return false;
}

export function pythonRewrite(code: string): boolean {
	return /\bopen\([^)]*,\s*["'][wa]\+?b?["']|\.write_text\(|\.write_bytes\(/.test(code);
}

export type Env = {
	cwd: string;
	home: string;
	hasScript: (dir: string, name: string) => boolean;
	dirty: (dir: string) => boolean;
	/** The app's current state was reviewed (a scoped reviewer finished since Michael's last message, or nothing
	 *  changed since the last review). Absent: not checked. */
	reviewed?: (dir: string) => boolean;
	/** The branch changes more than docs, Markdown and CI files. */
	codeChanged?: (dir: string) => boolean;
	/** Line count of an existing file, undefined when there is none. Absent: overwrites are not checked. */
	lines?: (path: string) => number | undefined;
	/** Paths whose overwrite was already blocked once; the second try goes through. */
	rewrites?: Set<string>;
};

const GIT = String.raw`\bgit(?:\s+-[Cc]\s+(?:[^\s"']|"[^"]*"|'[^']*')+|\s+-\S+)*\s+`;

// Commands that overwrite working-tree files with a committed version.
export function discards(command: string): boolean {
	for (const seg of command.split(/;|&&|\|\||\||\n/)) {
		if (new RegExp(`${GIT}checkout\\b.*\\s--(\\s|$)`).test(seg)) return true;
		if (new RegExp(`${GIT}restore\\b`).test(seg) && !(/\s(?:-S|--staged)\b/.test(seg) && !/\s(?:-W|--worktree)\b/.test(seg))) return true;
		if (new RegExp(`${GIT}reset\\b.*\\s--hard\\b`).test(seg)) return true;
	}
	return false;
}

export function checkShell(command: string, env: Env): Block | undefined {
	const dir = appDir(command, env.cwd, env.home);
	if (!dir) return undefined;
	if (/\bgit(?:\s+-[Cc]\s+(?:[^\s"']|"[^"]*"|'[^']*')+|\s+-\S+)*\s+push\b/.test(command)) return { block: true, reason: REASONS.push };
	if (/\bgh\s+(?:run\s+(?:list|watch)|pr\s+checks)\b/.test(command)) return { block: true, reason: REASONS.ci };
	if (/\bgh\s+run\s+view\b/.test(command) && !/--log-failed\b/.test(command)) return { block: true, reason: REASONS.ci };
	// A short sleep (a server starting, a deploy propagating) is fine; CI polling used minutes.
	const sleep = /\bsleep\s+(\d+)/.exec(command);
	if (sleep && Number(sleep[1]) >= 60) return { block: true, reason: REASONS.ci };
	if (/\bpython3?\b/.test(command) && pythonRewrite(command) && appDir("", workDir(command, env.cwd, env.home), env.home)) {
		return { block: true, reason: REASONS.rewrite };
	}
	if (fullE2e(command) && env.hasScript(dir, "e2e:one")) return { block: true, reason: REASONS.e2e };
	if (discards(command) && env.dirty(dir)) return { block: true, reason: REASONS.discard };
	if (OPENS_PR.test(command) && env.reviewed && !env.reviewed(dir) && (env.codeChanged?.(dir) ?? true)) return { block: true, reason: REASONS.review };
	return undefined;
}

const OPENS_PR = /thatsit-app\.ts\s+(?:pr|gateway-pr)\b(?!-wait)/;

/** Files a PR can change without a review: docs, Markdown and CI config. */
export function reviewFree(path: string): boolean {
	return /^(?:docs|\.github)\//.test(path) || /\.md$/i.test(path);
}

// --- review before PR ---

type Entry = { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
type ToolCallPart = { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };

/** Appended to a scoped review's result by the guard; records which app state the review covered. */
export const REVIEW_MARK = "[pi-guard] reviewed ";
export const reviewMark = (dir: string, snap: string) => `${REVIEW_MARK}${dir} at ${snap}`;

const resultText = (m: Entry["message"]) =>
	Array.isArray(m?.content) ? (m.content as { type?: string; text?: string }[]).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n") : "";

/** True when a review the guard scoped returned without error after Michael's last message on the branch. */
export function reviewedSinceUser(branch: Iterable<unknown>): boolean {
	let reviewed = false;
	for (const raw of branch) {
		const e = raw as Entry;
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "user") reviewed = false;
		else if (m.role === "toolResult" && !m.isError && resultText(m).includes(REVIEW_MARK)) reviewed = true;
	}
	return reviewed;
}

/** The snapshot commit the last scoped review of `dir` covered, from the marks on the branch. */
export function lastReview(branch: Iterable<unknown>, dir: string): string | undefined {
	let snap: string | undefined;
	const mark = `${REVIEW_MARK}${dir} at `;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message.isError) continue;
		const text = resultText(e.message);
		const at = text.lastIndexOf(mark);
		if (at >= 0) snap = /^[0-9a-f]{7,64}/.exec(text.slice(at + mark.length))?.[0] ?? snap;
	}
	return snap;
}

/** The app a reviewer call is about: an apps path in the task, then a /tmp/<name>-review.diff, then the cwd. */
export function reviewApp(task: string, cwd: string, home: string): string | undefined {
	const named = appDir(task, "", home);
	if (named) return named;
	const diff = /\/tmp\/([A-Za-z0-9._-]+)-review\.diff/.exec(task)?.[1];
	return diff ? join(home, "workspace", "apps", diff) : appDir("", cwd, home);
}

/** A subagent call that runs a reviewer some way other than a direct `agent: "reviewer"` call. */
export function indirectReviewer(input: Record<string, unknown>): boolean {
	if (input.agent !== undefined) return false;
	const { workflow, chain, tasks, script } = input;
	return [workflow, chain, tasks, script].some((v) => v !== undefined && /\breviewer\b/.test(typeof v === "string" ? v : JSON.stringify(v)));
}

/** True when `npm run verify` passed in `dir` after the last edit or write to a code file there. */
export function verifiedSinceEdit(branch: Iterable<unknown>, dir: string, cwd: string, home: string): boolean {
	const verifies = new Set<string>();
	let lastEdit = -1;
	let lastVerify = -1;
	let i = 0;
	for (const raw of branch) {
		i++;
		const e = raw as Entry;
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const c of m.content as ToolCallPart[]) {
				if (c.type !== "toolCall") continue;
				const path = c.arguments?.path;
				if ((c.name === "edit" || c.name === "write") && typeof path === "string") {
					const abs = path.replace(/^~(?=\/)/, home);
					const full = isAbsolute(abs) ? abs : join(cwd, abs);
					if (full.startsWith(`${dir}/`) && !reviewFree(full.slice(dir.length + 1))) lastEdit = i;
				}
				const command = c.arguments?.command;
				if (c.name === "bash" && typeof command === "string" && /\bnpm\s+run\s+verify\b/.test(command) && appDir(command, cwd, home) === dir && c.id) verifies.add(c.id);
			}
		} else if (m.role === "toolResult" && m.toolCallId && verifies.has(m.toolCallId) && !m.isError) {
			lastVerify = i;
		}
	}
	return lastVerify > lastEdit;
}

/** Read and search calls a scoped reviewer gets. At `soft` it is told to finish; after `hard` every tool is blocked. */
export const REVIEW_BUDGET = { soft: 12, hard: 20, block: "*" } as const;

export type ReviewScope = {
	dir: string;
	/** Where the diff starts: the last review's snapshot, or the branch point from main. */
	base: string;
	baseFrom: "review" | "main";
	diffPath: string;
	files: { path: string; added: string; removed: string }[];
};

/** The scope the guard puts in front of the parent's review task. */
export function reviewHeader(s: ReviewScope): string {
	const files = s.files.map((f) => `- ${f.path} (+${f.added} -${f.removed})`).join("\n");
	const from =
		s.baseFrom === "review"
			? `the state the last review covered (${s.base.slice(0, 8)}); everything before it was already reviewed, so don't review it again`
			: `where the branch left main (${s.base.slice(0, 8)})`;
	return [
		"[Review scope, set by pi-guard. Follow it exactly.]",
		`App: ${s.dir} (your working directory). Its AGENTS.md, if it has one, is already in your context.`,
		`Diff: ${s.diffPath}, every change from ${from} to the current working tree, uncommitted and new files included, lockfiles and build output left out.`,
		`Changed files:\n${files}`,
		"`npm run verify` (typecheck, lint, guardrail tests, unit tests and e2e tests) passed after the last code edit. Don't check whether tests pass or run, and don't read config, CI, lock, test-result, coverage or git files.",
		`Read the diff first. Open a file outside the list only to check a caller, a definition or a contract the diff depends on. Put independent reads in one turn. You have ${REVIEW_BUDGET.hard} tool calls; at ${REVIEW_BUDGET.soft} write your review.`,
		"",
		"[The parent's request]",
	].join("\n");
}

// The shell commands and Python code a tool call would run, for bash and context-mode's ctx_* tools.
export function codeOf(toolName: string, input: Record<string, unknown>): { shell: string[]; python: string[] } {
	const str = (v: unknown) => (typeof v === "string" ? [v] : []);
	if (toolName === "bash" || toolName === "bg_bash") return { shell: str(input.command), python: [] };
	if (toolName === "ctx_execute") {
		if (input.language === "shell") return { shell: str(input.code), python: [] };
		if (input.language === "python") return { shell: [], python: str(input.code) };
	}
	if (toolName === "ctx_batch_execute" && Array.isArray(input.commands)) {
		return { shell: input.commands.flatMap((c) => str((c as { command?: unknown })?.command)), python: [] };
	}
	return { shell: [], python: [] };
}

const SKILL_PUSH = /thatsit-app\.ts\s+(?:pr|ship|gateway-pr)\b(?!-wait)/;
const PR_OPEN = /thatsit-app\.ts\s+(?:pr|gateway-pr)\b(?!-wait)/;
const CI_WAIT = /thatsit-app\.ts\s+(?:pr-wait|gateway-pr-wait|ship)\b/;

export function checkToolCall(toolName: string, input: Record<string, unknown>, env: Env): Block | undefined {
	if (toolName === "bash") {
		const command = String(input.command ?? "");
		// pr and gateway-pr return in seconds, so a timeout means the model thinks it waits.
		if (typeof input.timeout === "number" && PR_OPEN.test(command)) return { block: true, reason: REASONS.prTimeout };
		// Waiting on CI belongs to bg_bash, whether or not the command is backgrounded.
		if (CI_WAIT.test(command)) return { block: true, reason: REASONS.waitInBackground };
	}
	const { shell, python } = codeOf(toolName, input);
	for (const command of shell) {
		const v = checkShell(command, env);
		if (v) return v;
	}
	if (python.some((code) => pythonRewrite(code) && appDir(code, env.cwd, env.home))) return { block: true, reason: REASONS.rewrite };
	if (toolName === "write" && typeof input.path === "string") return checkOverwrite(input.path, env);
	return undefined;
}

export const OVERWRITE_LINES = 80;

// A whole-file write over a long existing app file, blocked once per path.
function checkOverwrite(raw: string, env: Env): Block | undefined {
	if (!env.lines || !env.rewrites) return undefined;
	const expanded = raw.replace(/^~(?=\/)/, env.home);
	const path = isAbsolute(expanded) ? expanded : join(env.cwd, expanded);
	if (!path.startsWith(`${join(env.home, "workspace", "apps")}/`)) return undefined;
	if ((env.lines(path) ?? 0) <= OVERWRITE_LINES || env.rewrites.has(path)) return undefined;
	env.rewrites.add(path);
	return { block: true, reason: REASONS.overwrite };
}

// --- stalled turns ---

type Msg = { role: string; stopReason?: string; content?: unknown; customType?: string; toolName?: string; details?: unknown };

export const NUDGE_TYPE = "pi-guard-nudge";
export const MAX_NUDGES = 2;
// Every real end-of-turn reply in the keeb session was 381+ characters; every stall was empty or ~150.
export const SHORT_REPLY = 250;
export const NUDGE =
	"Your turn ended without a reply to Michael. If the task is finished, write your final reply now, here in the chat (not in memory or a file). If it is not finished, continue with the next step now. If you are blocked or need a decision, ask one question.";

const parts = (m: Msg): { type: string; text?: string; name?: string }[] => (Array.isArray(m.content) ? m.content : []);
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : parts(m).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n"));

// The run started a bg_bash job whose bg-bash-done message has not arrived: ending the turn is the plan, and
// the done message starts the next one.
export function waitingOnBgJob(run: Msg[]): boolean {
	const open = new Set<string>();
	for (const m of run) {
		if (m.role === "toolResult" && m.toolName === "bg_bash") {
			const d = m.details as { id?: unknown } | undefined;
			const id = /started job (bg-\d+)/.exec(textOf(m))?.[1] ?? (typeof d?.id === "string" ? d.id : undefined);
			if (id) open.add(id);
		} else if (m.role === "custom" && m.customType === "bg-bash-done") {
			const id = /^bg_bash job (bg-\d+) /.exec(textOf(m))?.[1];
			if (id) open.delete(id);
		}
	}
	return open.size > 0;
}

// The reply puts a question to Michael: a sentence of prose ends in "?" (markdown emphasis and closing
// brackets aside; "a?.b" or "?q=" don't count). pi-web replies close with a "TL;DR:" line, so the question is rarely the last character.
// Code blocks and quotes don't count.
export function asksUser(text: string): boolean {
	let fenced = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (fenced || line.startsWith(">")) continue;
		if (/\?[*_`)\]"'”’]*(\s|$)/.test(line)) return true;
	}
	return false;
}

// A coding run (it edited or wrote a file) that ended right after a tool result with a short statement.
export function shouldNudge(messages: Msg[]): boolean {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	if (waitingOnBgJob(run)) return false;
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (run.at(-2)?.role !== "toolResult") return false;
	const coded = run.some((m) => m.role === "assistant" && parts(m).some((p) => p.type === "toolCall" && (p.name === "edit" || p.name === "write")));
	if (!coded) return false;
	if (run.filter((m) => m.role === "custom" && m.customType === NUDGE_TYPE).length >= MAX_NUDGES) return false;
	// Once sent back to tidy the to-do list, a short "list updated" reply is the expected answer.
	if (run.some((m) => m.role === "custom" && m.customType === TODO_NUDGE_TYPE)) return false;
	const text = textOf(last).trim();
	return text.length < SHORT_REPLY && !asksUser(text);
}

// --- open to-dos at the end of a run ---

export type Todo = { id: number; subject: string; status: string };

export const TODO_NUDGE_TYPE = "pi-guard-todos";
export const MAX_TODO_NUDGES = 2;
const OPEN = new Set(["in_progress", "pending"]);

// The to-do list as rpiv-todo rebuilds it: the last `todo` tool result on the session branch wins.
export function openTodos(branch: Iterable<unknown>): Todo[] {
	let tasks: Todo[] = [];
	for (const entry of branch) {
		const msg = (entry as { type?: string; message?: { role?: string; toolName?: string; details?: { tasks?: unknown } } }).message;
		if ((entry as { type?: string }).type !== "message" || msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (Array.isArray(msg.details?.tasks)) tasks = msg.details.tasks as Todo[];
	}
	return tasks.filter((t) => OPEN.has(t.status));
}

// A run that did work (edited, wrote or used the todo tool) ended with a reply, not a question, while to-dos are open.
export function shouldNudgeTodos(messages: Msg[], open: Todo[]): boolean {
	if (!open.length) return false;
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	if (waitingOnBgJob(run)) return false;
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (asksUser(textOf(last))) return false;
	const worked = run.some((m) => m.role === "assistant" && parts(m).some((p) => p.type === "toolCall" && (p.name === "edit" || p.name === "write" || p.name === "todo")));
	if (!worked) return false;
	return run.filter((m) => m.role === "custom" && m.customType === TODO_NUDGE_TYPE).length < MAX_TODO_NUDGES;
}

export function todoNudge(open: Todo[]): string {
	const items = open.map((t) => `- #${t.id} ${t.subject} (${t.status === "in_progress" ? "in progress" : "pending"})`).join("\n");
	return `Before you finish: your to-do list still has ${open.length} open item${open.length === 1 ? "" : "s"}:\n${items}\nUpdate it now with the todo tool: mark each finished item completed, and delete items that no longer apply. If an item is really unfinished, keep working on it, or say in your reply what is left.`;
}

// --- an app changed without a PR ---

export const PR_NUDGE_TYPE = "pi-guard-pr";
export const MAX_PR_NUDGES = 2;

type Call = { type: string; name?: string; arguments?: Record<string, unknown> };

// Apps this prompt's run edited or wrote with no pr/ship/gateway-pr after the last such edit, that still have work
// to publish (needsPr: uncommitted changes, unpushed commits, or a branch never pushed).
export function appsNeedingPr(messages: Msg[], home: string, needsPr: (dir: string) => boolean): string[] {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const lastEdit = new Map<string, number>();
	let lastPush = -1;
	messages.slice(start).forEach((m, i) => {
		if (m.role !== "assistant") return;
		for (const c of parts(m) as Call[]) {
			if (c.type !== "toolCall") continue;
			if ((c.name === "edit" || c.name === "write") && typeof c.arguments?.path === "string") {
				const dir = appDir(c.arguments.path, "", home);
				if (dir) lastEdit.set(dir, i);
			}
			if ((c.name === "bash" || c.name === "bg_bash") && SKILL_PUSH.test(String(c.arguments?.command ?? ""))) lastPush = i;
		}
	});
	return [...lastEdit].filter(([, i]) => i > lastPush).map(([dir]) => dir).filter(needsPr);
}

export function shouldNudgePr(messages: Msg[], apps: string[]): boolean {
	if (!apps.length) return false;
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	if (waitingOnBgJob(run)) return false;
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (asksUser(textOf(last))) return false;
	return run.filter((m) => m.role === "custom" && m.customType === PR_NUDGE_TYPE).length < MAX_PR_NUDGES;
}

export function prNudge(apps: string[]): string {
	const name = (d: string) => d.split("/").pop();
	const cmds = apps.map((d) => `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr ~/workspace/apps/${name(d)} --title "<short title>" --body "<what and why>"`).join("\n");
	const waitCmds = apps.map((d) => `node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts pr-wait ~/workspace/apps/${name(d)}`).join("\n");
	return `You changed ${apps.map(name).join(" and ")} but did not open or update its pull request. Do it yourself now; never hand Michael commands to run. If you are on main, or on a branch whose PR is already merged, first create a new branch from main (git switch -c <short-name>). Commit, then run pr:\n${cmds}\nThen wait for CI with the bg_bash tool (never bash), tell Michael the PR link and end your turn:\n${waitCmds}\nIf Michael said not to open a PR, say so in one line instead.`;
}

// Compaction. Some extensions inject their rules as a message at session start and again after every
// compaction (i-have-adhd). pi's summarizer reads that message as the user's first request and makes it the
// summary's goal, so the real task is lost when a compaction falls between turns. They are re-added anyway.
export const REINJECTED_TYPES: ReadonlySet<string> = new Set(["i-have-adhd-rules", "i-have-adhd-disabled"]);

/** Remove re-injected rule messages from `messages` in place; pi summarizes the same array after the hook. */
export function dropReinjected(messages: unknown[] | undefined): void {
	if (!messages) return;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i] as { role?: string; customType?: string };
		if (m?.role === "custom" && REINJECTED_TYPES.has(m.customType ?? "")) messages.splice(i, 1);
	}
}

// --- a questionnaire closed partway ---

type Answer = { questionIndex?: number; question?: string; kind?: string; answer?: string | null; selected?: string[] };

// rpiv-ask-user-question reports any cancelled questionnaire as "User declined to answer questions" and keeps
// the answers given before the cancel in `details`, which the model never sees. Returns the text the model
// should get instead, or undefined when there is nothing to recover (a plain decline, or a full answer).
export function partialAnswers(input: { questions?: { question?: string }[] } | undefined, details: unknown): string | undefined {
	const d = details as { cancelled?: boolean; answers?: Answer[] } | undefined;
	if (!d?.cancelled || !d.answers?.length) return undefined;
	const questions = input?.questions ?? [];
	const total = Math.max(questions.length, d.answers.length);
	const given = d.answers.map((a) => `"${a.question ?? ""}"="${a.kind === "multi" ? (a.selected ?? []).join(", ") : (a.answer ?? "")}"`).join(" ");
	const done = new Set(d.answers.map((a) => a.questionIndex));
	const open = questions.map((q, i) => (done.has(i) ? null : `"${q.question ?? ""}"`)).filter(Boolean);
	return `The user answered ${d.answers.length} of ${total} questions, then closed the questionnaire: ${given} Use these answers.${open.length ? ` Not answered: ${open.join(", ")}.` : ""} Closing it is not a preference about how you ask: keep the same format, and ask what is still open again if you need it.`;
}
