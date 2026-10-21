import { describe, expect, it } from "vitest";
import { type ApiSurface, diffSurface } from "./surface.ts";

const base: ApiSurface = {
	exports: ["sharedStyles", "toast"],
	elements: ["tk-button"],
	cssProps: ["--panel", "--primary"],
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
