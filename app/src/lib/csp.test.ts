import { describe, expect, it } from "vitest";
import { CSP } from "./csp";

describe("CSP", () => {
	it("lets the app reach a tailnet hub on a non-default port", () => {
		const connect = CSP.split("; ").find((d) => d.startsWith("connect-src "));
		expect(connect?.split(" ")).toContain("https://*.ts.net:*");
	});
});
