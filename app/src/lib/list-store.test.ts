import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListMessage, SessionSummary } from "../../../shared/src/protocol.ts";
import { ListStore } from "./list-store.ts";

const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
	id, cwd: "/w", name: null, firstPrompt: id, userMessages: 1, model: null, contextTokens: null,
	createdAt: 0, updatedAt: 0, parentSession: null, live: false, handleKind: null, state: "idle", ...over,
});

beforeEach(() => {
	const mem = new Map<string, string>();
	vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

describe("ListStore", () => {
	it("loads, applies live state, and refetches when a run finishes", async () => {
		let list = [s("a"), s("b")];
		const api = { sessions: vi.fn(async () => ({ sessions: list, home: "/home/m" })), eventsUrl: () => "events" };
		let push: (m: ListMessage) => void = () => {};
		const open = vi.fn((_url: string, onMessage: (m: ListMessage) => void) => {
			push = onMessage;
			return { close() {} };
		});
		const store = new ListStore(api, open as never);
		store.start();
		await vi.waitFor(() => expect(store.loaded).toBe(true));
		expect(store.sessions.map((x) => x.id)).toEqual(["a", "b"]);
		push({ type: "session_state", sessionId: "a", live: true, handleKind: "rpc", state: "running" });
		expect(store.sessions[0]).toMatchObject({ live: true, state: "running" });
		list = [s("a", { name: "renamed after run" }), s("b")];
		push({ type: "session_state", sessionId: "a", live: true, handleKind: "rpc", state: "idle" });
		await vi.waitFor(() => expect(store.sessions[0].name).toBe("renamed after run"));
		store.stop();
	});
	it("keeps the last list and reports the error when the hub is unreachable", async () => {
		const api = { sessions: vi.fn(async () => { throw new Error("Can't reach the hub. Is Tailscale connected?"); }), eventsUrl: () => "events" };
		const store = new ListStore(api, (() => ({ close() {} })) as never);
		await store.refresh();
		expect(store.error).toBe("Can't reach the hub. Is Tailscale connected?");
		expect(store.loaded).toBe(true);
	});
	it("applies only the latest refresh when responses arrive out of order", async () => {
		const resolvers: Array<(v: { sessions: SessionSummary[]; home: string }) => void> = [];
		const api = { sessions: vi.fn(() => new Promise<{ sessions: SessionSummary[]; home: string }>((r) => resolvers.push(r))), eventsUrl: () => "events" };
		const store = new ListStore(api, (() => ({ close() {} })) as never);
		const first = store.refresh();
		const second = store.refresh();
		resolvers[1]({ sessions: [s("new")], home: "/h" });
		await second;
		resolvers[0]({ sessions: [s("old")], home: "/h" });
		await first;
		expect(store.sessions.map((x) => x.id)).toEqual(["new"]);
	});
	it("refreshes when the events stream reconnects, but not on the first open", async () => {
		const api = { sessions: vi.fn(async () => ({ sessions: [s("a")], home: "/h" })), eventsUrl: () => "events" };
		let status: (st: string) => void = () => {};
		const open = vi.fn((_u: string, _m: unknown, onStatus: (st: string) => void) => {
			status = onStatus;
			return { close() {} };
		});
		const store = new ListStore(api, open as never);
		store.start();
		await vi.waitFor(() => expect(store.loaded).toBe(true));
		status("connecting");
		status("open");
		expect(api.sessions).toHaveBeenCalledTimes(1);
		status("reconnecting");
		status("open");
		await vi.waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
		store.stop();
	});
	it("holds the events stream only while the app is visible, so the hub knows not to push", async () => {
		const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
		vi.stubGlobal("document", doc);
		const api = { sessions: vi.fn(async () => ({ sessions: [s("a")], home: "/h" })), eventsUrl: () => "events" };
		const streams: Array<{ closed: boolean }> = [];
		const open = vi.fn(() => {
			const st = { closed: false };
			streams.push(st);
			return { close: () => void (st.closed = true) };
		});
		const store = new ListStore(api, open as never);
		store.start();
		await vi.waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(1));
		expect(streams).toHaveLength(1);

		doc.visibilityState = "hidden";
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(streams[0].closed).toBe(true);

		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(streams).toHaveLength(2);
		expect(streams[1].closed).toBe(false);
		await vi.waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2)); // catches up on what it missed
		doc.dispatchEvent(new Event("visibilitychange")); // visible again: no second stream
		expect(streams).toHaveLength(2);

		store.stop();
		expect(streams[1].closed).toBe(true);
	});
	it("doesn't open the events stream when it starts in the background", () => {
		vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden" }));
		const open = vi.fn(() => ({ close() {} }));
		const store = new ListStore({ sessions: vi.fn(async () => ({ sessions: [], home: "/h" })), eventsUrl: () => "events" }, open as never);
		store.start();
		expect(open).not.toHaveBeenCalled();
		store.stop();
	});
	it("keeps the old events stream until the replacement opens, and a second switch leaves only the latest", () => {
		const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
		vi.stubGlobal("document", doc);
		const api = { sessions: vi.fn(async () => ({ sessions: [s("a")], home: "/h" })), eventsUrl: (v?: string | null) => (v ? `events?viewing=${v}` : "events") };
		const urls: string[] = [];
		const closed: boolean[] = [];
		const status: Array<(st: string) => void> = [];
		const open = vi.fn((url: string, _m: unknown, onStatus: (st: string) => void) => {
			urls.push(url);
			status.push(onStatus);
			const i = closed.push(false) - 1;
			return { close: () => void (closed[i] = true) };
		});
		const store = new ListStore(api, open as never);
		store.start();
		status[0]("open");
		store.setViewing("s1");
		expect(urls).toEqual(["events", "events?viewing=s1"]);
		expect(closed).toEqual([false, false]); // old one still counted by the hub
		status[1]("open");
		expect(closed).toEqual([true, false]);

		store.setViewing("s1"); // same id: nothing
		expect(urls).toHaveLength(2);

		store.setViewing("s2");
		store.setViewing("s3"); // supersedes s2 before it opened
		expect(urls).toHaveLength(4);
		expect(closed).toEqual([true, false, true, false]);
		status[2]("open"); // late open from the superseded stream changes nothing
		expect(closed).toEqual([true, false, true, false]);
		status[3]("open");
		expect(closed).toEqual([true, true, true, false]);
		store.stop();
		expect(closed[3]).toBe(true);
	});
	it("opens nothing for setViewing while hidden, and the next visible open carries it", () => {
		const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
		vi.stubGlobal("document", doc);
		const api = { sessions: vi.fn(async () => ({ sessions: [s("a")], home: "/h" })), eventsUrl: (v?: string | null) => (v ? `events?viewing=${v}` : "events") };
		const urls: string[] = [];
		const open = vi.fn((url: string) => {
			urls.push(url);
			return { close() {} };
		});
		const store = new ListStore(api, open as never);
		store.start();
		doc.visibilityState = "hidden";
		doc.dispatchEvent(new Event("visibilitychange"));
		store.setViewing("s2");
		expect(urls).toEqual(["events"]);
		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(urls[1]).toBe("events?viewing=s2");
		store.stop();
	});
});
