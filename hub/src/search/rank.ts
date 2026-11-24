// Pure ranking helpers for session search: fusion, cosine top-k, query terms, snippets.

import { cosine } from "./embedder.ts";

export function rrf(lists: { id: number }[][], k = 60): { id: number; score: number }[] {
	const scores = new Map<number, number>();
	for (const list of lists) list.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1)));
	// Map keeps insertion order and sort is stable, so ties stay in first-appearance order.
	return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
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

// FTS5 highlight() markers around a matched token (db.highlights).
const OPEN = "\x01";
const CLOSE = "\x02";

/** Markdown noise out, whitespace collapsed: code-fence markers (with their language tag), **, __ and backticks go; code text stays. */
function flatten(text: string): string {
	return text
		.replace(/```[^\s`\x01\x02]*/g, " ")
		.replace(/\*\*|__|`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function snippet(text: string, words: string[], max = 220): string {
	const flat = flatten(text);
	if (flat.length <= max) return flat;
	let at = -1;
	for (const m of flat.matchAll(/[\p{L}\p{N}]+/gu)) {
		const low = m[0].toLowerCase();
		if (words.some((w) => low.startsWith(w))) { at = m.index!; break; }
	}
	return windowAt(flat, at, max);
}

/** A snippet of highlighted text (db.highlights), windowed around the first marked token; markers stripped. */
export function markedSnippet(marked: string, max = 220): string {
	const flat = flatten(marked);
	const at = flat.indexOf(OPEN); // no marker precedes it, so it is also the index once markers are gone
	const plain = flat.replaceAll(OPEN, "").replaceAll(CLOSE, "");
	return plain.length <= max ? plain : windowAt(plain, at, max);
}

/** The marked tokens' surface forms, deduped case-insensitively, in text order. */
export function markedTerms(marked: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of marked.matchAll(/\x01([^\x01\x02]*)\x02/g)) {
		const low = m[1].toLowerCase();
		if (!m[1] || seen.has(low)) continue;
		seen.add(low);
		out.push(m[1]);
	}
	return out;
}

/** At most `max` characters of `flat` (longer than max) around index `at` (-1: from the start), on word boundaries, with ellipses. */
function windowAt(flat: string, at: number, max: number): string {
	let start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 4));
	// near the end, pull the start back so the snippet still uses the full max (1 goes to the leading "…")
	start = Math.max(0, Math.min(start, flat.length - max + 1));
	if (start > 0 && flat[start - 1] !== " ") {
		// snap forward to a word start (skip a partial word), never past the match
		const sp = flat.indexOf(" ", start);
		if (sp >= 0 && (at < 0 || sp < at)) start = sp + 1;
	}
	const room = max - (start > 0 ? 1 : 0);
	let end = flat.length - start <= room ? flat.length : start + room - 1; // room for a trailing "…"
	if (end < flat.length && flat[end] !== " ") {
		const sp = flat.lastIndexOf(" ", end);
		if (sp > start && (at < 0 || sp > at)) end = sp;
	}
	const body = flat.slice(start, end).trimEnd();
	return (start > 0 ? "…" : "") + body + (end < flat.length ? "…" : "");
}
