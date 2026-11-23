import { describe, expect, it } from "vitest";
import { CSP } from "./csp";

describe("CSP", () => {
	it("lets the app reach a tailnet hub on a non-default port", () => {
		const connect = CSP.split("; ").find((d) => d.startsWith("connect-src "));
		expect(connect?.split(" ")).toContain("https://*.ts.net:*");
	});

	it("allows preview frames from tailnet, Pages and thatsit.app", () => {
		expect(CSP).toContain("frame-src https://*.ts.net:* https://*.pages.dev https://*.thatsit.app");
		expect(CSP.startsWith("default-src 'self'")).toBe(true);
	});
});
