import { describe, expect, it } from "vitest";
import { ASIDE_DEFAULT_W, ASIDE_MIN_W, CHAT_FLOOR, MAIN_STRIP, SIDEBAR_W, asideWidthFor, clampAsideWidth, isDocked, modeFor, navFits, panelsState, readAsideWidth, readHidden, writeAsideWidth, writeHidden } from "./panels.ts";

describe("panels", () => {
	it("modeFor uses 899 and 1200", () => {
		expect([modeFor(320), modeFor(899), modeFor(900), modeFor(1199), modeFor(1200)]).toEqual(["phone", "phone", "mid", "mid", "wide"]);
	});
	it("nav docks from 900; details docks from 1200, or from 900 when there is no nav", () => {
		const both = { nav: true, aside: true };
		const asideOnly = { nav: false, aside: true };
		expect(isDocked("nav", "phone", both)).toBe(false);
		expect(isDocked("nav", "mid", both)).toBe(true);
		expect(isDocked("aside", "mid", both)).toBe(false);
		expect(isDocked("aside", "wide", both)).toBe(true);
		expect(isDocked("aside", "mid", asideOnly)).toBe(true);
		expect(isDocked("aside", "phone", asideOnly)).toBe(false);
	});
	it("readHidden keeps booleans it knows and falls back on anything else", () => {
		const fb = { nav: false, aside: true };
		expect(readHidden('{"nav":true}', fb)).toEqual({ nav: true, aside: true });
		expect(readHidden('{"nav":"yes","aside":false}', fb)).toEqual({ nav: false, aside: false });
		for (const junk of [null, "", "1", "x{", "[]", "null", '"s"']) expect(readHidden(junk, fb)).toEqual(fb);
		expect(readHidden(writeHidden({ nav: true, aside: false }), fb)).toEqual({ nav: true, aside: false });
	});
	it("panelsState: open means a visible column, or the one open drawer", () => {
		const s = panelsState({ mode: "mid", present: { nav: true, aside: true }, hidden: { nav: false, aside: false }, drawer: "aside" });
		expect(s).toEqual({ nav: { present: true, docked: true, open: true }, aside: { present: true, docked: false, open: true } });
		const h = panelsState({ mode: "wide", present: { nav: true, aside: false }, hidden: { nav: true, aside: false }, drawer: null });
		expect(h).toEqual({ nav: { present: true, docked: true, open: false }, aside: { present: false, docked: false, open: false } });
	});
});

describe("aside widths", () => {
	it("constants", () => {
		expect([SIDEBAR_W, ASIDE_DEFAULT_W, ASIDE_MIN_W, CHAT_FLOOR, MAIN_STRIP]).toEqual([280, 300, 240, 360, 48]);
	});
	it("clampAsideWidth keeps the chat floor beside a docked nav", () => {
		expect(clampAsideWidth(900, { total: 1100, navDocked: true })).toBe(1100 - 280 - 360);
		expect(clampAsideWidth(900, { total: 1100, navDocked: false })).toBe(1100 - 360);
		expect(clampAsideWidth(100, { total: 1600, navDocked: true })).toBe(ASIDE_MIN_W);
		expect(clampAsideWidth(420, { total: 1600, navDocked: true })).toBe(420);
	});
	it("asideWidthFor: default is the stored width or 300, half splits the space, full leaves the strip", () => {
		expect(asideWidthFor("default", { total: 1600, navDocked: true, stored: null })).toBe(300);
		expect(asideWidthFor("default", { total: 1600, navDocked: true, stored: 500 })).toBe(500);
		expect(asideWidthFor("default", { total: 1000, navDocked: true, stored: 900 })).toBe(1000 - 280 - 360);
		expect(asideWidthFor("half", { total: 1600, navDocked: true, stored: null })).toBe(660);
		expect(asideWidthFor("half", { total: 1600, navDocked: false, stored: null })).toBe(800);
		expect(asideWidthFor("full", { total: 1600, navDocked: true, stored: null })).toBe(1600 - 280 - 48);
		expect(asideWidthFor("full", { total: 1600, navDocked: false, stored: 300 })).toBe(1600 - 48);
	});
	it("navFits: 280 + aside + 360 must fit", () => {
		expect(navFits({ total: 900, asideW: 300 })).toBe(false);
		expect(navFits({ total: 940, asideW: 300 })).toBe(true);
		expect(navFits({ total: 1199, asideW: 559 })).toBe(true);
		expect(navFits({ total: 1199, asideW: 560 })).toBe(false);
	});
	it("isDocked with dockAside: the aside docks in mid mode and the nav un-docks when it no longer fits", () => {
		const both = { nav: true, aside: true };
		expect(isDocked("aside", "mid", both, { dockAside: true })).toBe(true);
		expect(isDocked("aside", "phone", both, { dockAside: true })).toBe(false);
		expect(isDocked("nav", "mid", both, { dockAside: true, total: 900, asideW: 300 })).toBe(false);
		expect(isDocked("nav", "mid", both, { dockAside: true, total: 1000, asideW: 300 })).toBe(true);
		expect(isDocked("nav", "mid", both, { total: 900, asideW: 300 })).toBe(true); // without dockAside the aside is a drawer, so the nav always fits
		expect(isDocked("nav", "wide", both, { dockAside: true, total: 1200, asideW: 600 })).toBe(false);
	});
	it("readAsideWidth accepts a stored integer in range and nothing else", () => {
		expect(readAsideWidth("420")).toBe(420);
		expect(readAsideWidth(writeAsideWidth(512))).toBe(512);
		for (const junk of [null, "", "abc", "-5", "1e9", "239", "10001", "{}", "300.5"]) expect(readAsideWidth(junk)).toBe(null);
	});
	it("panelsState passes dockAside through", () => {
		const s = panelsState({ mode: "mid", present: { nav: true, aside: true }, hidden: { nav: false, aside: false }, drawer: null, dockAside: true, total: 900, asideW: 300 });
		expect(s.aside).toEqual({ present: true, docked: true, open: true });
		expect(s.nav).toEqual({ present: true, docked: false, open: false });
	});
});
