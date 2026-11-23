import { describe, expect, it } from "vitest";
import type { PreviewState } from "../../../shared/src/preview.ts";
import { type AsideInput, nextTab, shellAttrs, shownPreview, snapSize } from "./aside-state";

const dev = (at: number): PreviewState => ({ url: "https://spark.tail.ts.net:8443/", label: "fret", kind: "dev", at });
const pages = (at: number): PreviewState => ({ url: "https://pr-4.fret.pages.dev/", label: "PR #4", kind: "pages", at });
const input = (over: Partial<AsideInput>): AsideInput => ({ derived: null, pages: null, tab: "progress", hasProgress: true, width: 1400, lastSeenAt: 0, ...over });

describe("shownPreview", () => {
	it("a Pages link opened after the derived preview wins", () => expect(shownPreview({ derived: dev(100), pages: pages(200) })).toEqual(pages(200)));
	it("a derived preview newer than the Pages link wins", () => expect(shownPreview({ derived: dev(300), pages: pages(200) })).toEqual(dev(300)));
	it("either alone is shown; none is null", () => {
		expect(shownPreview({ derived: null, pages: pages(1) })).toEqual(pages(1));
		expect(shownPreview({ derived: dev(1), pages: null })).toEqual(dev(1));
		expect(shownPreview({ derived: null, pages: null })).toBeNull();
	});
});

describe("nextTab", () => {
	it("no preview: Progress, whatever was picked", () => expect(nextTab(input({ tab: "preview" }))).toBe("progress"));
	it("a derived preview newer than lastSeenAt flips to Preview", () => expect(nextTab(input({ derived: dev(500), lastSeenAt: 400 }))).toBe("preview"));
	it("once seen, the picked tab stays", () => {
		expect(nextTab(input({ derived: dev(500), lastSeenAt: 500, tab: "progress" }))).toBe("progress");
		expect(nextTab(input({ derived: dev(500), lastSeenAt: 500, tab: "preview" }))).toBe("preview");
	});
	it("Progress with nothing in it shows the preview", () => expect(nextTab(input({ derived: dev(500), lastSeenAt: 500, hasProgress: false }))).toBe("preview"));
	it("a Pages override keeps the Preview tab", () => expect(nextTab(input({ pages: pages(9), tab: "preview" }))).toBe("preview"));
});

describe("shellAttrs", () => {
	const base = { tab: "preview" as const, preview: dev(1), finePointer: true, size: "half" as const };
	it("panel mode docks the aside and sizes it", () =>
		expect(shellAttrs({ ...base, mode: "panel" })).toEqual({ resizable: true, dockAside: true, asideFullscreen: false, asideSize: "half" }));
	it("600-899 is a full-screen drawer, not docked, not resizable", () =>
		expect(shellAttrs({ ...base, mode: "fullscreen" })).toEqual({ resizable: false, dockAside: false, asideFullscreen: true, asideSize: "half" }));
	it("a phone is neither", () => expect(shellAttrs({ ...base, mode: "card" })).toEqual({ resizable: false, dockAside: false, asideFullscreen: false, asideSize: "half" }));
	it("resizable only with a fine pointer", () => expect(shellAttrs({ ...base, mode: "panel", finePointer: false }).resizable).toBe(false));
	it("the Progress tab keeps today's aside: default size, no forced dock", () =>
		expect(shellAttrs({ ...base, tab: "progress", mode: "panel" })).toEqual({ resizable: true, dockAside: false, asideFullscreen: false, asideSize: "default" }));
	it("no preview: no dock, no fullscreen", () => {
		expect(shellAttrs({ ...base, preview: null, mode: "panel" }).dockAside).toBe(false);
		expect(shellAttrs({ ...base, preview: null, mode: "fullscreen" }).asideFullscreen).toBe(false);
	});
});

describe("snapSize", () => {
	it("cycles narrow, half, full on a wide screen", () => expect((["default", "half", "full"] as const).map((s) => snapSize(s, 1400))).toEqual(["half", "full", "default"]));
	it("cycles half and full below 1200 (iPad)", () => expect((["default", "half", "full"] as const).map((s) => snapSize(s, 1100))).toEqual(["half", "full", "half"]));
});
