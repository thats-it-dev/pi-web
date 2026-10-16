// Maps a spoken transcript onto one of a dialog's options. Pure, no I/O.

import { findAllow, findDeny } from "./auto-approve.ts";

export type Match = { kind: "match"; option: string } | { kind: "none" } | { kind: "ambiguous"; options: string[] };

const YES = new Set(["yes", "yeah", "yep", "ok", "okay", "sure", "go ahead", "do it", "allow", "approve"]);
const NO = new Set(["no", "nope", "don't", "stop", "deny", "cancel"]);

// Dictation capitalises and punctuates, so compare lower-cased, edge-trimmed, single-spaced text.
const normalise = (s: string) => s.toLowerCase().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "").replace(/\s+/g, " ");
const normaliseOption = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function yesNo(text: string): "yes" | "no" | null {
	const t = normalise(text).replace(/ please$/, "");
	return YES.has(t) ? "yes" : NO.has(t) ? "no" : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pick(hits: string[]): Match | null {
	if (hits.length === 1) return { kind: "match", option: hits[0] };
	if (hits.length > 1) return { kind: "ambiguous", options: hits };
	return null;
}

export function matchOption(text: string, options: string[]): Match {
	const t = normalise(text);
	if (!t) return { kind: "none" };
	const lower = options.map(normaliseOption);
	const hits = (test: (o: string) => boolean) => options.filter((_, i) => test(lower[i]));
	const word = escape(t);
	const wholeWordStart = new RegExp(`^${word}(?:\\W|$)`);
	const wholeWord = new RegExp(`(?:^|\\W)${word}(?:\\W|$)`);
	const found = pick(hits((o) => o === t)) ?? pick(hits((o) => wholeWordStart.test(o))) ?? pick(hits((o) => wholeWord.test(o)));
	if (found) return found;
	const yn = yesNo(t);
	const trimmed = options.map((o) => o.trim());
	const mapped = yn === "yes" ? findAllow(trimmed) : yn === "no" ? findDeny(trimmed) : undefined;
	const i = mapped === undefined ? -1 : trimmed.indexOf(mapped);
	return i < 0 ? { kind: "none" } : { kind: "match", option: options[i] };
}
