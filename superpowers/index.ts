// pi-web superpowers: a per-chat switch over a vendored, pi-patched subset of superpowers' skills (./skills:
// brainstorming, writing-plans, executing-plans, systematic-debugging, test-driven-development). The skills are
// manual (/skill:<name>) and never in the system prompt. Off: nothing more. On: a short catalog (name, description,
// path) rides with every request so the model can read one when it applies. There is no bootstrap and no
// mandatory workflow (2026-11-25; the raw obra/superpowers checkout is gone, so nothing excluded can be found on disk).
// The pi note on writing-plans and executing-plans switches to orchestrator wording when pi's settings say so.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENTRY_TYPE = "pi-web-superpowers";
export const STATUS_KEY = "superpowers";
export const STATUS_ON = "superpowers on";
/** The catalog message's first line; also how withCatalog tells it is already in the messages. */
export const MARKER = "## Superpowers skills in this chat";

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

/** The notes when an orchestrator runs plans (spec: docs/superpowers/specs/2026-11-11-spark-agent-pair-design.md):
 *  the session still runs executing-plans itself, with subagents for scouting, writing and review. Inline
 *  execution needs no note: the vendored skills say it. */
export const PI_NOTES_PAIR: Record<string, string> = {
	"writing-plans":
		"> **In pi (orchestrator):** plans run with the executing-plans skill by the orchestrator, with subagents for scouting, writing and review as that skill's pi note describes. Mark tasks that don't depend on each other's files or interfaces with a line `**Parallel group:** <letter>` right under the task heading; tasks in one group run as parallel workers in worktrees. A task without the line runs alone.",
	"executing-plans": [
		"> **In pi (orchestrator):** you orchestrate; subagents do the reading, writing and reviewing. The rules, in order:",
		"> 1. **Prefetch.** When task N starts, launch two `scout` subagents async (read-only, ≤ 2k tokens each) for task N+1: the files it names and their seams, the test files and names, the spec sections. Their output goes into N+1's brief.",
		"> 2. **Brief.** A worker brief carries: the task text from the plan, the scout findings, acceptance (the exact failing test to write first, the verify command), the budget rules, and \"do not open a PR, do not push\". Briefs live in the plan's `.superpowers/sdd/` workspace.",
		"> 3. **Write.** One `worker` per task, launched as an async single (`async: true`, with `checkpointBeforeDeadlineMs`); you stay awake for scout and reviewer results and steer the worker on a P1. A task group the plan marks `**Parallel group:**` is one async single per task with `worktree: true`; merge the branches in plan order onto the plan branch and rerun verify after each merge. Worktree workers run typecheck and unit tests only, never e2e; the full `npm run verify` runs once in the main checkout after each merge. Commit the plan branch before a fan-out. A worker launched without `worktree: true` owns the main checkout until its result arrives: no verify, e2e or commit there meanwhile (the guard blocks verify and e2e). A worktree shares the main checkout's node_modules through a symlink: the packages are already there, so never run `npm ci` or `npm install` in a worktree (the guard blocks it), and say so in every brief.",
		"> 4. **Gate.** On the worker's commit: run verify; on green, call `subagent` with agent `reviewer` and `async: true` (the guard writes the scoped diff and marks the review when the run completes) and start task N+1 at once. On red, resume the worker (`action: \"resume\"`) with the failing output, or dispatch a fresh worker whose brief names the failure; you never edit, write or delete app code yourself (the guard blocks it). Your files are the plan, the ledger and the briefs; merges, commits and verify in the main checkout are yours.",
		"> 5. **Fix.** Review findings queue to the next task boundary, except a P1 on a file the current task edits, which is fixed now. Every fix is RED → GREEN plus a green suite.",
		"> 6. **Final.** After the last task: a final whole-branch review with agent `reviewer`, one fix pass (by workers), then the thatsit-app skill's pr steps. A reviewer run that fails (stopReason `length`, a timeout) is re-dispatched once on a smaller diff; never review in its place, and if it fails again tell Michael which diff went unreviewed.",
		"> 7. **Runaways.** A worker that hits its deadline hands off state on disk (its checkpoint); resume it with `action: \"resume\"`, or dispatch a fresh worker whose brief names the checkpoint. Never dispatch a second worker on the same files while one is running.",
	].join("\n"),
};

