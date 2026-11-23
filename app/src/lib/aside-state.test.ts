import { describe, expect, it } from "vitest";
import type { PreviewState } from "../../../shared/src/preview.ts";
import { type AsideInput, FRESH_MS, isFreshArrival, nextTab, shellAttrs, shownPreview, snapSize } from "./aside-state";

const dev = (at: number, id = "tc1"): PreviewState => ({ id, url: "https://spark.tail.ts.net:8443/", label: "fret", kind: "dev", at });
const pages = (at: number): PreviewState => ({ id: "pages", url: "https://pr-4.fret.pages.dev/", label: "PR #4", kind: "pages", at });
const input = (over: Partial<AsideInput>): AsideInput => ({ derived: null, pages: null, tab: "progress", hasProgress: true, width: 1400, arrived: false, engaged: true, ...over });

describe("isFreshArrival", () => {
	const now = 10_000_000;
	it("an unseen preview under a minute old is fresh", () => expect(isFreshArrival(dev(now - 5_000), new Set(), now)).toBe(true));
	it("a live one (at 0, its message not landed yet) is fresh", () => expect(isFreshArrival(dev(0), new Set(), now)).toBe(true));
	it("one restored from history (older than a minute) is not", () => expect(isFreshArrival(dev(now - FRESH_MS - 1), new Set(), now)).toBe(false));
	it("a seen id is not, even when its message lands later", () => expect(isFreshArrival(dev(now, "tc1"), new Set(["tc1"]), now)).toBe(false));
	it("a restart on the same url is a new id: fresh again", () => expect(isFreshArrival(dev(0, "tc2"), new Set(["tc1"]), now)).toBe(true));
	it("none is not", () => expect(isFreshArrival(null, new Set(), now)).toBe(false));
});

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
	it("a fresh derived preview flips to Preview", () => expect(nextTab(input({ derived: dev(500), arrived: true }))).toBe("preview"));
	it("a restored (not fresh) one keeps the picked tab", () => {
		expect(nextTab(input({ derived: dev(500), tab: "progress" }))).toBe("progress");
		expect(nextTab(input({ derived: dev(500), tab: "preview" }))).toBe("preview");
	});
	it("Progress with nothing in it shows the preview", () => expect(nextTab(input({ derived: dev(500), hasProgress: false }))).toBe("preview"));
	it("a Pages override keeps the Preview tab", () => expect(nextTab(input({ pages: pages(9), tab: "preview" }))).toBe("preview"));
	it("not engaged (a reopened chat): Progress when it has content, whatever tab was last picked", () =>
		expect(nextTab(input({ derived: dev(500), tab: "preview", engaged: false }))).toBe("progress"));
	it("not engaged with an empty Progress: the Preview tab", () =>
		expect(nextTab(input({ derived: dev(500), tab: "progress", hasProgress: false, engaged: false }))).toBe("preview"));
	it("a fresh arrival takes the tab even before it marks the session engaged", () =>
		expect(nextTab(input({ derived: dev(500), arrived: true, engaged: false }))).toBe("preview"));
});

describe("shellAttrs", () => {
	const base = { tab: "preview" as const, preview: dev(1), finePointer: true, size: "half" as const, engaged: true };
	it("panel mode docks the aside and sizes it", () =>
		expect(shellAttrs({ ...base, mode: "panel" })).toEqual({ resizable: true, dockAside: true, asideFullscreen: false, asideSize: "half" }));
	it("600-899 is a full-screen drawer, not docked, not resizable", () =>
		expect(shellAttrs({ ...base, mode: "fullscreen" })).toEqual({ resizable: false, dockAside: false, asideFullscreen: true, asideSize: "half" }));
	it("a phone is neither", () => expect(shellAttrs({ ...base, mode: "card" })).toEqual({ resizable: false, dockAside: false, asideFullscreen: false, asideSize: "half" }));
	it("resizable only with a fine pointer", () => expect(shellAttrs({ ...base, mode: "panel", finePointer: false }).resizable).toBe(false));
	it("the Progress tab keeps today's aside: default size, no forced dock", () =>
		expect(shellAttrs({ ...base, tab: "progress", mode: "panel" })).toEqual({ resizable: true, dockAside: false, asideFullscreen: false, asideSize: "default" }));
	it("not engaged: the Preview tab does not dock the aside (a reopened chat's empty Progress shows the preview undocked)", () =>
		expect(shellAttrs({ ...base, mode: "panel", engaged: false }).dockAside).toBe(false));
	it("no preview: no dock, no fullscreen", () => {
		expect(shellAttrs({ ...base, preview: null, mode: "panel" }).dockAside).toBe(false);
		expect(shellAttrs({ ...base, preview: null, mode: "fullscreen" }).asideFullscreen).toBe(false);
	});
});

describe("snapSize", () => {
	it("cycles narrow, half, full on a wide screen", () => expect((["default", "half", "full"] as const).map((s) => snapSize(s, 1400))).toEqual(["half", "full", "default"]));
	it("cycles half and full below 1200 (iPad)", () => expect((["default", "half", "full"] as const).map((s) => snapSize(s, 1100))).toEqual(["half", "full", "half"]));
});
