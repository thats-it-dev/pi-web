import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute } from "./route.ts";

describe("routes", () => {
	it("parses hashes", () => {
		expect(parseRoute("")).toEqual({ name: "home" });
		expect(parseRoute("#/s/01a113f5-669d")).toEqual({ name: "session", id: "01a113f5-669d" });
		expect(parseRoute("#/new?cwd=%2Fhome%2Fmichael")).toEqual({ name: "new" });
		expect(parseRoute("#/new")).toEqual({ name: "new" });
		expect(parseRoute("#/settings")).toEqual({ name: "settings" });
		expect(parseRoute("#/whatever")).toEqual({ name: "home" });
	});
	it("ignores a cwd query on the new-chat route", () => {
		expect(parseRoute("#/new?cwd=/x")).toEqual({ name: "new" });
		expect(hrefFor({ name: "new" })).toBe("#/new");
	});
	it("round-trips", () => {
		for (const r of [{ name: "home" }, { name: "session", id: "abc" }, { name: "new" }, { name: "settings" }] as const) {
			expect(parseRoute(hrefFor(r))).toEqual(r);
		}
	});
});
