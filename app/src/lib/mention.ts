// @ file mentions in the composer, matching pi's TUI: `@path` anywhere in the
// message, or `@"path with spaces"`. Only the path text goes to pi.

export interface Mention {
	start: number; // index of the @
	end: number; // end of the whole token, past the cursor
	query: string; // what's typed between the @ (and quote) and the cursor
}

export interface MentionEntry {
	path: string;
	dir: boolean;
}

export function mentionAt(text: string, cursor: number): Mention | null {
	const before = text.slice(0, cursor);
	const quoted = before.match(/(?:^|\s)@"([^"\n]*)$/);
	if (quoted) {
		const start = cursor - quoted[1].length - 2;
		const close = text.slice(cursor).match(/^[^"\n]*"/);
		return { start, end: close ? cursor + close[0].length : cursor, query: quoted[1] };
	}
	const plain = before.match(/(?:^|\s)@([^\s"]*)$/);
	if (!plain) return null;
	const rest = text.slice(cursor).match(/^\S*/)![0];
	return { start: cursor - plain[1].length - 1, end: cursor + rest.length, query: plain[1] };
}

export function applyMention(text: string, m: Mention, e: MentionEntry): { text: string; cursor: number } {
	const value = e.dir ? `${e.path}/` : e.path;
	const quote = /\s/.test(value);
	const token = quote ? `@"${value}"` : `@${value}`;
	const tail = text.slice(m.end);
	// A folder leaves the cursor inside the token so the menu can drill in.
	if (e.dir) return { text: text.slice(0, m.start) + token + tail, cursor: m.start + token.length - (quote ? 1 : 0) };
	const space = /^\s/.test(tail) ? "" : " ";
	const head = text.slice(0, m.start) + token;
	return { text: head + space + tail, cursor: head.length + (space ? 1 : 0) };
}
