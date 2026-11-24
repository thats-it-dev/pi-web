import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "../../../shared/src/protocol.ts";
import { HubError } from "./api.ts";
import { SearchStore, errorMessage } from "./search-store.ts";

const resp = (n: number): SearchResponse => ({
	semantic: false,
	hits: [{ sessionId: `s${n}`, type: "code", name: null, firstPrompt: "p", cwd: "/x", updatedAt: 1, ordinal: n, role: "user", snippet: "s", terms: ["s"], semanticOnly: false }],
});

function setup(search: (q: string, l: number, s?: AbortSignal) => Promise<SearchResponse> = vi.fn(async () => resp(1))) {
	vi.useFakeTimers();
	const store = new SearchStore({ api: { search }, setTimeout: setTimeout as never, clearTimeout: clearTimeout as never });
	return { store, search };
}
afterEach(() => vi.useRealTimers());

describe("SearchStore", () => {
	it("debounces and fires once after 300 ms", async () => {
		const search = vi.fn(async (_q: string, _l: number, _s?: AbortSignal) => resp(1));
		const { store } = setup(search);
		store.setQuery("re");
		store.setQuery("res");
		expect(store.state).toEqual({ status: "searching", query: "res" });
		vi.advanceTimersByTime(299);
		expect(search).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(search).toHaveBeenCalledTimes(1);
		expect(search.mock.calls[0].slice(0, 2)).toEqual(["res", 8]);
		expect(store.state.status).toBe("done");
	});
	it("store: a short query after a long one cancels and clears", async () => {
		const search = vi.fn(async (_q: string, _l: number, _s?: AbortSignal) => resp(1));
		const { store } = setup(search);
		store.setQuery("restart");
		store.setQuery(" r ");
		expect(store.state).toEqual({ status: "idle" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(search).not.toHaveBeenCalled();
	});
	it("aborts the older request and ignores its late result", async () => {
		const resolvers: Array<(r: SearchResponse) => void> = [];
		const signals: AbortSignal[] = [];
		const { store } = setup((_q, _l, signal) => {
			signals.push(signal!);
			return new Promise<SearchResponse>((r) => resolvers.push(r));
		});
		store.setQuery("aa");
		await vi.advanceTimersByTimeAsync(300);
		store.setQuery("bb");
		expect(signals[0].aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(300);
		resolvers[1](resp(2));
		await vi.advanceTimersByTimeAsync(0);
		resolvers[0](resp(1));
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state).toMatchObject({ status: "done", query: "bb" });
		expect((store.state as { hits: { ordinal: number }[] }).hits[0].ordinal).toBe(2);
	});
	it("maps 404 to the unsupported message and emits change", async () => {
		const { store } = setup(async () => {
			throw new HubError(404, "nope");
		});
		const changes = vi.fn();
		store.addEventListener("change", changes);
		store.setQuery("zz");
		await vi.advanceTimersByTimeAsync(300);
		expect(store.state).toEqual({ status: "error", query: "zz", message: "Search isn't available on this hub." });
		expect(changes).toHaveBeenCalled();
	});
	it("clear goes idle and aborts", async () => {
		const signals: AbortSignal[] = [];
		const { store } = setup((_q, _l, s) => {
			signals.push(s!);
			return new Promise<SearchResponse>(() => {});
		});
		store.setQuery("aa");
		await vi.advanceTimersByTimeAsync(300);
		store.clear();
		expect(signals[0].aborted).toBe(true);
		expect(store.state).toEqual({ status: "idle" });
	});
});

describe("errorMessage", () => {
	it("maps errors", () => {
		expect(errorMessage(new HubError(0, "x"))).toBe("Can't reach the hub.");
		expect(errorMessage(new HubError(500, "x"))).toBe("Search failed.");
		expect(errorMessage(new Error("x"))).toBe("Search failed.");
	});
});
