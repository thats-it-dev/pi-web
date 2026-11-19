import { describe, expect, it } from "vitest";
import { swallowed } from "./prompt-result.ts";

describe("swallowed", () => {
	it("is a message pi handled at once without starting a run", () => {
		expect(swallowed("fix the ladder", { ok: true, data: { disposition: "handled" } })).toBe(true);
	});
	it("is not a slash command, a started or queued prompt, a pending one, or a failure", () => {
		expect(swallowed("/superpowers on", { ok: true, data: { disposition: "handled" } })).toBe(false);
		expect(swallowed("  /skill:grill-me", { ok: true, data: { disposition: "handled" } })).toBe(false);
		expect(swallowed("fix it", { ok: true, data: { disposition: "started" } })).toBe(false);
		expect(swallowed("fix it", { ok: true, data: { disposition: "queued" } })).toBe(false);
		expect(swallowed("fix it", { ok: true, pending: true })).toBe(false);
		expect(swallowed("fix it", { ok: false, error: "nope" })).toBe(false);
		expect(swallowed("fix it", null)).toBe(false);
		expect(swallowed("fix it", { ok: true })).toBe(false);
	});
});
