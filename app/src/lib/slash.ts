import type { CommandInfo, ModelInfo } from "../../../shared/src/protocol.ts";

export interface SlashItem {
	name: string;
	description: string;
	kind: "builtin" | CommandInfo["source"];
	rpcOnly?: boolean; // unavailable while the session is open in the terminal
}

// TUI built-ins that RPC doesn't expose; the app implements them (spec §5.3).
export const BUILTINS: SlashItem[] = [
	{ name: "model", description: "switch model, or /model <name>", kind: "builtin" },
	{ name: "thinking", description: "set thinking level, or /thinking <level>", kind: "builtin" },
	{ name: "compact", description: "compact context, optionally with instructions", kind: "builtin" },
	{ name: "name", description: "name this session, or show its name", kind: "builtin" },
	{ name: "session", description: "session stats and info", kind: "builtin" },
	{ name: "new", description: "start a new session", kind: "builtin" },
	{ name: "resume", description: "browse sessions", kind: "builtin" },
	{ name: "copy", description: "copy the last reply", kind: "builtin" },
	{ name: "fork", description: "new session from an earlier message", kind: "builtin", rpcOnly: true },
	{ name: "clone", description: "copy this session into a new one", kind: "builtin", rpcOnly: true },
	{ name: "export", description: "download this session as HTML", kind: "builtin", rpcOnly: true },
];

export const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

export function slashItems(commands: CommandInfo[]): SlashItem[] {
	return [
		...BUILTINS,
		...commands.filter((c) => !BUILTIN_NAMES.has(c.name)).map((c) => ({ name: c.name, description: c.description || c.source, kind: c.source, rpcOnly: c.source === "extension" })),
	];
}

export function slashQuery(input: string): string | null {
	const m = input.match(/^\/(\S*)$/);
	return m ? m[1] : null;
}

function score(name: string, q: string): number {
	if (!q) return 1;
	if (name.startsWith(q)) return 3;
	if (name.includes(q)) return 2;
	let i = 0;
	for (const ch of name) if (ch === q[i]) i++;
	return i === q.length ? 1 : 0;
}

export function filterSlash(items: SlashItem[], query: string, limit = 8): SlashItem[] {
	const q = query.toLowerCase();
	return items
		.map((item) => ({ item, score: score(item.name.toLowerCase(), q) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || (q ? a.item.name.length - b.item.name.length : 0))
		.slice(0, limit)
		.map((x) => x.item);
}

export type ParsedInput =
	| { kind: "builtin"; name: string; args: string }
	| { kind: "bash"; command: string; excludeFromContext: boolean }
	| { kind: "prompt"; text: string };

export function parseInput(text: string): ParsedInput {
	const t = text.trim();
	const bang = t.match(/^(!!?)\s*([\s\S]+)$/);
	if (bang) return { kind: "bash", command: bang[2].trim(), excludeFromContext: bang[1] === "!!" };
	const slash = t.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
	if (slash && BUILTIN_NAMES.has(slash[1])) return { kind: "builtin", name: slash[1], args: (slash[2] ?? "").trim() };
	return { kind: "prompt", text };
}

export function matchModel(models: ModelInfo[], query: string): ModelInfo | null {
	const q = query.trim().toLowerCase();
	const exact = models.find((m) => m.id.toLowerCase() === q || `${m.provider}/${m.id}`.toLowerCase() === q);
	if (exact) return exact;
	const hits = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
	return hits.length === 1 ? hits[0] : null;
}
