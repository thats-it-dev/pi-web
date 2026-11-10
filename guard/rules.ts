// Pure rules for the guard extension. index.ts wires them to pi's events.
import { join } from "node:path";

export type Block = { block: true; reason: string };

const SKILL_CLI = "node ~/.pi/agent/skills/thatsit-app/scripts/thatsit-app.ts";

export const REASONS = {
	push: `Blocked: in an app, never push yourself. Commit, then run \`${SKILL_CLI} pr <dir> ...\` (or \`ship\` for the first version); it pushes, waits for CI and prints the failing log lines.`,
	ci: `Blocked: don't wait for or poll CI yourself (no sleep, gh run list/watch/view, gh pr checks). \`${SKILL_CLI} pr\` and \`ship\` already wait for CI and print the failing log lines; rerun the same command after a fix.`,
	e2e: "Blocked: the full e2e suite runs only before a commit, through `npm run verify`. While iterating, run one spec: `npm run e2e:one -- e2e/<file>.spec.ts`.",
	rewrite: "Blocked: don't rewrite files with a Python script. Use the edit tool (read the lines first); it checks the edit and tells you when the old text doesn't match.",
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

export type Env = { cwd: string; home: string; hasScript: (dir: string, name: string) => boolean; dirty: (dir: string) => boolean };

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
	return undefined;
}

// The shell commands and Python code a tool call would run, for bash and context-mode's ctx_* tools.
export function codeOf(toolName: string, input: Record<string, unknown>): { shell: string[]; python: string[] } {
	const str = (v: unknown) => (typeof v === "string" ? [v] : []);
	if (toolName === "bash") return { shell: str(input.command), python: [] };
	if (toolName === "ctx_execute") {
		if (input.language === "shell") return { shell: str(input.code), python: [] };
		if (input.language === "python") return { shell: [], python: str(input.code) };
	}
	if (toolName === "ctx_batch_execute" && Array.isArray(input.commands)) {
		return { shell: input.commands.flatMap((c) => str((c as { command?: unknown })?.command)), python: [] };
	}
	return { shell: [], python: [] };
}

export function checkToolCall(toolName: string, input: Record<string, unknown>, env: Env): Block | undefined {
	const { shell, python } = codeOf(toolName, input);
	for (const command of shell) {
		const v = checkShell(command, env);
		if (v) return v;
	}
	if (python.some((code) => pythonRewrite(code) && appDir(code, env.cwd, env.home))) return { block: true, reason: REASONS.rewrite };
	return undefined;
}

// --- stalled turns ---

type Msg = { role: string; stopReason?: string; content?: unknown; customType?: string };

export const NUDGE_TYPE = "pi-guard-nudge";
export const MAX_NUDGES = 2;
// Every real end-of-turn reply in the keeb session was 381+ characters; every stall was empty or ~150.
export const SHORT_REPLY = 250;
export const NUDGE =
	"Your turn ended without a reply to Michael. If the task is finished, write your final reply now, here in the chat (not in memory or a file). If it is not finished, continue with the next step now. If you are blocked or need a decision, ask one question.";

const parts = (m: Msg): { type: string; text?: string; name?: string }[] => (Array.isArray(m.content) ? m.content : []);
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : parts(m).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n"));

// A coding run (it edited or wrote a file) that ended right after a tool result with a short statement.
export function shouldNudge(messages: Msg[]): boolean {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	const run = messages.slice(start);
	const last = run.at(-1);
	if (!last || last.role !== "assistant" || last.stopReason !== "stop") return false;
	if (run.at(-2)?.role !== "toolResult") return false;
	const coded = run.some((m) => m.role === "assistant" && parts(m).some((p) => p.type === "toolCall" && (p.name === "edit" || p.name === "write")));
	if (!coded) return false;
	if (run.filter((m) => m.role === "custom" && m.customType === NUDGE_TYPE).length >= MAX_NUDGES) return false;
	const text = textOf(last).trim();
	return text.length < SHORT_REPLY && !text.endsWith("?");
}