/** True when pi's settings put an orchestrator in charge: `subagents.orchestrate` (a boolean) when set, else when the
 *  agent pair is the session model and the MoE the subagent default. The guard reads the same settings (pairSettings). */
export function pairMode(settings: unknown): boolean {
	const s = settings as { defaultModel?: unknown; subagents?: { defaultModel?: unknown; orchestrate?: unknown } } | undefined;
	if (typeof s?.subagents?.orchestrate === "boolean") return s.subagents.orchestrate;
	const main = typeof s?.defaultModel === "string" ? s.defaultModel : "";
	const sub = typeof s?.subagents?.defaultModel === "string" ? s.subagents.defaultModel : "";
	return (main.endsWith("pair-auto") || main.endsWith("qwen3.8-27b-pi")) && sub.endsWith("qwen3.6-35b-a3b-sglang");
}

/** A skill's SKILL.md with its pi note (if any) right after the frontmatter. */
export function forPi(name: string, md: string, notes: Record<string, string> = {}): string {
	const note = notes[name];
	if (!note) return md;
	const m = /^---\n[\s\S]*?\n---\n/.exec(md);
	const at = m ? m[0].length : 0;
	return `${md.slice(0, at)}\n${note}\n\n${md.slice(at)}`;
}

/** The vendored skills, next to this file. */
export const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "skills");
const MANUAL = join(homedir(), ".pi", "agent", "tmp", "superpowers-manual");

/** Writes manual-only copies of the vendored skills to `out`: each SKILL.md gains disable-model-invocation (and its
 *  pi note), every other file is a symlink to the original, so relative references still resolve. Returns `out`,
 *  or undefined when `src` is missing. */
export function buildManualSkills(src = SOURCE, out = MANUAL, notes: Record<string, string> = {}): string | undefined {
	if (!existsSync(src)) return undefined;
	rmSync(out, { recursive: true, force: true });
	for (const name of readdirSync(src)) {
		const skill = join(src, name, "SKILL.md");
		if (!existsSync(skill)) continue;
		const dir = join(out, name);
		mkdirSync(dir, { recursive: true });
		for (const f of readdirSync(join(src, name))) if (f !== "SKILL.md") symlinkSync(join(src, name, f), join(dir, f));
		writeFileSync(join(dir, "SKILL.md"), manualOnly(forPi(name, readFileSync(skill, "utf8"), notes)));
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

/** The chat's switch: the last saved state on the branch, off when none (every session type, every session). */
export function savedState(branch: Iterable<unknown>): boolean {
	let on = false;
	for (const raw of branch) {
		const e = raw as Entry;
		if (e.type === "custom" && e.customType === ENTRY_TYPE) on = (e.data as { on?: unknown } | undefined)?.on === true;
	}
	return on;
}

/** The skills in `dir` (the manual copies), as a short list the model can act on; "" when there are none. */
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
			return [`- ${name}: ${description} (${file})`];
		} catch {
			return [];
		}
	});
	return rows.length ? `${MARKER}\n\nSwitched on for this chat. When one clearly applies, read its SKILL.md with the read tool and follow it. A request whose details are all stated needs none of them: do the work.\n\n${rows.join("\n")}` : "";
}

/** Messages with the catalog after any compaction summary at the start; unchanged when already there. */
export function withCatalog<M extends { role?: string; content?: unknown }>(messages: M[], text: string): M[] {
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
			settings = undefined; // no settings: inline wording
		}
		const dir = buildManualSkills(undefined, undefined, pairMode(settings) ? PI_NOTES_PAIR : {});
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
		description: "Superpowers in this chat: on (the skills are listed for the model) or off (only /skill:<name>)",
		handler: (args, ctx) => {
			const want = args.trim().toLowerCase();
			const next = want === "on" ? true : want === "off" ? false : !on;
			on = next;
			pi.appendEntry(ENTRY_TYPE, { on });
			pi.appendEntry(FLOOR_ENTRY, { level: on ? FLOOR : null });
			show(ctx);
			ctx.ui?.notify(on ? "Superpowers on for this chat: the skills are listed for the model." : "Superpowers off: use /skill:<name> to run one.", "info");
		},
	});

	pi.on("context", (event) => {
		if (!on) return undefined;
		const text = catalog();
		return text ? { messages: withCatalog(event.messages ?? [], text) } : undefined;
	});
}
