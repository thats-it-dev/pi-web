import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApiSurface, collectSurface, diffSurface, eventNames, litAttributes, shadowCssProps } from "./surface.ts";

const base: ApiSurface = {
	exports: ["sharedStyles", "toast"],
	elements: ["tk-button"],
	cssProps: ["--panel", "--primary"],
	events: ["tk-toast"],
	attributes: ["tk-sheet:open"],
	files: ["kit.js", "lit.js"],
};

describe("diffSurface", () => {
	it("is empty for identical surfaces", () => {
		expect(diffSurface(base, structuredClone(base))).toEqual([]);
	});
	it("names a removed export", () => {
		expect(diffSurface(base, { ...base, exports: ["sharedStyles"] })).toEqual(["exports:toast"]);
	});
	it("ignores additions", () => {
		expect(diffSurface(base, { ...base, elements: ["tk-button", "tk-card"] })).toEqual([]);
	});
	it("names a removed css property", () => {
		expect(diffSurface(base, { ...base, cssProps: ["--primary"] })).toEqual(["cssProps:--panel"]);
	});
});

describe("diffSurface with new fields", () => {
	it("names a removed event and attribute", () => {
		expect(diffSurface(base, { ...base, events: [], attributes: [] })).toEqual(["events:tk-toast", "attributes:tk-sheet:open"]);
	});
	it("treats a field missing from an older api.json as empty", () => {
		const { events: _e, attributes: _a, ...old } = base;
		expect(diffSurface(old as ApiSurface, base)).toEqual([]);
	});
});

describe("source scanners", () => {
	it("finds CustomEvent literals and TOAST_EVENT", () => {
		const src = [`export const TOAST_EVENT = "tk-toast";`, `this.dispatchEvent(new CustomEvent("tk-close", { bubbles: true }));`, `new CustomEvent<ToastDetail>(TOAST_EVENT, {})`];
		expect(eventNames(src).sort()).toEqual(["tk-close", "tk-toast"]);
	});
	it("finds public shadow css props", () => {
		expect(shadowCssProps(["a { bottom: var(--tk-toast-bottom, 4px); color: var(--text); }"])).toEqual(["--tk-toast-bottom"]);
	});
	it("lists attributes, honouring attribute names, state and attribute:false", () => {
		const src = `class X { static properties = { open: { type: Boolean, reflect: true }, menuLabel: { attribute: "menu-label" }, items: { state: true }, navOpen: { type: Boolean, attribute: false } }; }
customElements.define("tk-x", X);`;
		expect(litAttributes(src)).toEqual(["tk-x:open", "tk-x:menu-label"]);
	});
});

describe("collectSurface on the real build", () => {
	const dist = join(fileURLToPath(import.meta.url), "..", "..", "dist");
	it.skipIf(!existsSync(dist) && !process.env.CI)("lists only public entry points", async () => {
		const s = await collectSurface(dist);
		for (const f of s.files) {
			expect(["kit.js", "lit.js", "kit.css", "kit.d.ts", "theme-init.js", "api.json"].includes(f) || f.startsWith("fonts/"), f).toBe(true);
		}
		expect(s.files).not.toContain("index.html");
		expect(s.files).not.toContain("_headers");
		expect(s.attributes).toContain("tk-sheet:open");
		expect(s.events).toEqual(expect.arrayContaining(["tk-toast", "tk-close", "tk-open-nav"]));
	});
});
