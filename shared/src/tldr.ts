// Agent-written TL;DR line: the last non-empty line of a reply, which must be outside code fences,
// shaped `TL;DR [title]: summary` (case-insensitive, optional ** around TL;DR or around the colon).
export type Tldr = { title: string | null; summary: string };

const TLDR_LINE = /^(?:\*\*)?tl;dr(?:\*\*)?\s*(?:\[([^\]]*)\])?\s*(?:\*\*)?:(?:\*\*)?\s*(.*)$/i;

// Index of the last non-empty line of the text when that line is prose outside a code fence, or -1.
// A fence line (opening or closing) or a line inside an unclosed fence as the last line means -1.
const lastProseLine = (lines: string[]): number => {
	let inFence = false;
	let last = -1;
	let lastIsProse = false;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			if (trimmed !== "") { last = i; lastIsProse = false; }
			continue;
		}
		if (trimmed !== "") { last = i; lastIsProse = !inFence; }
	}
	return lastIsProse ? last : -1;
};

export function parseTldr(text: string): Tldr | null {
	const lines = text.split("\n");
	const i = lastProseLine(lines);
	if (i < 0) return null;
	const match = TLDR_LINE.exec(lines[i].trim());
	if (!match) return null;
	const summary = match[2].trim();
	if (summary === "") return null;
	const title = match[1]?.trim() || null;
	return { title, summary };
}

export function stripTldr(text: string): string {
	if (parseTldr(text) === null) return text;
	const lines = text.split("\n");
	return lines.slice(0, lastProseLine(lines)).join("\n").trimEnd();
}
