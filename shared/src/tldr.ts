// Agent-written TL;DR line: the last non-empty line of a reply, outside code fences,
// shaped `TL;DR [title]: summary` (case-insensitive, optional ** around TL;DR).
export type Tldr = { title: string | null; summary: string };

const TLDR_LINE = /^(?:\*\*)?tl;dr(?:\*\*)?\s*(?:\[([^\]]*)\])?\s*:\s*(.*)$/i;

// Index of the last non-empty line that is not inside a code fence, or -1.
const lastProseLine = (lines: string[]): number => {
	let inFence = false;
	let last = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && lines[i].trim() !== "") last = i;
	}
	return last;
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
