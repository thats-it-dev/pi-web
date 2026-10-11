import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/src/protocol.ts";
import { OUTPUT_LIMIT, abbreviateCwd, blocksText, formatCost, formatTokens, groupSessions, parseArgsRaw, relativeTime, sessionTitle, summarizeToolArgs, truncateOutput, wordCount } from "./format.ts";

const s = (over: Partial<SessionSummary>): SessionSummary => ({
	id: "x", cwd: "/home/m", name: null, firstPrompt: null, userMessages: 1, model: null, contextTokens: null,
	createdAt: 0, updatedAt: 0, parentSession: null, live: false, handleKind: null, state: "idle", ...over,
});

describe("format", () => {
	it("formats token counts like the TUI footer", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1000)).toBe("1k");
		expect(formatTokens(62_100)).toBe("62.1k");
		expect(formatTokens(262_144)).toBe("262k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
		expect(formatTokens(null)).toBe("—");
	});
	it("formats cost only when non-zero", () => {
		expect(formatCost(0)).toBe("");
		expect(formatCost(0.004)).toBe("<$0.01");
		expect(formatCost(0.45)).toBe("$0.45");
	});
	it("formats relative time compactly", () => {
		const now = 1_000_000_000;
		expect(relativeTime(now - 10_000, now)).toBe("now");
		expect(relativeTime(now - 2 * 60_000, now)).toBe("2m");
		expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
		expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5d");
	});
	it("abbreviates home", () => {
		expect(abbreviateCwd("/home/michael/workspace/website", "/home/michael")).toBe("~/workspace/website");
		expect(abbreviateCwd("/home/michael", "/home/michael")).toBe("~");
		expect(abbreviateCwd("/home/michaelx", "/home/michael")).toBe("/home/michaelx");
	});
	it("titles sessions by name, then first prompt line", () => {
		expect(sessionTitle({ name: "katsu", firstPrompt: "How do I…" })).toBe("katsu");
		expect(sessionTitle({ name: null, firstPrompt: "line one\nline two" })).toBe("line one");
		expect(sessionTitle({ name: null, firstPrompt: null })).toBe("new session");
	});
	it("groups by folder in recency order and filters by query", () => {
		const list = [s({ id: "a", cwd: "/home/m/site", name: "portfolio" }), s({ id: "b", cwd: "/home/m" , firstPrompt: "katsu" }), s({ id: "c", cwd: "/home/m/site", firstPrompt: "nav" })];
		const groups = groupSessions(list, "", "/home/m");
		expect(groups.map((g) => g.label)).toEqual(["~/site", "~"]);
		expect(groups[0].sessions.map((x) => x.id)).toEqual(["a", "c"]);
		expect(groupSessions(list, "KATSU", "/home/m").flatMap((g) => g.sessions.map((x) => x.id))).toEqual(["b"]);
	});
	it("summarizes tool arguments on one line", () => {
		expect(summarizeToolArgs("bash", { command: "curl -sL\n  thatsit.dev" })).toBe("curl -sL thatsit.dev");
		expect(summarizeToolArgs("read", { path: "src/index.md" })).toBe("src/index.md");
		expect(summarizeToolArgs("custom", { a: 1 })).toBe('{"a":1}');
		expect(summarizeToolArgs("bash", { command: "x".repeat(300) }).length).toBe(120);
	});
	it("pulls a readable argument out of partial streaming JSON", () => {
		expect(parseArgsRaw('{"command":"ls -la')).toEqual({ command: "ls -la" });
		expect(parseArgsRaw('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
		expect(parseArgsRaw(undefined)).toEqual({});
	});
	it("truncates huge tool output with a note", () => {
		const big = "y".repeat(5_000_000);
		const out = truncateOutput(big);
		expect(out.length).toBeLessThan(OUTPUT_LIMIT + 100);
		expect(out).toMatch(/… 4980000 more characters$/);
		expect(truncateOutput("short")).toBe("short");
	});
	it("counts words and extracts text blocks", () => {
		expect(wordCount("  a b\nc ")).toBe(3);
		expect(wordCount("")).toBe(0);
		expect(blocksText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
		expect(blocksText(undefined)).toBe("");
		expect(blocksText("hi")).toBe("hi");
		expect(blocksText([null, { type: "text", text: "a" }])).toBe("a");
	});
});
