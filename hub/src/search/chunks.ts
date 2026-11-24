// Turns a pi session file into search chunks: the visible text of user/assistant messages on the
// active branch, each tagged with the message's ordinal (its index among user/assistant messages
// in historyFromText), split on paragraph boundaries into pieces of at most MAX_CHUNK characters.

import type { AgentMessage } from "../../../shared/src/protocol.ts";
import { FILES_ONLY_TEXT, parseAttachments } from "../../../shared/src/attachments.ts";
import { branchEntries } from "../../../shared/src/session-file.ts";
import { stripTldr } from "../../../shared/src/tldr.ts";

export const MAX_CHUNK = 1200;

export interface Chunk {
	ordinal: number;
	piece: number;
	role: "user" | "assistant";
	ts: number;
	text: string;
}
export interface ChunkedSession {
	sessionId: string;
	cwd: string;
	chunks: Chunk[];
}

function userBlockText(text: string): string {
	const p = parseAttachments(text);
	if (!p) return text;
	const typed = p.text === FILES_ONLY_TEXT ? "" : p.text;
	return [typed, ...p.files.map((f) => `[file: ${f.name}]`)].filter(Boolean).join(" ");
}

export function messageText(m: AgentMessage): string {
	const role = (m as { role?: string }).role;
	const content = (m as { content?: unknown }).content;
	const blocks: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	const parts: string[] = [];
	for (const b of blocks as { type?: string; text?: unknown }[]) {
		if (!b || typeof b !== "object") continue;
		if (b.type === "text" && typeof b.text === "string") parts.push(role === "user" ? userBlockText(b.text) : b.text);
		else if (b.type === "image" && role === "user") parts.push("[image]");
	}
	const joined = parts.filter((p) => p !== "").join("\n");
	return (role === "assistant" ? stripTldr(joined) : joined).trim();
}

export function splitText(text: string, max = MAX_CHUNK): string[] {
	const out: string[] = [];
	let cur = "";
	const flush = () => {
		if (cur) out.push(cur);
		cur = "";
	};
	for (const para of text.split("\n\n")) {
		if (para === "") continue;
		if (para.length > max) {
			flush();
			let rest = para;
			while (rest.length > max) {
				let cut = rest.lastIndexOf(" ", max);
				if (cut <= 0) cut = max;
				const head = rest.slice(0, cut);
				if (head.trim()) out.push(head);
				rest = rest.slice(cut).replace(/^ /, "");
			}
			cur = rest;
			continue;
		}
		if (cur && cur.length + 2 + para.length > max) flush();
		cur = cur ? `${cur}\n\n${para}` : para;
	}
	flush();
	return out;
}

export function chunkSession(text: string): ChunkedSession | null {
	const first = text.split("\n", 1)[0];
	let header: Record<string, any> | null = null;
	try {
		header = JSON.parse(first);
	} catch {}
	if (!header || header.type !== "session" || typeof header.id !== "string") return null;
	const chunks: Chunk[] = [];
	let ordinal = 0;
	for (const e of branchEntries(text)) {
		if (e.type !== "message") continue;
		const m = e.message;
		if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant")) continue;
		const ts = Date.parse(e.timestamp) || (typeof m.timestamp === "number" ? m.timestamp : 0);
		splitText(messageText(m)).forEach((t, piece) => chunks.push({ ordinal, piece, role: m.role, ts, text: t }));
		ordinal++;
	}
	return { sessionId: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "", chunks };
}
