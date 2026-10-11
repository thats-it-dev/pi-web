import { describe, expect, it } from "vitest";
import { defaultHubUrl, normalizeHubUrl } from "./settings.ts";

describe("normalizeHubUrl", () => {
	it("adds https and drops paths", () => {
		expect(normalizeHubUrl("spark-713a.tail9274fa.ts.net:7878")).toBe("https://spark-713a.tail9274fa.ts.net:7878");
		expect(normalizeHubUrl(" https://spark-713a.tail9274fa.ts.net:7878/api/ ")).toBe("https://spark-713a.tail9274fa.ts.net:7878");
		expect(normalizeHubUrl("http://localhost:5173")).toBe("http://localhost:5173");
	});
	it("rejects junk", () => {
		expect(() => normalizeHubUrl("not a url at all")).toThrow();
	});
});

describe("defaultHubUrl", () => {
	it("uses the dev server's own origin on localhost only", () => {
		expect(defaultHubUrl({ hostname: "localhost", origin: "http://localhost:5173" })).toBe("http://localhost:5173");
		expect(defaultHubUrl({ hostname: "pi.thatsit.dev", origin: "https://pi.thatsit.dev" })).toBe(null);
	});
});
