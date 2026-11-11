// pi-web superpowers switch: the superpowers skills stay manual (/skill:<name>) until the chat turns them on.
// The superpowers package loads no skills and no extension (settings.json); this extension serves copies of its
// skills marked disable-model-invocation, so the session's first system prompt never lists them. Off: nothing
// more. On: the using-superpowers bootstrap goes with every request and offers the copies to the model,
// as the package's own extension would do, with the list of skills in that message (pi leaves manual skills out of
// the system prompt, and a mid-chat prompt change is not reliable). The state is per chat, saved in the session.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENTRY_TYPE = "pi-web-superpowers";
export const STATUS_KEY = "superpowers";
export const STATUS_ON = "superpowers on";
const MARKER = "superpowers:using-superpowers bootstrap for pi";

/** flash-auto's reasoning floor entry (`{ level }`, latest wins, null clears). Following a long process skill
 *  falls apart when the router reads a short reply ("No I want options lists") as a reason to stop thinking. */
export const FLOOR_ENTRY = "flash-auto-floor";
export const FLOOR = "medium";

function savedFloor(branch: Iterable<unknown>): string | null {
	let level: string | null = null;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type === "custom" && e.customType === FLOOR_ENTRY) level = ((e.data as { level?: unknown } | undefined)?.level as string | null) ?? null;
	}
	return level;
}

/** Superpowers skills left out: they fight the thatsit-app flow and the guard (worktrees move app edits out of
 *  ~/workspace/apps, finishing-a-development-branch pushes and merges, the review skills send unscoped reviewers). */
export const EXCLUDED = ["using-git-worktrees", "finishing-a-development-branch", "subagent-driven-development", "requesting-code-review"];

/** Excluded skills whose files executing-plans uses by relative path (`sdd-workspace`, `review-package`, the
 *  task-start/task-done helpers, code-reviewer.md). Their files are linked with no SKILL.md, so pi never lists them. */
export const SUPPORT_ONLY = ["subagent-driven-development", "requesting-code-review"];

/** pi's rules, put at the top of a skill's body. Plans run inline: on flash-next a fresh worker per task starts
 *  cold, re-reads the codebase and thinks for 5-11 min per turn; on the cad run (2026-11-11) 14 of 20 workers
 *  timed out and the parent redid their tasks in the main session in a fraction of the time. */
export const PI_NOTES: Record<string, string> = {
	"writing-plans":
		"> **In pi:** plans run inline with superpowers:executing-plans: you implement every task yourself, in this session. subagent-driven-development is not available here, so don't offer it, recommend it, or look for it elsewhere on disk (e.g. ~/.claude/plugins). At the handoff, don't ask which execution approach to use; ask only whether the plan captures what they want, then use superpowers:executing-plans.",
	"executing-plans":
		"> **In pi:** every plan runs this way. Never switch to subagent-driven-development and never dispatch a `worker` subagent per task. Final review: in an app under ~/workspace/apps, use the thatsit-app skill's Review step (`subagent` with agent `reviewer`; the guard writes the scoped diff) instead of review-package and code-reviewer.md, and finish with its pr steps, not finishing-a-development-branch. Elsewhere, run review-package and call `subagent` with agent `reviewer` on the file it prints.",
};

/** The notes when the agent pair is pi's model (spec: docs/superpowers/specs/2026-11-11-spark-agent-pair-design.md):
 *  the orchestrator still runs executing-plans itself, with subagents for scouting, writing and review. */
