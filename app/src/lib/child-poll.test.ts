import { describe, expect, it } from "vitest";
import { childThreadPolls } from "./child-poll.ts";

describe("childThreadPolls", () => {
	it("retries after an error (nothing loaded) only while the parent is live", () => {
		expect(childThreadPolls(true, null)).toBe(true);
		expect(childThreadPolls(false, null)).toBe(false);
	});

	it("keeps going while the child runs or is unknown, stops when it is terminal", () => {
		expect(childThreadPolls(true, { state: "running" })).toBe(true);
		expect(childThreadPolls(true, { state: "unknown" })).toBe(true);
		for (const state of ["done", "failed", "stopped"] as const) expect(childThreadPolls(true, { state })).toBe(false);
	});

	it("never polls when the parent isn't live", () => {
		for (const state of ["running", "unknown", "done"] as const) expect(childThreadPolls(false, { state })).toBe(false);
	});
});
