// Pure ranking helpers for session search: fusion, cosine top-k, query terms, snippets.

export function rrf(lists: { id: number }[][], k = 60): { id: number; score: number }[] {
	const scores = new Map<number, number>();
	for (const list of lists) list.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1)));
	// Map keeps insertion order and sort is stable, so ties stay in first-appearance order.
	return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0, na = 0, nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function cosineTopK(query: Float32Array, rows: { id: number; vec: Float32Array }[], k: number): { id: number; score: number }[] {
	return rows.map((r) => ({ id: r.id, score: cosine(query, r.vec) })).sort((a, b) => b.score - a.score).slice(0, Math.max(0, k));
}

export function queryWords(q: string): string[] {
	return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => [...w].length >= 2);
}

export function termsIn(text: string, words: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
		const low = m.toLowerCase();
		if (seen.has(low) || !words.some((w) => low.startsWith(w))) continue;
		seen.add(low);
		out.push(m);
	}
	return out;
}

export function snippet(text: string, words: string[], max = 220): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let at = -1;
	for (const m of flat.matchAll(/[\p{L}\p{N}]+/gu)) {
		const low = m[0].toLowerCase();
		if (words.some((w) => low.startsWith(w))) { at = m.index!; break; }
	}
	let start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 4));
	if (start > 0 && flat[start - 1] !== " ") {
		// snap forward to a word start (skip a partial word), never past the match
		const sp = flat.indexOf(" ", start);
		if (sp >= 0 && sp < at) start = sp + 1;
	}
	const lead = start > 0 ? 1 : 0;
	let end = Math.min(flat.length, start + max - lead - 1); // room for a trailing "…"
	if (end < flat.length && flat[end] !== " ") {
		const sp = flat.lastIndexOf(" ", end);
		if (sp > start && (at < 0 || sp > at)) end = sp;
	}
	const body = flat.slice(start, end).trimEnd();
	return (lead ? "…" : "") + body + (end < flat.length ? "…" : "");
}
