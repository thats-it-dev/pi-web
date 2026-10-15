import { describe, expect, it } from "vitest";
import { applyMention, mentionAt } from "./mention.ts";

const at = (s: string) => {
	const cursor = s.indexOf("|");
	return { text: s.replace("|", ""), cursor };
};
const find = (s: string) => {
	const { text, cursor } = at(s);
	return mentionAt(text, cursor);
};
const pick = (s: string, path: string, dir = false) => {
	const { text, cursor } = at(s);
	const m = mentionAt(text, cursor);
	if (!m) throw new Error("no mention");
	const r = applyMention(text, m, { path, dir });
	return r.text.slice(0, r.cursor) + "|" + r.text.slice(r.cursor);
};

describe("@ mentions", () => {
	it("finds the token being typed, anywhere in the text", () => {
		expect(find("@|")).toEqual({ start: 0, end: 1, query: "" });
		expect(find("look at @src/li|")).toEqual({ start: 8, end: 15, query: "src/li" });
		expect(find("line one\n@ab| and more")).toEqual({ start: 9, end: 12, query: "ab" });
		expect(find("@ab|cd tail")).toEqual({ start: 0, end: 5, query: "ab" });
	});
	it("ignores @ inside a word, and tokens the cursor has left", () => {
		expect(find("me@example.com|")).toBe(null);
		expect(find("@src done|")).toBe(null);
		expect(find("no mention|")).toBe(null);
	});
	it("reads an open quoted token", () => {
		expect(find('see @"my fo|')).toEqual({ start: 4, end: 11, query: "my fo" });
		expect(find('@"my dir/|"')).toEqual({ start: 0, end: 10, query: "my dir/" });
		expect(find('@"done" |')).toBe(null);
	});
	it("inserts a file with a trailing space", () => {
		expect(pick("look at @mn|", "src/mention.ts")).toBe("look at @src/mention.ts |");
		expect(pick("@mn| please", "src/mention.ts")).toBe("@src/mention.ts| please");
		expect(pick("@mn|x please", "a.ts")).toBe("@a.ts| please");
	});
	it("inserts a folder and leaves the cursor inside so you can keep going", () => {
		expect(pick("@sr|", "src", true)).toBe("@src/|");
	});
	it("quotes paths with spaces", () => {
		expect(pick("@my|", "my file.txt")).toBe('@"my file.txt" |');
		expect(pick("@my|", "my dir", true)).toBe('@"my dir/|"');
		expect(pick('@"my dir/|"', "my dir/a b.txt")).toBe('@"my dir/a b.txt" |');
	});
});
