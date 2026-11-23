import { describe, expect, it } from "vitest";
import { POLL_MAX_MS, POLL_MS, nextPollDelay, nextSize, previewMode, readTab, shouldReload, stageFor } from "./preview-ui";

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

describe("shouldReload", () => {
	const p = (url: string, id: string) => ({ url, id });
	it("same url, same id: no (the call landing in the messages)", () => expect(shouldReload(p("http://a/", "tc1"), p("http://a/", "tc1"))).toBe(false));
	it("same url, new id: yes (pi restarted it)", () => expect(shouldReload(p("http://a/", "tc1"), p("http://a/", "tc2"))).toBe(true));
	it("new url: no (the src changes anyway)", () => expect(shouldReload(p("http://a/", "tc1"), p("http://b/", "tc2"))).toBe(false));
	it("null on either side: no", () => {
		expect(shouldReload(null, p("http://a/", "tc1"))).toBe(false);
		expect(shouldReload(undefined, p("http://a/", "tc1"))).toBe(false);
		expect(shouldReload(p("http://a/", "tc1"), null)).toBe(false);
	});
});

describe("nextPollDelay", () => {
	it("an answer resets to 15 s", () => expect(nextPollDelay(60_000, true)).toBe(POLL_MS));
	it("failures double it up to 60 s", () => {
		const seq: number[] = [];
		let d = POLL_MS;
		for (let i = 0; i < 4; i++) seq.push((d = nextPollDelay(d, false)));
		expect(seq).toEqual([30_000, 60_000, POLL_MAX_MS, POLL_MAX_MS]);
	});
});
