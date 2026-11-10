import { describe, expect, it } from "vitest";
import { isDocked, modeFor, panelsState, readHidden, writeHidden } from "./panels.ts";

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
