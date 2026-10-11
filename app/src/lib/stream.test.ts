import { describe, expect, it } from "vitest";
import { type EventSourceLike, openStream } from "./stream.ts";

class FakeES implements EventSourceLike {
	static all: FakeES[] = [];
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	closed = false;
	url: string;
	constructor(url: string) {
		this.url = url;
		FakeES.all.push(this);
	}
	close() {
		this.closed = true;
	}
}

describe("openStream", () => {
	it("parses messages, reconnects with backoff, and resets after a good connection", () => {
		FakeES.all = [];
		const delays: number[] = [];
		const pending: Array<() => void> = [];
		const schedule = ((fn: () => void, ms: number) => {
			delays.push(ms);
			pending.push(fn);
			return 0;
		}) as unknown as typeof setTimeout;
		const got: unknown[] = [];
		const statuses: string[] = [];
		const s = openStream("u", (m) => got.push(m), (st) => statuses.push(st), FakeES, schedule);
		FakeES.all[0].onopen?.(new Event("open"));
		FakeES.all[0].onmessage?.({ data: '{"type":"detached"}' } as MessageEvent);
		FakeES.all[0].onmessage?.({ data: "not json" } as MessageEvent);
		expect(got).toEqual([{ type: "detached" }]);
		FakeES.all[0].onerror?.(new Event("error"));
		pending.shift()?.();
		FakeES.all[1].onerror?.(new Event("error"));
		pending.shift()?.();
		FakeES.all[2].onopen?.(new Event("open"));
		FakeES.all[2].onerror?.(new Event("error"));
		expect(delays).toEqual([1000, 2000, 1000]);
		expect(statuses).toEqual(["connecting", "open", "reconnecting", "reconnecting", "open", "reconnecting"]);
		expect(FakeES.all[0].closed).toBe(true);
		s.close();
		expect(FakeES.all.at(-1)?.closed).toBe(true);
	});
});