export const PI_NOTES_PAIR: Record<string, string> = {
	"writing-plans":
		"> **In pi (agent pair):** plans run with superpowers:executing-plans by the orchestrator, with subagents for scouting, writing and review as that skill's pi note describes. Don't ask which execution approach to use. Mark tasks that don't depend on each other's files or interfaces with a line `**Parallel group:** <letter>` right under the task heading; tasks in one group run as parallel workers in worktrees. A task without the line runs alone.",
	"executing-plans": [
		"> **In pi (agent pair):** you orchestrate; subagents do the reading, writing and reviewing. The rules, in order:",
		"> 1. **Prefetch.** When task N starts, launch two `scout` subagents async (read-only, ≤ 2k tokens each) for task N+1: the files it names and their seams, the test files and names, the spec sections. Their output goes into N+1's brief.",
		"> 2. **Brief.** A worker brief carries: the task text from the plan, the scout findings, acceptance (the exact failing test to write first, the verify command), the budget rules, and \"do not open a PR, do not push\". Briefs live in the plan's `.superpowers/sdd/` workspace.",
		"> 3. **Write.** One `worker` per task, launched as an async single (`async: true`, with `checkpointBeforeDeadlineMs`); you stay awake for scout and reviewer results and steer the worker on a P1. A task group the plan marks `**Parallel group:**` is one async single per task with `worktree: true`; merge the branches in plan order onto the plan branch and rerun verify after each merge. Worktree workers run typecheck and unit tests only, never e2e; the full `npm run verify` runs once in the main checkout after each merge. Commit the plan branch before a fan-out.",
		"> 4. **Gate.** On the worker's commit: run verify; on green, call `subagent` with agent `reviewer` and `async: true` (the guard writes the scoped diff and marks the review when the run completes) and start task N+1 at once.",
		"> 5. **Fix.** Review findings queue to the next task boundary, except a P1 on a file the current task edits, which is fixed now. Every fix is RED → GREEN plus a green suite.",
		"> 6. **Final.** After the last task: a final whole-branch review with agent `reviewer` and `model: \"spark/qwen3.8-27b-pi\"`, one fix pass, then the thatsit-app skill's pr steps. Never finishing-a-development-branch.",
		"> 7. **Runaways.** A worker that hits its deadline hands off state on disk (its checkpoint); resume it with `action: \"resume\"` or finish the task inline. Never dispatch a second worker on the same files while one is running.",
	].join("\n"),
};

/** True when pi's settings make the agent pair the session model and the MoE the subagent default. */
export function pairMode(settings: unknown): boolean {
	const s = settings as { defaultModel?: unknown; subagents?: { defaultModel?: unknown } } | undefined;
	const main = typeof s?.defaultModel === "string" ? s.defaultModel : "";
	const sub = typeof s?.subagents?.defaultModel === "string" ? s.subagents.defaultModel : "";
	return (main.endsWith("pair-auto") || main.endsWith("qwen3.8-27b-pi")) && sub.endsWith("qwen3.6-35b-a3b-sglang");
}

/** A skill's SKILL.md for pi: its pi note after the frontmatter, and no plan header pointing at a skill pi doesn't have. */
export function forPi(name: string, md: string, notes: Record<string, string> = PI_NOTES): string {
	let out = md.replace("superpowers:subagent-driven-development (recommended) or superpowers:executing-plans", "superpowers:executing-plans");
	const note = notes[name];
	if (!note) return out;
	const m = /^---\n[\s\S]*?\n---\n/.exec(out);
	const at = m ? m[0].length : 0;
	return `${out.slice(0, at)}\n${note}\n\n${out.slice(at)}`;
}

const SOURCE = join(homedir(), ".pi", "agent", "git", "github.com", "obra", "superpowers", "skills");
const MANUAL = join(homedir(), ".pi", "agent", "tmp", "superpowers-manual");

/** Writes manual-only copies of the superpowers skills to `out`: each SKILL.md gains disable-model-invocation,
 *  every other file is a symlink to the original, so relative references still resolve. Returns `out`, or
 *  undefined when superpowers is not installed. */
export function buildManualSkills(src = SOURCE, out = MANUAL, exclude = EXCLUDED, supportOnly = SUPPORT_ONLY, notes: Record<string, string> = PI_NOTES): string | undefined {
	if (!existsSync(src)) return undefined;
	rmSync(out, { recursive: true, force: true });
	for (const name of readdirSync(src)) {
		const skill = join(src, name, "SKILL.md");
		const support = supportOnly.includes(name);
		if ((exclude.includes(name) && !support) || !existsSync(skill)) continue;
		const dir = join(out, name);
		mkdirSync(dir, { recursive: true });
		for (const f of readdirSync(join(src, name))) if (f !== "SKILL.md") symlinkSync(join(src, name, f), join(dir, f));
		if (!support) writeFileSync(join(dir, "SKILL.md"), manualOnly(forPi(name, readFileSync(skill, "utf8"), notes)));
	}
	return out;
}

/** A SKILL.md with disable-model-invocation: true in its frontmatter. */
export function manualOnly(md: string): string {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
	if (!m) return `---\ndisable-model-invocation: true\n---\n${md}`;
	const front = m[1].split("\n").filter((l) => !/^disable-model-invocation:/.test(l));
	return `---\n${[...front, "disable-model-invocation: true"].join("\n")}\n---\n${md.slice(m[0].length)}`;
}

