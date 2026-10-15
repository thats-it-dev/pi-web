import { afterEach, describe, expect, it, vi } from "vitest";
import { HubApi, HubError } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("HubApi", () => {
	it("calls the hub with JSON and returns the body", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { ok: true }, sessionId: "s1" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const api = new HubApi("https://spark-713a.tail9274fa.ts.net:7878/");
		const r = await api.command("s1", { type: "abort" });
		expect(r).toEqual({ result: { ok: true }, sessionId: "s1" });
		expect(fetchMock).toHaveBeenCalledWith("https://spark-713a.tail9274fa.ts.net:7878/api/sessions/s1/commands", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"type":"abort"}',
		});
		expect(api.streamUrl("a b")).toBe("https://spark-713a.tail9274fa.ts.net:7878/api/sessions/a%20b/stream");
	});
	it("searches a session's files with the query escaped", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ files: [{ path: "a b.ts", dir: false }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const ctl = new AbortController();
		expect(await new HubApi("http://x").files("s1", "a b", ctl.signal)).toEqual({ files: [{ path: "a b.ts", dir: false }] });
		expect(fetchMock).toHaveBeenCalledWith("http://x/api/sessions/s1/files?q=a%20b", { method: "GET", signal: ctl.signal });
	});
	it("turns hub errors into HubError with the hub's message", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "6 pi sessions are already running. Close one first." }), { status: 503 })));
		await expect(new HubApi("http://x").createSession("~")).rejects.toMatchObject({ status: 503, message: "6 pi sessions are already running. Close one first." });
	});
	it("explains network failures", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
		const err = await new HubApi("http://x").sessions().catch((e) => e);
		expect(err).toBeInstanceOf(HubError);
		expect(err.status).toBe(0);
		expect(err.message).toBe("Can't reach the hub. Is Tailscale connected?");
	});
});
