// Maps a spoken transcript onto one of a dialog's options. Pure, no I/O.

import { findAllow, findDeny } from "./auto-approve.ts";

export type Match = { kind: "match"; option: string } | { kind: "none" } | { kind: "ambiguous"; options: string[] };

const YES = new Set(["yes", "yeah", "yep", "ok", "okay", "sure", "go ahead", "do it", "allow", "approve"]);
const NO = new Set(["no", "nope", "don't", "stop", "deny", "cancel"]);

export function yesNo(text: string): "yes" | "no" | null {
	const t = text.trim().toLowerCase();
	return YES.has(t) ? "yes" : NO.has(t) ? "no" : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pick(hits: string[]): Match | null {
	if (hits.length === 1) return { kind: "match", option: hits[0] };
	if (hits.length > 1) return { kind: "ambiguous", options: hits };
	return null;
}

export function matchOption(text: string, options: string[]): Match {
	const t = text.trim().toLowerCase();
	if (!t) return { kind: "none" };
	const lower = options.map((o) => o.trim().toLowerCase());
	const hits = (test: (o: string) => boolean) => options.filter((_, i) => test(lower[i]));
	const word = escape(t);
	const wholeWordStart = new RegExp(`^${word}(?:\\W|$)`);
	const wholeWord = new RegExp(`(?:^|\\W)${word}(?:\\W|$)`);
	const found = pick(hits((o) => o === t)) ?? pick(hits((o) => wholeWordStart.test(o))) ?? pick(hits((o) => wholeWord.test(o)));
	if (found) return found;
	const yn = yesNo(t);
	const mapped = yn === "yes" ? findAllow(options) : yn === "no" ? findDeny(options) : undefined;
	return mapped === undefined ? { kind: "none" } : { kind: "match", option: mapped };
}
