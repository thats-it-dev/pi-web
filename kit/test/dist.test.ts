import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const read = (f: string) => readFileSync(join(dist, f), "utf8");

describe.skipIf(!existsSync(dist))("kit dist (run `npm run build -w kit` first; skipped when dist/ is missing)", () => {
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
	it("_headers allows cross-origin use", () => {
		expect(read("_headers")).toMatch(/^\/\*\n\s+Access-Control-Allow-Origin: \*/);
	});
	it("api.json lists the core exports", () => {
		const { exports } = JSON.parse(read("api.json"));
		for (const name of ["sharedStyles", "toast", "trackViewport"]) expect(exports).toContain(name);
	});
});
