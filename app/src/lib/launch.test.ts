import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/src/protocol.ts";
import { RECENT_MS, launchRoute } from "./launch.ts";

const now = 1_000_000_000_000;
const s = (id: string, updatedAt: number, live = false, type: "code" | "chat" = "code") => ({ id, updatedAt, live, type }) as SessionSummary;

describe("launchRoute", () => {
	it("reopens the latest session updated within 2 hours", () => {
		expect(launchRoute([s("a", now - 5000), s("b", now - 1000)], now, "code")).toEqual({ name: "session", id: "b" });
	});
	it("opens a new chat when the latest is older than 2 hours", () => {
		expect(launchRoute([s("a", now - RECENT_MS - 1)], now, "code")).toEqual({ name: "new" });
	});
	it("a live session counts however old", () => {
		expect(launchRoute([s("a", now - RECENT_MS * 10, true), s("b", now - 1000)], now, "code")).toEqual({ name: "session", id: "a" });
	});
	it("no sessions → new chat", () => {
		expect(launchRoute([], now, "code")).toEqual({ name: "new" });
	});
	it("type chat ignores a live code session and opens a new chat", () => {
		expect(launchRoute([s("a", now - 1000, true, "code")], now, "chat")).toEqual({ name: "new" });
	});
	it("type chat reopens a recent chat over a newer code session", () => {
		expect(launchRoute([s("a", now - 5000, false, "chat"), s("b", now - 1000, true, "code")], now, "chat")).toEqual({ name: "session", id: "a" });
	});
	it("type code behaves as before on a mixed list", () => {
		expect(launchRoute([s("a", now - 1000, true, "chat"), s("b", now - 5000, false, "code")], now, "code")).toEqual({ name: "session", id: "b" });
	});
});
