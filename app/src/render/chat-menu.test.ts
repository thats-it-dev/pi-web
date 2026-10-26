import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../../shared/src/protocol.ts";
import { menuRows, thinkingLevelsFor } from "./chat-menu.ts";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
	id: "flash",
	name: "flash",
	provider: "local",
	contextWindow: 262_144,
	maxTokens: 32_768,
	input: ["text"],
	reasoning: false,
	...over,
});

const view = { step: "root" as const, canImages: true, cwd: "~", cwdFixed: false, model: "flash · medium", approval: "semi" as const, recentCwds: [] };

describe("thinkingLevelsFor", () => {
	it("hides levels for a non-reasoning model", () => {
		expect(thinkingLevelsFor(model(), [])).toEqual([]);
	});

	it("passes known levels through", () => {
		expect(thinkingLevelsFor(model({ reasoning: true }), ["off", "low", "high"])).toEqual(["off", "low", "high"]);
	});
});

describe("chatMenu rows", () => {
	it("omits attach image when the model takes no images", () => {
		expect(menuRows({ ...view, canImages: false }).map((r) => r.label)).not.toContain("attach image");
		expect(menuRows(view).map((r) => r.label)).toEqual(["attach image", "folder", "model", "approvals"]);
	});

	it("a fixed folder row is not clickable and says fixed once a chat starts", () => {
		const folder = menuRows({ ...view, cwd: "~/src/pi-web", cwdFixed: true }).find((r) => r.key === "folder");
		expect(folder).toMatchObject({ value: "~/src/pi-web", disabled: true, hint: "fixed once a chat starts" });
		expect(menuRows(view).find((r) => r.key === "folder")?.disabled).toBe(false);
	});

	it("shows the model and approval values", () => {
		const rows = menuRows(view);
		expect(rows.find((r) => r.key === "model")?.value).toBe("flash · medium");
		expect(rows.find((r) => r.key === "approvals")?.value).toBe("semi");
	});
});
