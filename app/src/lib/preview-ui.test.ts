import { describe, expect, it } from "vitest";
import { nextSize, previewMode, readTab, stageFor } from "./preview-ui";

describe("preview-ui", () => {
	it("previewMode splits at 600 and 900", () =>
		expect([previewMode(440), previewMode(599), previewMode(600), previewMode(834), previewMode(899), previewMode(900)]).toEqual(["card", "card", "fullscreen", "fullscreen", "fullscreen", "panel"]));
	it("stageFor scales a wide preset down and never up", () => {
		expect(stageFor("fit", 500, 800)).toEqual({ width: 500, height: 800, scale: 1 });
		expect(stageFor("390", 500, 800)).toEqual({ width: 390, height: 800, scale: 1 });
		expect(stageFor("768", 500, 800)).toEqual({ width: 768, height: Math.round(800 / (500 / 768)), scale: 500 / 768 });
	});
	it("nextSize cycles", () => expect((["default", "half", "full"] as const).map(nextSize)).toEqual(["half", "full", "default"]));
	it("readTab", () => expect([readTab("preview"), readTab("progress"), readTab(null), readTab("x")]).toEqual(["preview", "progress", "progress", "progress"]));
});
