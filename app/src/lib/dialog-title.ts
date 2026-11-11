// Extension dialogs only carry a title string, so some pack a whole question into it:
// rpiv-ask-user-question sends "[Header] question\n\n1. label — description\n…\n\ninstructions"
// for multi-select. Split that into a one-line heading, a wrapped body and tappable choices.

export type DialogChoice = { n: number; label: string; description: string };
export type DialogTitle = { heading: string; body: string; choices: DialogChoice[] };

const CHOICE = /^(\d+)\.\s+(.+?)(?:\s+—\s+(.*))?$/;

export function parseDialogTitle(title: string): DialogTitle {
	const [first = "", ...rest] = title.split("\n");
	const lines = rest;
	const start = lines.findIndex((l) => CHOICE.exec(l.trim())?.[1] === "1");
	const choices: DialogChoice[] = [];
	let end = start;
	if (start >= 0) {
		for (; end < lines.length; end++) {
			const m = CHOICE.exec(lines[end].trim());
			if (!m || Number(m[1]) !== choices.length + 1) break;
			choices.push({ n: choices.length + 1, label: m[2], description: m[3] ?? "" });
		}
	}
	// A single "1." line is just prose, not a list to pick from.
	const isList = choices.length >= 2;
	const bodyLines = isList ? [...lines.slice(0, start), ...lines.slice(end)] : lines;
	const body = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return { heading: first.trim(), body, choices: isList ? choices : [] };
}

// What an input dialog with choices submits: typed text wins (a custom answer), else "1,3".
export function choicesAnswer(picked: number[], typed: string): string {
	const text = typed.trim();
	if (text) return text;
	return [...picked].sort((a, b) => a - b).join(",");
}
