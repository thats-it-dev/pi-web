import { describe, expect, it } from "vitest";
import { checkApi } from "./check-api.ts";

const surface = { exports: ["toast"], elements: [], cssProps: [], files: ["kit.js"] };
const respond = (status: number, body?: unknown) => async () =>
	new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("checkApi", () => {
	it("treats 404 as a first deploy", async () => {
		const r = await checkApi("https://x", respond(404), surface);
		expect(r.ok).toBe(true);
		expect(r.message).toContain("first deploy");
	});
	it("fails on 503", async () => {
		expect((await checkApi("https://x", respond(503), surface)).ok).toBe(false);
	});
	it("fails on a network error", async () => {
		const boom = async () => {
			throw new Error("offline");
		};
		expect((await checkApi("https://x", boom, surface)).ok).toBe(false);
	});
	it("fails and names a removal", async () => {
		const prev = { ...surface, exports: ["toast", "gone"] };
		const r = await checkApi("https://x", respond(200, prev), surface);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("exports:gone");
	});
	it("passes when nothing was removed", async () => {
		expect((await checkApi("https://x", respond(200, surface), surface)).ok).toBe(true);
	});
});
