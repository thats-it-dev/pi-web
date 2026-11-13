// The attachments block the hub appends to a prompt that carried files. pi reads
// it as text; the app parses it back into chips, and every one-line view of a
// user message (titles, the watch, queue chips) shows the summary instead.
//
//   <the user's text>
//
//   <pi-web-attachments>
//   - report.pdf (1.2 MB) → /abs/uploads/s1/report.pdf
//   - notes.md (3.1 KB) → /abs/uploads/s1/notes.md, contents inlined below
//   </pi-web-attachments>
//
//   <pi-web-file path="/abs/uploads/s1/notes.md">
//   …file text…
//   </pi-web-file>

export interface SavedAttachment {
	name: string;
	size: number; // raw bytes
	path: string; // absolute, where the hub saved it
	inline: string | null; // the file's text when it is small UTF-8 text
}

export interface AttachmentChip {
	name: string;
	sizeLabel: string; // as written in the block, e.g. "3.1 KB"
	path: string;
	inlined: boolean;
}

export const FILES_ONLY_TEXT = "Attached:";
const OPEN = "<pi-web-attachments>";
const CLOSE = "</pi-web-attachments>";
const INLINED_NOTE = ", contents inlined below";
const LINE = /^- (.+) \((\d+(?:\.\d)? [KM]?B)\) → (.+?)(, contents inlined below)?$/;

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAttachments(text: string, files: SavedAttachment[]): string {
	const lines = files.map((f) => `- ${f.name} (${formatBytes(f.size)}) → ${f.path}${f.inline === null ? "" : INLINED_NOTE}`);
	const parts = [text.trim() || FILES_ONLY_TEXT, [OPEN, ...lines, CLOSE].join("\n")];
	for (const f of files) if (f.inline !== null) parts.push(`<pi-web-file path="${f.path}">\n${f.inline.replace(/\n$/, "")}\n</pi-web-file>`);
	return parts.join("\n\n");
}

export function parseAttachments(text: string): { text: string; files: AttachmentChip[] } | null {
	const at = text.startsWith(OPEN) ? -1 : text.indexOf(`\n${OPEN}`);
	if (at === -1 && !text.startsWith(OPEN)) return null;
	const start = at + 1;
	const bodyStart = start + OPEN.length;
	const end = text.indexOf(`\n${CLOSE}`, bodyStart);
	if (end < 0) return null;
	const files: AttachmentChip[] = [];
	for (const line of text.slice(bodyStart, end).split("\n").filter(Boolean)) {
		const m = LINE.exec(line);
		if (!m) return null;
		files.push({ name: m[1], sizeLabel: m[2], path: m[3], inlined: Boolean(m[4]) });
	}
	return { text: text.slice(0, start).trim(), files };
}

// "the user's text · 2 files"; a files-only message is named by its first file.
export function summarizeAttachments(text: string): string {
	const p = parseAttachments(text);
	if (!p) return text;
	const n = p.files.length;
	const count = `${n} file${n === 1 ? "" : "s"}`;
	if (p.text && p.text !== FILES_ONLY_TEXT) return `${p.text} · ${count}`;
	const first = p.files[0]?.name ?? count;
	return n > 1 ? `${first} · ${count}` : first;
}
