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

const SOURCE = join(homedir(), ".pi", "agent", "git", "github.com", "obra", "superpowers", "skills");
const MANUAL = join(homedir(), ".pi", "agent", "tmp", "superpowers-manual");

/** Writes manual-only copies of the superpowers skills to `out`: each SKILL.md gains disable-model-invocation,
 *  every other file is a symlink to the original, so relative references still resolve. Returns `out`, or
 *  undefined when superpowers is not installed. */
export function buildManualSkills(src = SOURCE, out = MANUAL, exclude = EXCLUDED): string | undefined {
	if (!existsSync(src)) return undefined;
	rmSync(out, { recursive: true, force: true });
	for (const name of readdirSync(src)) {
		const skill = join(src, name, "SKILL.md");
		if (exclude.includes(name) || !existsSync(skill)) continue;
		const dir = join(out, name);
		mkdirSync(dir, { recursive: true });
		for (const f of readdirSync(join(src, name))) if (f !== "SKILL.md") symlinkSync(join(src, name, f), join(dir, f));
		writeFileSync(join(dir, "SKILL.md"), manualOnly(readFileSync(skill, "utf8")));
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
		const dir = buildManualSkills();
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
