import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const read = (f: string) => readFileSync(join(dist, f), "utf8");

// Locally the suite skips without a build; in CI a missing dist/ must fail, not skip.
describe.skipIf(!existsSync(dist) && !process.env.CI)("kit dist (run `npm run build -w kit` first; skipped when dist/ is missing)", () => {
	it("has every published file", () => {
		for (const f of ["kit.js", "lit.js", "kit.css", "kit.d.ts", "theme-init.js", "api.json", "_headers", "fonts/Inter.ttf"]) {
			expect(existsSync(join(dist, f)), f).toBe(true);
		}
	});
	it("kit.js imports only ./lit.js", () => {
		const specs = [...read("kit.js").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
		expect(specs.length).toBeGreaterThan(0);
		expect(new Set(specs)).toEqual(new Set(["./lit.js"]));
	});
	it("keeps Lit only in lit.js", () => {
		// Lit sets these globals at load and they survive minification
		for (const marker of ["litHtmlVersions", "reactiveElementVersions"]) {
			expect(read("kit.js"), marker).not.toContain(marker);
			expect(read("lit.js"), marker).toContain(marker);
		}
	});
	it("kit.css is self-contained", () => {
		const css = read("kit.css");
		expect(css).not.toContain("@import");
		expect(css).toMatch(/--primary\s*:/);
		expect(css).toMatch(/--panel\s*:/);
	});
	it("kit.css defines the chart palette", () => {
		const css = read("kit.css");
		const light = ["#e69500", "#006eb8", "#00978d", "#8a2f7a"];
		const dark = ["#ffaa00", "#5aa6e6", "#3cc9a8", "#b85aa6"];
		light.forEach((hex, i) => expect(css).toMatch(new RegExp(`--chart-${i + 1}\\s*:\\s*${hex}`)));
		// Once in the prefers-color-scheme block, once in :root[data-theme="dark"].
		dark.forEach((hex, i) => expect(css.split(`--chart-${i + 1}: ${hex}`).length - 1).toBe(2));
	});
	it("_headers allows cross-origin use", () => {
		expect(read("_headers")).toMatch(/^\/\*\n\s+Access-Control-Allow-Origin: \*/);
	});
	it("_headers serves type declarations as text", () => {
		expect(read("_headers")).toMatch(/^\/kit\.d\.ts\n\s+Content-Type: text\/plain/m);
	});
	it("api.json lists the core exports", () => {
		const { exports } = JSON.parse(read("api.json"));
		for (const name of ["sharedStyles", "toast", "trackViewport"]) expect(exports).toContain(name);
	});
	it("api.json lists the side panel API", () => {
		const { attributes, events } = JSON.parse(read("api.json"));
		for (const a of ["tk-shell:aside-label", "tk-shell:store-key", "tk-shell:aside-hidden", "tk-header:aside-label", "tk-header:aside-badge"]) expect(attributes).toContain(a);
		for (const e of ["tk-panel-change", "tk-toggle-panel", "tk-show-panel", "tk-hide-panel", "tk-sheet-toggle"]) expect(events).toContain(e);
	});
});