type Entry = { type?: string; customType?: string; data?: unknown };
type Ctx = { sessionManager?: { getBranch(): Iterable<unknown> }; ui?: { setStatus(key: string, text: string | undefined): void; notify(message: string, type?: "info" | "warning" | "error"): void } };
type PiApi = {
	on(event: string, handler: (event: any, ctx: Ctx) => unknown): unknown;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> | void }): void;
	appendEntry(customType: string, data?: unknown): void;
};

/** The chat's switch: the last saved state on the branch, off when none. */
export function savedState(branch: Iterable<unknown>): boolean {
	let on = false;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type === "custom" && e.customType === ENTRY_TYPE) on = (e.data as { on?: unknown } | undefined)?.on === true;
	}
	return on;
}

/** The superpowers skills in `dir` (the manual copies), as a list the model can act on. */
export function catalog(dir = MANUAL): string {
	let names: string[] = [];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return "";
	}
	const rows = names.flatMap((name) => {
		const file = join(dir, name, "SKILL.md");
		try {
			const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
			const description = /^description:\s*(.+)$/m.exec(front)?.[1].replace(/^["']|["']$/g, "").trim() ?? "";
			return name === "using-superpowers" ? [] : [`- ${name}: ${description} (${file})`];
		} catch {
			return [];
		}
	});
	return rows.length ? `## Superpowers skills in this chat\n\nWhen one applies, read its SKILL.md with the read tool and follow it.\n\n${rows.join("\n")}` : "";
}

const SUPERPOWERS = join(SOURCE, "using-superpowers");
const strip = (md: string) => /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(md)?.[1].trim() ?? md.trim();

/** The bootstrap the package's own extension sends: using-superpowers plus its pi tool mapping. */
export function bootstrap(dir = SUPERPOWERS, skills = MANUAL): string | null {
	try {
		const skill = strip(readFileSync(join(dir, "SKILL.md"), "utf8"));
		let tools = "";
		try {
			tools = readFileSync(join(dir, "references", "pi-tools.md"), "utf8").trim();
		} catch {}
		return `<EXTREMELY_IMPORTANT>\n${MARKER}\n\nYou have superpowers.\n\nThe using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.\n\n${skill}\n\n${tools}\n\n${catalog(skills)}\n</EXTREMELY_IMPORTANT>`;
	} catch {
		return null;
	}
}

/** Messages with the bootstrap after any compaction summary at the start; unchanged when already there. */
export function withBootstrap<M extends { role?: string; content?: unknown }>(messages: M[], text: string): M[] {
	if (messages.some((m) => JSON.stringify(m.content ?? "").includes(MARKER))) return messages;
	let at = 0;
	while (at < messages.length && messages[at].role === "compactionSummary") at++;
	const msg = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as unknown as M;
	return [...messages.slice(0, at), msg, ...messages.slice(at)];
}

export default function superpowersSwitch(pi: PiApi): void {
	let on = false;
	const show = (ctx: Ctx) => ctx.ui?.setStatus(STATUS_KEY, on ? STATUS_ON : undefined);

	pi.on("resources_discover", () => {
		let settings: unknown;
		try {
			settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
		} catch {
			settings = undefined; // no settings: the inline-only notes
		}
		const dir = buildManualSkills(undefined, undefined, undefined, undefined, pairMode(settings) ? PI_NOTES_PAIR : PI_NOTES);
		return dir ? { skillPaths: [dir] } : undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		const branch = [...(ctx.sessionManager?.getBranch() ?? [])];
		on = savedState(branch);
		// Chats switched on before the floor existed, or left with one after switching off.
		const want = on ? FLOOR : null;
		if (savedFloor(branch) !== want) pi.appendEntry(FLOOR_ENTRY, { level: want });
		show(ctx);
	});

	pi.registerCommand("superpowers", {
		description: "Superpowers in this chat: on (the model uses the skills on its own) or off (only /skill:<name>)",
		handler: (args, ctx) => {
			const want = args.trim().toLowerCase();
			const next = want === "on" ? true : want === "off" ? false : !on;
			on = next;
			pi.appendEntry(ENTRY_TYPE, { on });
			pi.appendEntry(FLOOR_ENTRY, { level: on ? FLOOR : null });
			show(ctx);
			ctx.ui?.notify(on ? "Superpowers on for this chat." : "Superpowers off: use /skill:<name> to run one.", "info");
		},
	});

	pi.on("context", (event) => {
		if (!on) return undefined;
		const text = bootstrap();
		return text ? { messages: withBootstrap(event.messages ?? [], text) } : undefined;
	});
}
