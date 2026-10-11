import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../../shared/src/protocol.ts";
import { BUILTINS, filterSlash, matchModel, parseInput, slashItems, slashQuery } from "./slash.ts";

const model = (provider: string, id: string, name: string): ModelInfo => ({ provider, id, name, reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 32768 });

describe("slash commands", () => {
	it("detects a command being typed", () => {
		expect(slashQuery("/")).toBe("");
		expect(slashQuery("/co")).toBe("co");
		expect(slashQuery("/compact now")).toBe(null);
		expect(slashQuery("hello /co")).toBe(null);
	});
	it("merges pi commands after built-ins, without duplicates", () => {
		const items = slashItems([
			{ name: "council", description: "prompt template", source: "prompt" },
			{ name: "model", description: "shadowed", source: "extension" },
		]);
		expect(items.slice(0, BUILTINS.length)).toEqual(BUILTINS);
		expect(items.filter((i) => i.name === "model")).toHaveLength(1);
		expect(items.at(-1)).toMatchObject({ name: "council", kind: "prompt" });
	});
	it("ranks prefix, then substring, then subsequence matches", () => {
		const items = slashItems([
			{ name: "context", source: "extension" },
			{ name: "council", source: "prompt" },
			{ name: "skill:ctx-stats", source: "skill" },
		]);
		expect(filterSlash(items, "co").map((i) => i.name)).toEqual(["copy", "compact", "context", "council", "clone"]);
		expect(filterSlash(items, "ctxst").map((i) => i.name)).toEqual(["skill:ctx-stats"]);
		expect(filterSlash(items, "").slice(0, 2).map((i) => i.name)).toEqual(["model", "thinking"]);
	});
	it("parses built-ins, shell commands and prompts", () => {
		expect(parseInput("/compact keep the API notes")).toEqual({ kind: "builtin", name: "compact", args: "keep the API notes" });
		expect(parseInput("/model")).toEqual({ kind: "builtin", name: "model", args: "" });
		expect(parseInput("!ls -la")).toEqual({ kind: "bash", command: "ls -la", excludeFromContext: false });
		expect(parseInput("!!git status")).toEqual({ kind: "bash", command: "git status", excludeFromContext: true });
		expect(parseInput("/council review this")).toEqual({ kind: "prompt", text: "/council review this" });
		expect(parseInput("!")).toEqual({ kind: "prompt", text: "!" });
		expect(parseInput("hello")).toEqual({ kind: "prompt", text: "hello" });
	});
	it("matches models by id, provider/id, or a unique fragment", () => {
		const models = [model("spark", "qwen3.8-27b", "Qwen3.8 27B (coding)"), model("spark", "qwen3.6-35b-a3b-sglang", "Qwen3.6 35B-A3B (fast)"), model("spark", "qwen3.8-flash-next", "Qwen3.8 Flash-Next (max)")];
		expect(matchModel(models, "qwen3.8-27b")?.id).toBe("qwen3.8-27b");
		expect(matchModel(models, "spark/qwen3.8-flash-next")?.id).toBe("qwen3.8-flash-next");
		expect(matchModel(models, "fast")?.id).toBe("qwen3.6-35b-a3b-sglang");
		expect(matchModel(models, "qwen3.8")).toBe(null);
		expect(matchModel(models, "gpt")).toBe(null);
	});
});
