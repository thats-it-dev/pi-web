// Files attached to a prompt: saved under the hub's uploads dir, one folder per
// session, then described to pi in the prompt text (shared/src/attachments.ts).

import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { type SavedAttachment, formatAttachments } from "../../shared/src/attachments.ts";
import type { AppCommand, FileInput } from "../../shared/src/protocol.ts";
import { HttpError } from "./errors.ts";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_BYTES = 32 * 1024;
const NUL_SCAN = 8 * 1024;
const CLOSING_TAG = "</pi-web-file>";

export type PromptCommand = Extract<AppCommand, { type: "prompt" }>;

// The basename only, without control characters; never empty.
export function safeName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	return base.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "file";
}

// Small UTF-8 text with no NUL byte and nothing that would end its inline block early.
export function isInlineText(bytes: Buffer): boolean {
	if (bytes.length > MAX_INLINE_BYTES) return false;
	if (bytes.subarray(0, NUL_SCAN).includes(0)) return false;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return false;
	}
	return !text.includes(CLOSING_TAG);
}

export async function saveAttachments(dir: string, files: FileInput[]): Promise<SavedAttachment[]> {
	const decoded = files.map((f) => ({ name: safeName(f.name), bytes: Buffer.from(f.data, "base64") }));
	for (const f of decoded) if (f.bytes.length > MAX_FILE_BYTES) throw new HttpError(413, `${f.name} is over 20 MB`);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const saved: SavedAttachment[] = [];
	for (const f of decoded) {
		const { name, path } = await writeFresh(dir, f.name, f.bytes);
		saved.push({ name, size: f.bytes.length, path, inline: isInlineText(f.bytes) ? f.bytes.toString("utf8") : null });
	}
	return saved;
}

// Writes under name, or "name (2).ext", "name (3).ext"… when that file exists.
async function writeFresh(dir: string, name: string, bytes: Buffer): Promise<{ name: string; path: string }> {
	const ext = extname(name);
	const stem = name.slice(0, name.length - ext.length);
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
		const path = join(dir, candidate);
		try {
			await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
			return { name: candidate, path };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}
}

// The same prompt with its files saved under dir and described in the text.
export async function withAttachments(cmd: PromptCommand, dir: string): Promise<PromptCommand> {
	if (!cmd.files?.length) return cmd;
	const { files, ...rest } = cmd;
	return { ...rest, text: formatAttachments(cmd.text, await saveAttachments(dir, files)) };
}
