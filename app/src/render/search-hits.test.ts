import { nothing } from "lit";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../../shared/src/protocol.ts";
import { highlight, searchHits, searchHitsStyles } from "./search-hits.ts";

function flatten(v: unknown): string {
	if (v === nothing || v == null || v === false) return "";
	if (Array.isArray(v)) return v.map(flatten).join("");
	if (typeof v === "function") return "fn";
	if (typeof v === "object" && "strings" in (v as object)) {
		const t = v as { strings: string[]; values: unknown[] };
		return t.strings.map((s, i) => s + (i < t.values.length ? flatten(t.values[i]) : "")).join("");
	}
	return String(v);
}
const hit = (o: Partial<SearchHit> = {}): SearchHit => ({
	sessionId: "a b", type: "code", name: "Fix it", firstPrompt: null, cwd: "/home/m/x", updatedAt: Date.now(),
	ordinal: 3, role: "user", snippet: "We restarted it", terms: ["restart"], semanticOnly: false, ...o,
});
const done = (hits: SearchHit[]) => ({ status: "done" as const, query: "q", hits, semantic: false });

describe("highlight", () => {
	it("marks a term once, case-insensitively", () => {
		const h = flatten(highlight("We restarted it", ["restart"]));
		expect(h.match(/<mark>/g)).toHaveLength(1);
		expect(h).toContain("<mark>restart</mark>ed it");
		expect(flatten(highlight("We Restarted", ["restart"]))).toContain("<mark>Restart</mark>");
	});
	it("keeps markup as text and prefers the longest term without overlap", () => {
		const t = highlight("<b>restart</b>", ["rest", "restart"]);
		const h = flatten(t);
		expect(h.match(/<mark>/g)).toHaveLength(1);
		expect(h).toContain("<mark>restart</mark>");
		// segments are interpolated values (escaped by lit), not template source
		expect(t.strings.join("")).not.toContain("<b>");
	});
	it("returns plain text when there are no terms", () => {
		expect(flatten(highlight("hello", []))).not.toContain("<mark>");
	});
});

describe("searchHits", () => {
	it("renders nothing when idle", () => {
		expect(searchHits({ status: "idle" }, "/home/m")).toBe(nothing);
	});
	it("renders label, rows, type icons, links and footers", () => {
		const h = flatten(searchHits(done([hit(), hit({ type: "chat", role: "assistant", semanticOnly: true, sessionId: "c", ordinal: 0 })]), "/home/m"));
		expect(h).toContain("In conversations");
		expect(h).toContain("#/s/a%20b/at/3");
		expect(h).toContain("#/s/c/at/0");
		expect(h.match(/viewBox/g)).toHaveLength(2);
		expect(h).toContain("you · ~/x");
		expect(h).toContain("topic match");
		expect(h).toContain("Fix it");
		expect(h).toContain("<mark>restart</mark>");
	});
	it("shows pi footer for assistant hits", () => {
		expect(flatten(searchHits(done([hit({ role: "assistant" })]), "/home/m"))).toContain("pi · ~/x");
	});
	it("renders the status lines", () => {
		expect(flatten(searchHits({ status: "searching", query: "q" }, "/h"))).toMatch(/pulse[\s\S]*searching…/);
		expect(flatten(searchHits(done([]), "/h"))).toContain("Nothing in conversations.");
		expect(flatten(searchHits({ status: "error", query: "q", message: "Search failed." }, "/h"))).toContain("Search failed.");
	});
	it("styles carry the spec values", () => {
		const c = searchHitsStyles.cssText;
		expect(c).toContain("-webkit-line-clamp: 2");
		expect(c).toContain("grid-template-columns: 10px minmax(0, 1fr) auto");
		expect(c).toContain("prefers-reduced-motion");
		expect(c).toContain("text-decoration-thickness: 2px");
	});
});
