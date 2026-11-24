export interface JumpState {
	at: number | null;
	jumped: number | null;
	sessionId: string;
	jumpedSession: string | null;
	messages: number;
}

// The ordinal to scroll to now, or null: nothing asked, messages not loaded yet, or already jumped there.
export function nextJump(s: JumpState): number | null {
	if (s.at === null || s.messages === 0) return null;
	if (s.at === s.jumped && s.sessionId === s.jumpedSession) return null;
	return s.at;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Drops markdown syntax so source text (search snippets) and rendered text (DOM) compare equal, then normalizes.
function plain(src: string): string {
	return collapse(
		src
			.replace(/\[file: [^\]]*\]|\[image\]/g, " ") // attachment markers the search index appends to user text
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
			.replace(/https?:\/\/\S+/g, " ")
			.replace(/^\s*(?:`{3,}|~{3,}).*$/gm, " ") // fence lines
			.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "") // heading, quote, list markers
			.replace(/[`|]/g, " ")
			.replace(/\*+|__+/g, "")
			.replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1"),
	);
}

// The longest run of plain words (>= 20 chars) in a search snippet, else the whole normalized snippet.
export function snippetCore(snippet: string): string {
	const s = plain(snippet.replace(/^[\s…]+|[\s…]+$/g, ""));
	let best = "";
	for (const run of s.split(/[^\p{L}\p{N} ]+/u)) {
		const r = run.trim();
		if (r.length > best.length) best = r;
	}
	return best.length >= 20 ? best : s;
}

export function matchesSnippet(text: string, snippet: string): boolean {
	const core = snippetCore(snippet);
	return core === "" || plain(text).includes(core);
}

// A link without a stored snippet has only its ordinal; in a compacted live session the ordinals are off, so it must not scroll.
export function shouldJumpByOrdinal(hasSnippet: boolean, compacted: boolean): boolean {
	return hasSnippet || !compacted;
}
