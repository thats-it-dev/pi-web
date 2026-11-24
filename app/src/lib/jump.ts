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

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// The middle ~60 characters of a search snippet, normalized, for matching against a rendered message.
export function snippetCore(snippet: string): string {
	const s = norm(snippet.replace(/^[\s…]+|[\s…]+$/g, ""));
	if (s.length <= 60) return s;
	const start = Math.floor((s.length - 60) / 2);
	return s.slice(start, start + 60);
}

export function matchesSnippet(text: string, snippet: string): boolean {
	const core = snippetCore(snippet);
	return core === "" || norm(text).includes(core);
}
