// Approval modes: who answers a permission extension's dialog during a turn.
// pi itself never asks before a tool call; a permission extension does, with
// a select (Allow / Deny / ...) or a confirm, while a turn is running.
//   auto    the hub answers every one (the plain Allow, or yes)
//   semi    the hub answers only for an obviously benign call: reading,
//           listing or searching inside the session folder, writing or editing
//           a file inside it, or a read-only shell command
//   manual  every dialog reaches the app
// A dialog outside a running turn (a slash command asking something), an input
// or editor, or a select with no recognisable allow option always reaches the
// app, whatever the mode.

import { resolve, sep } from "node:path";
import type { ApprovalMode, Dialog } from "../../shared/src/protocol.ts";

export const ALLOW_EXACT = /^(allow|yes|approve|ok|accept)$/i;
export const ALLOW_PREFIX = /^(allow|yes|approve|accept)\b/i;
export const DENY_EXACT = /^(deny|no|reject|cancel|decline)$/i;
export const DENY_PREFIX = /^(deny|no|reject|decline)\b/i;

export function findAllow(options: string[]): string | undefined {
	return options.find((o) => ALLOW_EXACT.test(o)) ?? options.find((o) => ALLOW_PREFIX.test(o));
}

export function findDeny(options: string[]): string | undefined {
	return options.find((o) => DENY_EXACT.test(o)) ?? options.find((o) => DENY_PREFIX.test(o));
}

export type AutoAnswer = { value: string } | { confirmed: true };

export interface PendingTool {
	name: string;
	args: unknown;
}

export interface ApprovalContext {
	mode: ApprovalMode;
	running: boolean; // a turn is in progress
	cwd: string; // the session folder
	tool: PendingTool | null; // the call the dialog is about, when known
}

export function autoAnswer(d: Pick<Dialog, "method" | "options">, ctx: ApprovalContext): AutoAnswer | null {
	if (ctx.mode === "manual" || !ctx.running) return null;
	if (ctx.mode === "semi" && !(ctx.tool && benignTool(ctx.tool, ctx.cwd))) return null;
	if (d.method === "confirm") return { confirmed: true };
	if (d.method !== "select") return null;
	const options = (d.options ?? []).map((o) => String(o).trim());
	const allow = findAllow(options);
	return allow === undefined ? null : { value: allow };
}

// pi's built-in tools, by what they touch. Anything else (extension tools) asks.
const READS = new Set(["read", "ls", "find", "grep"]);
const WRITES = new Set(["write", "edit"]);

export function benignTool(tool: PendingTool, cwd: string): boolean {
	const args = (tool.args && typeof tool.args === "object" ? tool.args : {}) as Record<string, unknown>;
	if (READS.has(tool.name) || WRITES.has(tool.name)) {
		const path = args.path;
		if (path === undefined || path === null || path === "") return READS.has(tool.name); // find/grep default to the folder
		return typeof path === "string" && insideFolder(path, cwd);
	}
	if (tool.name === "bash") return typeof args.command === "string" && benignCommand(args.command);
	return false;
}

export function insideFolder(path: string, cwd: string): boolean {
	if (path.startsWith("~")) return false;
	const root = resolve(cwd);
	const full = resolve(cwd, path);
	return full === root || full.startsWith(root + sep);
}

// Read-only commands, one per pipeline segment; no redirection, substitution or sudo.
const READ_ONLY = new Set(["ls", "cat", "head", "tail", "less", "more", "grep", "rg", "find", "fd", "wc", "pwd", "echo", "which", "type", "file", "stat", "du", "df", "tree", "env", "printenv", "date", "whoami", "uname", "sort", "uniq", "cut", "tr", "diff", "jq", "basename", "dirname", "realpath", "readlink", "true", "test"]);
// git subcommands that only read: the first group takes any arguments, the rest only the listed flags.
const GIT_READ_ONLY = /^git\s+((status|log|diff|show|rev-parse|ls-files|blame|describe|shortlog)(\s|$)|remote(\s+-v)?\s*$|branch(\s+(-a|-v|-vv|--list|--show-current))*\s*$)/;

export function benignCommand(command: string): boolean {
	const text = command.trim();
	if (!text || /[><`]|\$\(|\bsudo\b|\bxargs\b|\bexec\b|--output/.test(text)) return false;
	const segments = text.split(/&&|\|\||[|;\n]/).map((s) => s.trim());
	return segments.every((seg) => {
		if (!seg) return false;
		if (GIT_READ_ONLY.test(seg)) return true;
		const word = seg.split(/\s+/)[0];
		if (word === "sed" && /\s-i\b/.test(seg)) return false; // in-place edit
		if (word === "awk" && /\bsystem\s*\(/.test(seg)) return false;
		if (word === "find" && /\s-(delete|exec|ok|execdir)\b/.test(seg)) return false;
		return READ_ONLY.has(word);
	});
}
